// A deliberate, re-rendered cursor for takes whose frames are cursor-free.
//
// The pointer track (events.jsonl k:"ptr") is smoothed on the output clock,
// projected through the take's camera and drawn as a vector arrow at output
// resolution after the camera transform, so it glides with no tremor and stays
// crisp however far the camera zooms. Idle motion hides it after two seconds.
//
// It is used only when take.json says cursor_free, so takes with a baked system
// cursor render exactly as before.
import type { CameraDefaults } from "../camera/defaults.ts";
import type { CameraFrame } from "../camera/types.ts";
import type { Event } from "../types.ts";
import { assHeader, assTime, roundRect } from "./stage.ts";

/** Art in its own 24x32 box (headless-scene's arrow), hotspot at (2, 2). */
const ART: [number, number][] = [[2, 2], [2, 23], [7, 18.5], [10.5, 26.5], [14, 25], [10.5, 17.5], [17, 17.5]];
/** Arrow height at 1080p; a close-up grows it gently rather than obscuring the field. */
const REST_H = 48;
/** Idle seconds before the cursor begins to fade, and the fade length. */
const IDLE_START = 1.8;
const IDLE_FADE = 0.5;
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
  const raw = Array.from({ length: count }, (_, i) => at(i / fps));
  const window = Math.max(1, Math.round(0.12 * fps));
  const pos = raw.map((_, i) => {
    let sx = 0, sy = 0, n = 0;
    for (let j = i - window; j <= i + window; j++) {
      const p = raw[clamp(j, 0, count - 1)]!;
      const weight = 1 + Math.cos(Math.PI * (j - i) / (window + 1));
      sx += p.x * weight; sy += p.y * weight; n += weight;
    }
    return { x: sx / n, y: sy / n };
  });

  // Last frame the pointer was actually moving; jitter inside the smoothed
  // window reads as still, so a resting hand hides.
  // Frame 0 is the anchor: a pointer that has never moved is still visible until
  // two seconds of stillness pass, rather than being hidden from the first frame.
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
  for (let i = 0; i < count; i++) {
    const idle = (i - alive[i]!) / fps;
    const opacity = idle <= IDLE_START ? 1 : clamp(1 - (idle - IDLE_START) / IDLE_FADE, 0, 1);
    if (opacity <= 0.002) continue;
    const f = o.frames[Math.min(i, o.frames.length - 1)]!;
    const scale = REST_H / 24.5 * o.d.out_h / 1080 * Math.sqrt(maxW / f.w);
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
    const end = assTime((i + 1) / fps);
    body.push(`Dialogue: 1,${assTime(i / fps)},${end},Default,,0,0,0,,`
      + `{\\an7\\pos(0,0)\\p1${clip}\\bord${(1.5 * scale).toFixed(2)}\\3c${outline}\\3a&H${clear}&\\1c${fill}\\1a&H${clear}&\\shad0}${path}\n`);
  }
  if (body.length === 0) return "";
  return header + body.join("");
}
