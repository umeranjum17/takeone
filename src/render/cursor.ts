// A deliberate, re-rendered cursor for takes whose frames are cursor-free.
//
// The pointer track (events.jsonl k:"ptr") is smoothed on the output clock,
// projected through the take's camera and drawn as a vector arrow at output
// resolution after the camera transform, so it glides with no tremor and stays
// crisp however far the camera zooms. Every click lands the tip exactly on its
// ripple. `cursor_size`, `cursor_hide_idle_s` and `cursor_loop` size it, hide it
// after stillness and glide it home for a looping film.
//
// It is used only when take.json says cursor_free, so takes with a baked system
// cursor render exactly as before.
import type { CameraDefaults } from "../camera/defaults.ts";
import type { CameraFrame } from "../camera/types.ts";
import type { Event } from "../types.ts";
import { assHeader, assTime, roundRect } from "./stage.ts";

/** Art in its own 24x32 box (headless-scene's arrow), hotspot at (2, 2). */
const ART: [number, number][] = [[2, 2], [2, 23], [7, 18.5], [10.5, 26.5], [14, 25], [10.5, 17.5], [17, 17.5]];
/** Arrow height at 1080p and cursor_size 1; a close-up grows it gently rather than obscuring the field. */
const REST_H = 48;
/** Seconds the idle fade lasts once cursor_hide_idle_s of stillness has passed. */
const IDLE_FADE = 0.5;
/** Seconds either side of a click over which the cursor is drawn onto the click point. */
const PIN_S = 0.12;
/** Seconds the cursor_loop return glide takes at most. */
const LOOP_S = 0.8;
/** Source px of movement within a 0.2 s span that still counts as pointing. */
const MOVE_EPS = 1.5;

export interface PointerSample { t: number; x: number; y: number }

/** Raw pointer samples in video seconds (source px), dropping lost-pointer gaps. */
export function pointerSamples(events: Event[], videoStartMs: number): PointerSample[] {
  const out: PointerSample[] = [];
  for (const e of events) {
    if (e.k === "ptr" && Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.t)) {
      out.push({ t: (e.t - videoStartMs) / 1000, x: e.x, y: e.y });
    }
  }
  return out;
}

export interface CursorOptions {
  events: Event[];
  videoStartMs: number;
  trimStart: number;
  trimEnd: number;
  /** Video seconds -> output seconds (trim and idle squeezing applied). */
  outTime: (t: number) => number;
  /** The clicks the ripples are drawn at (beatClicks of the output beats): output seconds plus trimStart, source px. */
  clicks: { t: number; x: number; y: number }[];
  /** Camera frames in output-mapped coordinates: stageFrames (wide) or bandFrames (banded). */
  frames: CameraFrame[];
  d: CameraDefaults;
  duration: number;
  /** Source-space origin of the composited frame, matching keycap projection. */
  originX: number;
  originY: number;
  /** Fixed output px for a band; otherwise the screen's rectangle in stage px. */
  card: { x: number; y: number; w: number; h: number; radius: number; fixed: boolean };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Eases 0..1 in and out with zero velocity at both ends. */
const smoother = (u: number) => u * u * u * (u * (6 * u - 15) + 10);

/** The re-rendered cursor overlay in output resolution; empty when there is nothing to draw. */
export function cursorAss(o: CursorOptions): string {
  const samples = pointerSamples(o.events, o.videoStartMs);
  if (samples.length === 0 || o.frames.length === 0) return "";
  const fps = o.d.fps;

  // Output-clock samples, then a symmetric cosine window: eased arrivals and
  // departures without the lag of a trailing filter.
  const track = samples.map((s) => {
    const vt = clamp(s.t, o.trimStart, o.trimEnd);
    return { t: o.outTime(vt), x: s.x, y: s.y };
  }).sort((a, b) => a.t - b.t);
  const at = (t: number): { x: number; y: number } => {
    if (t <= track[0]!.t) return { x: track[0]!.x, y: track[0]!.y };
    const last = track[track.length - 1]!;
    if (t >= last.t) return { x: last.x, y: last.y };
    let lo = 0, hi = track.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (track[mid]!.t <= t) lo = mid; else hi = mid;
    }
    const a = track[lo]!, b = track[hi]!;
    const u = (t - a.t) / Math.max(1e-9, b.t - a.t);
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  };

  const count = Math.floor(o.duration * fps) + 1;
  // Smooth on one film clock so a 30 fps preview cannot blend an idle cut
  // differently from the 60 fps final at the same instant.
  const smoothFps = Math.max(60, fps);
  const smoothCount = Math.floor(o.duration * smoothFps) + 1;
  const raw = Array.from({ length: smoothCount }, (_, i) => at(i / smoothFps));
  const window = Math.max(1, Math.round(0.12 * smoothFps));
  const smoothed = raw.map((_, i) => {
    let sx = 0, sy = 0, n = 0;
    for (let j = i - window; j <= i + window; j++) {
      const p = raw[clamp(j, 0, smoothCount - 1)]!;
      const weight = 1 + Math.cos(Math.PI * (j - i) / (window + 1));
      sx += p.x * weight; sy += p.y * weight; n += weight;
    }
    return { x: sx / n, y: sy / n };
  });
  const pos = Array.from({ length: count }, (_, i) => smoothed[Math.min(smoothCount - 1, Math.round(i * smoothFps / fps))]!);
  // The window averages a click with the motion around it, so draw the cursor
  // onto each click ripple's centre, easing in and out over PIN_S (never past
  // a neighbouring click): the ripple and the arrow tip meet exactly.
  const clicks = o.clicks.map((c) => ({ ...c, t: c.t - o.trimStart })).sort((a, b) => a.t - b.t);
  clicks.forEach((c, k) => {
    const half = Math.max(2 / fps, Math.min(PIN_S, c.t - (clicks[k - 1]?.t ?? -Infinity), (clicks[k + 1]?.t ?? Infinity) - c.t));
    for (let i = Math.max(0, Math.ceil((c.t - half) * fps)); i < count && i / fps <= c.t + half; i++) {
      const gap = Math.abs(i / fps - c.t);
      // Pin for the same span of film time at both 60 fps and 30 fps preview.
      const core = 1 / 60;
      const w = gap <= core ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (gap - core) / (half - core));
      pos[i] = { x: pos[i]!.x + (c.x - pos[i]!.x) * w, y: pos[i]!.y + (c.y - pos[i]!.y) * w };
    }
  });

  // A looping film ends where it began: after the last click settles, glide
  // back to the first frame's position by the last frame.
  if (o.d.cursor_loop === 1 && count > 1) {
    const end = (count - 1) / fps;
    const start = clamp(end - LOOP_S, (clicks.at(-1)?.t ?? -Infinity) + PIN_S, end);
    const home = pos[0]!;
    for (let i = Math.ceil(start * fps); i < count; i++) {
      const u = end > start ? smoother(clamp((i / fps - start) / (end - start), 0, 1)) : 1;
      pos[i] = { x: pos[i]!.x + (home.x - pos[i]!.x) * u, y: pos[i]!.y + (home.y - pos[i]!.y) * u };
    }
  }

  // Last frame the pointer was actually moving; jitter inside the smoothed
  // window reads as still, so a resting hand hides.
  // Frame 0 is the anchor: a pointer that has never moved is still visible until
  // cursor_hide_idle_s of stillness pass, rather than being hidden from the first frame.
  const alive: number[] = new Array(count).fill(0);
  let lastMove = 0;
  for (let i = 0; i < count; i++) {
    const back = clamp(i - Math.round(0.2 * fps), 0, count - 1);
    const moved = Math.hypot(pos[i]!.x - pos[back]!.x, pos[i]!.y - pos[back]!.y) > MOVE_EPS;
    if (moved) lastMove = i;
    alive[i] = lastMove;
  }

  const maxW = Math.max(...o.frames.map((f) => f.w));
  const fill = "&H00FFFFFF&";
  const outline = "&H00282320&";
  let header = assHeader(o.d.out_w, o.d.out_h, o.d.caption_font, o.d.caption_size);
  const body: string[] = [];
  const hideAfter = o.d.cursor_hide_idle_s;
  for (let i = 0; i < count; i++) {
    const idle = (i - alive[i]!) / fps;
    const opacity = hideAfter === 0 || idle <= hideAfter ? 1 : clamp(1 - (idle - hideAfter) / IDLE_FADE, 0, 1);
    if (opacity <= 0.002) continue;
    // Camera frames run at the solve's rate, which a preview's output rate can differ from: look up by time.
    const step = o.frames.length > 1 ? o.frames[1]!.t - o.frames[0]!.t : 1 / fps;
    const f = o.frames[clamp(Math.round(i / fps / step), 0, o.frames.length - 1)]!;
    const scale = REST_H * o.d.cursor_size / 24.5 * o.d.out_h / 1080 * Math.sqrt(maxW / f.w);
    const ox = (pos[i]!.x + o.originX - f.x) * o.d.out_w / f.w;
    const oy = (pos[i]!.y + o.originY - f.y) * o.d.out_h / f.h;
    const c = o.card, kx = c.fixed ? 1 : o.d.out_w / f.w, ky = c.fixed ? 1 : o.d.out_h / f.h;
    const x = (c.x - (c.fixed ? 0 : f.x)) * kx, y = (c.y - (c.fixed ? 0 : f.y)) * ky;
    const w = c.w * kx, h = c.h * ky, r = c.radius * kx;
    const dx = Math.max(Math.abs(ox - x - w / 2) - (w / 2 - r), 0);
    const dy = Math.max(Math.abs(oy - y - h / 2) - (h / 2 - r), 0);
    // A pointer outside the shown screen is invisible, not floating over the
    // wallpaper. Clip the remaining arrow ink with the same rounded-card shape.
    if (Math.hypot(dx, dy) > r) continue;
    const clip = `\\clip(1,${roundRect(x, y, w, h, r)})`;
    const clear = Math.round((1 - opacity) * 255).toString(16).padStart(2, "0").toUpperCase();
    const path = ART.map(([px, py], k) =>
      `${k === 0 ? "m" : "l"} ${(ox + (px - 2) * scale).toFixed(1)} ${(oy + (py - 2) * scale).toFixed(1)}`).join(" ");
    // ffmpeg's ass filter samples each frame at its truncated millisecond and ASS times are
    // centiseconds, so a line on frame boundaries would show the previous
    // frame's arrow on every third 60 fps frame. Centre each line on its frame.
    body.push(`Dialogue: 1,${assTime((i - 0.5) / fps)},${assTime((i + 0.5) / fps)},Default,,0,0,0,,`
      + `{\\an7\\pos(0,0)\\p1${clip}\\bord${(1.5 * scale).toFixed(2)}\\3c${outline}\\3a&H${clear}&\\1c${fill}\\1a&H${clear}&\\shad0}${path}\n`);
  }
  if (body.length === 0) return "";
  return header + body.join("");
}
