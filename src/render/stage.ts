// The stage: the screen as a rounded card on a gradient, click ripples drawn in
// source space (so they zoom with the content) and captions drawn in output space.
// Everything here is local ffmpeg/libass work and costs zero tokens.
import type { CameraDefaults } from "../camera/defaults.ts";
import { zMax } from "../camera/solver.ts";
import type { Beat, CameraFrame, TakeMeta } from "../camera/types.ts";
import { shutterFrames, type shutterPlan } from "./motion-blur.ts";
import { SAFE_INSET } from "./safe-area.ts";
import type { PixelFrame } from "./frame-average.ts";

export interface Stage {
  w: number;
  h: number;
  /** Aspect-padded source canvas the solver frames (the source itself when it is 16:9). */
  baseW: number;
  baseH: number;
  /** Top-left of the source screen on the stage. */
  screenX: number;
  screenY: number;
  /** Output px per stage px at rest. */
  restScale: number;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const even = (value: number) => Math.ceil(value / 2) * 2;
const smooth = (u: number) => u * u * (3 - 2 * u);

export function stageGeometry(width: number, height: number, d: CameraDefaults): Stage {
  const aspect = d.out_w / d.out_h;
  const baseW = even(Math.max(width, height * aspect));
  const baseH = even(Math.max(height, width / aspect));
  const marginX = Math.round(baseW * d.stage_margin);
  const marginY = Math.round(baseH * d.stage_margin);
  const w = baseW + 2 * marginX;
  return {
    w,
    h: baseH + 2 * marginY,
    baseW,
    baseH,
    screenX: marginX + Math.round((baseW - width) / 2),
    screenY: marginY + Math.round((baseH - height) / 2),
    restScale: d.out_w / w,
  };
}

/**
 * With a title or captions, every export keeps its card fixed above a reserved text band and the
 * camera moves inside the card, so text never covers the app or a toast. The card takes the
 * export's shape (a 16:9 screen cut to portrait fills it), or the screen's own shape when the
 * screen is narrower than the export (a phone in a 16:9 film shows whole).
 */
export interface Band { stage: Stage; top: number; titleY: number; captionY: number; titleH: number; captionH: number }

function bandRows(captions: Caption[], widths: (number | CaptionInk)[], d: CameraDefaults) {
  const layouts = captions.map((c, i) => bandCaption(c, widths[i] ?? 0, d));
  const titleH = Math.max(0, ...layouts.map((l, i) => captions[i]!.title ? l.h + 2 * l.rise : 0));
  const captionH = Math.max(0, ...layouts.map((l, i) => !captions[i]!.title ? l.h + 2 * l.rise + 2 * d.caption_border : 0));
  const gap = titleH && captionH ? d.caption_size * 0.35 : 0;
  // Reserve measured text/rise and title-safe space, not a second large gutter.
  const padding = d.caption_size * 0.05;
  return { titleH, captionH, gap, padding, band: Math.ceil(titleH + captionH + gap + 2 * padding) };
}

/**
 * Text geometry for the band: caption_size is in output px, so on small outputs it
 * scales down until the band takes at most a third of the frame, and a tenth of a portrait
 * frame. The card so keeps over 55% of a square frame's width and 80% of a portrait one's.
 * 1080p landscape is untouched.
 */
export function bandText(captions: Caption[], widths: (number | CaptionInk)[], d: CameraDefaults): CameraDefaults {
  const share = d.out_h > d.out_w ? 0.1 : 1 / 3;
  const fit = Math.min(1, d.out_h * share / bandRows(captions, widths, d).band);
  return fit < 1 ? { ...d, caption_size: d.caption_size * fit, caption_border: d.caption_border * fit } : d;
}

/** A screen narrower than the export shows whole, in a band card of its own shape. */
export function narrowScreen(width: number, height: number, d: CameraDefaults): boolean {
  return width / height < d.out_w / d.out_h - 0.01;
}

/** The camera's view in a band: a card of the screen's own shape frames at that shape, in card px. */
export function bandCamera(band: Band, width: number, height: number, d: CameraDefaults): CameraDefaults {
  return narrowScreen(width, height, d) ? { ...d, out_w: band.stage.baseW, out_h: band.stage.baseW * height / width } : d;
}

/** A viewport fitted inside the screen at `aspect`, about its centre: a band card shows only screen. */
export function insideScreen(frame: CameraFrame, width: number, height: number, aspect: number): CameraFrame {
  const w = Math.min(frame.w, width, height * aspect), h = w / aspect;
  return { t: frame.t, x: clamp(frame.x + (frame.w - w) / 2, 0, width - w), y: clamp(frame.y + (frame.h - h) / 2, 0, height - h), w, h };
}

export function bandLayout(width: number, height: number, d: CameraDefaults, captions: Caption[] = [],
  widths: (number | CaptionInk)[] = []): Band {
  const { titleH, captionH, gap, padding, band } = bandRows(captions, widths, d);
  // A push-in can paint text right at the card edge; keep that edge title-safe too.
  const top = Math.max(Math.ceil(d.out_h * SAFE_INSET),
    Math.round(d.out_h * d.stage_margin / (1 + 2 * d.stage_margin) / 4));
  // Band text keeps the bottom inset clear, like captions without a band (title safe).
  const safe = Math.max(0, Math.ceil(d.out_h * SAFE_INSET - padding));
  const h = Math.floor((d.out_h - top - band - safe) / 2) * 2;
  if (h <= 0) throw new Error("text is too tall for the stage band");
  const w = even(h * (narrowScreen(width, height, d) ? width / height : d.out_w / d.out_h));
  const stage = { w: d.out_w, h: d.out_h, baseW: w, baseH: h, screenX: Math.round((d.out_w - w) / 2), screenY: top, restScale: 1 };
  return { stage, top: top + h, titleY: top + h + padding + titleH / 2,
    captionY: top + h + padding + titleH + gap + captionH / 2, titleH, captionH };
}

/** Solver viewports re-expressed as full-output viewports, for code that projects source px to output px. */
export function bandFrames(frames: CameraFrame[], band: Band, d: CameraDefaults): CameraFrame[] {
  const { screenX, screenY, baseW, baseH } = band.stage;
  return frames.map(f => ({ t: f.t, x: f.x - screenX * f.w / baseW, y: f.y - screenY * f.h / baseH,
    w: f.w * d.out_w / baseW, h: f.h * d.out_h / baseH }));
}

/**
 * Map solver viewports (source px) onto the stage. At rest the whole stage shows;
 * zooming eases the margin away so the deepest zoom still fills the frame with screen.
 *
 * When the output is narrower than the source (portrait/square/4:5 from a 16:9
 * capture), showing the whole stage would letterbox the screen inside a tall
 * padded canvas. Those presets instead crop to fill: the viewport is clamped to
 * the largest output-aspect window inside the screen card (inset by the corner
 * radius so no background shows), centred on the shot's subject. The action stays
 * framed while every output pixel is screen.
 */
export function stageFrames(frames: CameraFrame[], width: number, height: number, st: Stage, d: CameraDefaults): CameraFrame[] {
  const top = zMax(width, height, d);
  const aspect = d.out_w / d.out_h;
  const fitW = fillWidth(width, height, st, d) ?? 0;
  const narrow = fitW > 0;
  // Crop-to-fill avoids each rounded card corner only as far as the window actually reaches it: it
  // is inset horizontally by the corner's depth at that height, not by the whole radius on all four
  // sides, so a frame that stays off the side corners can still show the top or bottom edge (a
  // top-bar control, say) without exposing any background.
  const radius = d.corner_radius / st.restScale;
  return frames.map((f) => {
    const cx = f.x + f.w / 2 + st.screenX;
    const cy = f.y + f.h / 2 + st.screenY;
    if (narrow) {
      const w = Math.min(f.w, fitW);
      const h = w / aspect;
      const y = clamp(cy - h / 2, st.screenY, st.screenY + height - h);
      const depth = (edge: number) => edge > 0 ? radius - Math.sqrt(Math.max(0, radius * radius - edge * edge)) : 0;
      const inset = Math.max(depth(st.screenY + radius - y), depth(y + h - (st.screenY + height - radius)));
      return { t: f.t, x: clamp(cx - w / 2, st.screenX + inset, st.screenX + width - inset - w), y, w, h };
    }
    const zoom = st.baseW / f.w;
    const keep = top > 1 ? 1 - smooth(clamp((zoom - 1) / (top - 1), 0, 1)) : 1;
    // The margin fades out continuously as the camera pushes in, so the projected view never
    // jumps frame to frame. A framing whose margin lands under minStageMargin is moved before
    // it becomes a hold (see the solver), rather than clamped here into a pop.
    // Keep the export aspect where the stage clamps: its even-rounded sides are not exactly 16:9,
    // and an off-aspect window costs the camera's v360 a third remap rebuild per move step.
    const h = Math.min(st.h, Math.min(st.w, f.w * (1 + 2 * d.stage_margin * keep)) / aspect);
    const w = h * aspect;
    return {
      t: f.t,
      x: clamp(cx - w / 2, 0, st.w - w),
      y: clamp(cy - h / 2, 0, st.h - h),
      w,
      h,
    };
  });
}

/** Margin in source px below which a frame's background shows only as a hairline at the
 * border, reading as a cut card (the visual check counts it as cut text). */
export function minStageMargin(width: number, d: CameraDefaults): number {
  return width * 0.028 * Math.min(d.out_w, d.out_h) / d.out_w;
}

/** Crop-to-fill window width when the output is narrower than the screen: the
 * widest output-aspect view that shows only screen pixels. Undefined otherwise. */
export function fillWidth(width: number, height: number, st: Stage, d: CameraDefaults): number | undefined {
  const aspect = d.out_w / d.out_h;
  if (aspect >= width / height - 1e-6) return undefined;
  const corner = cornerSize(st, d);
  return Math.min(width - 2 * corner, (height - 2 * corner) * aspect);
}

/** The rendered viewport in source coordinates, shared with whole-subject preparation. */
export function sourceViewport(frame: CameraFrame, width: number, height: number, st: Stage,
  d: CameraDefaults): CameraFrame {
  const view = stageFrames([frame], width, height, st, d)[0]!;
  return { ...view, x: view.x - st.screenX, y: view.y - st.screenY };
}

/** Side of the square corner patches that round the card, in stage px. */
export function cornerSize(st: Stage, d: CameraDefaults): number {
  return even(d.corner_radius / st.restScale + 2);
}

/**
 * Single-frame ffmpeg filter graph with two outputs: [stage], the gradient with the
 * card's shadow, and [holes], the same image with the card cut out as alpha. The
 * screen is opaque, so the render only needs the four corners of [holes] on top.
 */
export function stageImageFilter(width: number, height: number, st: Stage, d: CameraDefaults, phone = false): string {
  const radius = d.corner_radius / st.restScale;
  const shadowY = Math.round(d.shadow_y / st.restScale);
  const blur = (d.shadow_blur / st.restScale).toFixed(1);

  const shadowX = Math.round(d.shadow_x / st.restScale);
  // Antialiased rounded-rectangle alpha from its signed distance.
  const card = `geq=lum='255*clip(${radius}+0.5-hypot(max(abs(X+0.5-W/2)-(W/2-${radius}),0),max(abs(Y+0.5-H/2)-(H/2-${radius}),0)),0,1)'`;
  // Fixed-seed luma noise is static. Pin its input to 8-bit YUV so pixel
  // format negotiation cannot turn subtle dither into high-depth colour noise.
  return [
    `color=black:s=${width}x${height}:d=1,format=gray,${card},split[m1][m2]`,
    `[m1]pad=${st.w}:${st.h}:${st.screenX + shadowX}:${st.screenY + shadowY}:black${d.shadow_blur > 0 ? `,gblur=sigma=${blur}` : ""},lutyuv=y=val*${d.shadow}[sa]`,
    `color=${d.shadow_color}:s=${st.w}x${st.h}:d=1,format=rgba[sb]`,
    `[sb][sa]alphamerge[shadow]`,
    `${backgroundFilter(st, d)},format=yuv444p${backgroundPattern(d)}${d.grain > 0 ? `,noise=c0s=${d.grain}:c0f=u:c0_seed=7` : ""}[bg]`,
    `[bg][shadow]overlay=format=auto[base]`,
    ...(d.border > 0 || d.glow > 0 ? [
      `color=${d.glow > 0 ? d.accent : d.border_color}:s=${st.w}x${st.h}:d=1,format=rgba[accent]`,
      (d.glow > 0
        ? `color=black:s=${width}x${height}:d=1,format=gray,${card},pad=${st.w}:${st.h}:${st.screenX}:${st.screenY}:black`
          + `,gblur=sigma=${(24 / st.restScale).toFixed(1)},lutyuv=y=val*${d.glow}`
        : `color=black:s=${st.w}x${st.h}:d=1,format=gray,geq=lum='255*clip(${radius + d.border / st.restScale}+0.5-hypot(max(abs(X+0.5-${st.screenX + width / 2})-(${width / 2 - radius}),0),max(abs(Y+0.5-${st.screenY + height / 2})-(${height / 2 - radius}),0)),0,1)'`)
        + `[accentmask]`,
      `[accent][accentmask]alphamerge[edge]`,
      `[base][edge]overlay=format=auto[look]`,
    ] : [`[base]null[look]`]),
    ...(phone ? phoneFrameFilter(width, height, st, radius) : []),
    `[${phone ? "framed" : "look"}]format=rgb24,split[stage][cut]`,
    `[m2]negate,pad=${st.w}:${st.h}:${st.screenX}:${st.screenY}:white[hole]`,
    `[cut][hole]alphamerge[holes]`,
  ].join(";");
}

/** Graphite handset: a fine metal rim, dark bezel and physical side controls.
 * Drawn behind the source so app pixels and touch coordinates remain unchanged. */
function phoneFrameFilter(width: number, height: number, st: Stage, radius: number): string[] {
  const bezel = 12 / st.restScale;
  const cx = st.screenX + width / 2;
  const cy = st.screenY + height / 2;
  const mask = (edge: number) => `geq=lum='255*clip(${radius + edge}+0.5-hypot(max(abs(X+0.5-${cx})-(${width / 2 - radius}),0),max(abs(Y+0.5-${cy})-(${height / 2 - radius}),0)),0,1)'`;
  const buttonW = Math.max(2, Math.round(3 / st.restScale));
  const x = Math.round(st.screenX + width + bezel - 1);
  return [
    `color=0x777d88:s=${st.w}x${st.h}:d=1,format=rgba[rim]`,
    `color=black:s=${st.w}x${st.h}:d=1,format=gray,${mask(bezel)}[rimMask]`,
    `[rim][rimMask]alphamerge[rimAlpha]`,
    `[look][rimAlpha]overlay=format=auto[metal]`,
    `color=0x171a20:s=${st.w}x${st.h}:d=1,format=rgba[bezel]`,
    `color=black:s=${st.w}x${st.h}:d=1,format=gray,${mask(bezel - 1.5 / st.restScale)}[bezelMask]`,
    `[bezel][bezelMask]alphamerge[bezelAlpha]`,
    `[metal][bezelAlpha]overlay=format=auto,drawbox=x=${x}:y=${Math.round(st.screenY + height * .24)}:w=${buttonW}:h=${Math.round(height * .08)}:color=0x626975:t=fill,drawbox=x=${Math.round(st.screenX - bezel - buttonW + 1)}:y=${Math.round(st.screenY + height * .18)}:w=${buttonW}:h=${Math.round(height * .1)}:color=0x626975:t=fill[framed]`,
  ];
}

/** Main-graph filters that lay the opaque [screen] on the looped [stage] and round its corners. */
export function cardFilter(width: number, height: number, st: Stage, d: CameraDefaults, still: string): string {
  const c = cornerSize(st, d);
  const sampling = d.quality === "master" ? "444" : "420";
  const spots = [[0, 0], [width - c, 0], [0, height - c], [width - c, height - c]]
    .map(([x, y]) => [st.screenX + x!, st.screenY + y!]);
  const parts = [
    `[1:v]format=yuv${sampling}p,${still}[stage]`,
    `[2:v]format=yuva${sampling}p,${still},split=4${spots.map((_, i) => `[h${i}]`).join("")}`,
    ...spots.map(([x, y], i) => `[h${i}]crop=${c}:${c}:${x}:${y}[k${i}]`),
    `[stage][screen]overlay=${st.screenX}:${st.screenY}:shortest=1:format=yuv${sampling}[c0]`,
    ...spots.map(([x, y], i) => `[c${i}][k${i}]overlay=${x}:${y}:format=yuv${sampling}[c${i + 1}]`),
  ];
  return parts.join(";");
}

// ---------------------------------------------------------------------------
// ASS overlays
// ---------------------------------------------------------------------------

/** #RRGGBB and alpha (0 opaque .. 1 clear) as an ASS &HAABBGGRR& colour pair. */
function assColour(hex: string): string {
  return `&H${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`;
}
function assAlpha(clear: number): string {
  return `&H${Math.round(clamp(clear, 0, 1) * 255).toString(16).padStart(2, "0").toUpperCase()}&`;
}

export function assTime(s: number): string {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const sec = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

const n = (value: number) => value.toFixed(1);

/** Circle path centred on (cx, cy); reversed winding punches a hole. */
function circle(cx: number, cy: number, r: number, reverse = false): string {
  const k = r * 0.5523;
  const s = reverse ? -1 : 1;
  return `m ${n(cx + r)} ${n(cy)} `
    + `b ${n(cx + r)} ${n(cy + s * k)} ${n(cx + k)} ${n(cy + s * r)} ${n(cx)} ${n(cy + s * r)} `
    + `b ${n(cx - k)} ${n(cy + s * r)} ${n(cx - r)} ${n(cy + s * k)} ${n(cx - r)} ${n(cy)} `
    + `b ${n(cx - r)} ${n(cy - s * k)} ${n(cx - k)} ${n(cy - s * r)} ${n(cx)} ${n(cy - s * r)} `
    + `b ${n(cx + k)} ${n(cy - s * r)} ${n(cx + r)} ${n(cy - s * k)} ${n(cx + r)} ${n(cy)}`;
}

export function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  const k = r * 0.4477; // r - 0.5523r: bezier handle offset from the corner
  return `m ${n(x + r)} ${n(y)} l ${n(x + w - r)} ${n(y)} `
    + `b ${n(x + w - k)} ${n(y)} ${n(x + w)} ${n(y + k)} ${n(x + w)} ${n(y + r)} `
    + `l ${n(x + w)} ${n(y + h - r)} b ${n(x + w)} ${n(y + h - k)} ${n(x + w - k)} ${n(y + h)} ${n(x + w - r)} ${n(y + h)} `
    + `l ${n(x + r)} ${n(y + h)} b ${n(x + k)} ${n(y + h)} ${n(x)} ${n(y + h - k)} ${n(x)} ${n(y + h - r)} `
    + `l ${n(x)} ${n(y + r)} b ${n(x)} ${n(y + k)} ${n(x + k)} ${n(y)} ${n(x + r)} ${n(y)}`;
}

export function assHeader(w: number, h: number, font: string, size: number): string {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${font},${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

export function drawing(start: number, end: number, colour: string, clear: number, path: string, layer = 0): string {
  // \pos(0,0) with \an7 keeps drawing coordinates absolute on the canvas.
  return `Dialogue: ${layer},${assTime(start)},${assTime(end)},Default,,0,0,0,,`
    + `{\\an7\\pos(0,0)\\bord0\\shad0\\1c${assColour(colour)}\\1a${assAlpha(clear)}\\p1}${path}\n`;
}

export interface Click { t: number; x: number; y: number }

/** Clicks and drag presses the film shows, from beat actions (ms timestamps), deduplicated, in seconds. */
export function beatClicks(beats: Beat[]): Click[] {
  const clicks = new Map<string, Click>();
  for (const beat of beats) for (const action of beat.actions) {
    const a = action as { k?: string; t?: number; t0?: number; x?: number; y?: number; from?: [number, number]; resumed?: boolean };
    const hit = a.k === "click" && a.t !== undefined && a.x !== undefined && a.y !== undefined
      ? { t: a.t / 1000, x: a.x, y: a.y }
      : a.k === "drag" && a.t0 !== undefined && a.from && !a.resumed ? { t: a.t0 / 1000, x: a.from[0], y: a.from[1] } : null;
    if (hit) clicks.set(`${hit.t}:${hit.x}:${hit.y}`, hit);
  }
  return [...clicks.values()].sort((a, b) => a.t - b.t);
}

/**
 * Click emphasis in source px: a thin translucent accent ring that expands from
 * the press, baked per output frame so the easing is exact and renderer-independent.
 * There is no filled press dot, so the clicked label stays readable, and the ring
 * never grows past the camera's visible source bounds during its window.
 */
export function clickAss(clicks: Click[], width: number, height: number, start: number, st: Stage, d: CameraDefaults,
  camera: { frames: CameraFrame[]; stage: Stage; shutter: ReturnType<typeof shutterPlan> }): string {
  let out = assHeader(width, height, d.caption_font, d.caption_size);
  const duration = d.ripple_ms / 1000;
  if (duration <= 0) return out;
  const px = 1 / st.restScale; // one output px at rest, in source px
  const step = 1 / d.fps;
  const easeOut = (u: number) => 1 - (1 - u) ** 3;
  const halo = 1 * px;
  for (const click of clicks) {
    const t0 = click.t - start;
    // Room from the press to the nearest visible edge, less a 6 output px inset.
    let room = Math.min(click.x, width - click.x, click.y, height - click.y) - 6 * px;
    camera.frames.forEach((f, index) => {
      if (f.t >= t0 + duration || f.t + step <= t0) return;
      for (const e of shutterFrames(camera.frames, camera.shutter, index)) {
        const x = click.x - (e.x - camera.stage.screenX), y = click.y - (e.y - camera.stage.screenY);
        room = Math.min(room, Math.min(x, e.w - x, y, e.h - y) - 6 * Math.max(e.w / d.out_w, e.h / d.out_h));
      }
    });
    const r1 = Math.min(d.ripple_r * px, room - halo);
    // ponytail: a press with under 6 px of room is at the frame edge; skip it rather than clip it.
    if (r1 < 6 * px) continue;
    const r0 = Math.min(10 * px, r1);
    for (let u0 = 0; u0 < 1; u0 += step / duration) {
      const u = Math.min(1, u0 + step / duration / 2);
      const r = r0 + (r1 - r0) * easeOut(u);
      const thick = Math.min((3 - 1.5 * u) * px, r / 3);
      const from = t0 + u0 * duration;
      const to = Math.min(t0 + duration, from + step);
      if (to <= 0) continue;
      // A faint white halo keeps the ring visible on accent-coloured targets.
      out += drawing(from, to, "#ffffff", 0.6 + 0.4 * u,
        `${circle(click.x, click.y, r + halo)} ${circle(click.x, click.y, Math.max(0, r - thick - halo), true)}`);
      out += drawing(from, to, d.accent, 0.35 + 0.65 * u ** 1.5,
        `${circle(click.x, click.y, r)} ${circle(click.x, click.y, Math.max(0, r - thick), true)}`, 1);
    }
  }
  return out;
}

export interface Caption { t0: number; t1: number; text: string; title: boolean; hold?: boolean }

/**
 * Title plus captions from take.json, sanitised for ASS. `at` maps a video time to
 * output time; durations are output seconds so reading time survives idle squeezing.
 */
export function takeCaptions(meta: TakeMeta, at: (t: number) => number, duration: number): Caption[] {
  const clean = (text: string) => text.replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim();
  const out: Caption[] = [];
  const title = typeof meta.title === "string" ? clean(meta.title) : "";
  if (title) out.push({ t0: 0.35, t1: Math.min(duration, 3.1), text: title, title: true });
  for (const caption of Array.isArray(meta.captions) ? meta.captions : []) {
    if (!caption || typeof caption.text !== "string" || !Number.isFinite(caption.t)) continue;
    const text = clean(caption.text);
    const d = Number.isFinite(caption.d) && caption.d! > 0 ? caption.d! : 3;
    const t0 = Math.max(0, at(caption.t));
    const t1 = Math.min(duration, at(caption.t) + d);
    if (text && t1 > t0) out.push({ t0, t1, text, title: false, hold: caption.hold });
  }
  const body = out.filter(c => !c.title).sort((a, b) => a.t0 - b.t0);
  for (let i = 0; i + 1 < body.length; i++) {
    const [cur, next] = [body[i]!, body[i + 1]!];
    if (cur.hold && next.t0 < cur.t1) {
      // The held caption keeps its reading time; the next one starts when it ends.
      // One that then runs past the film's end cannot be read in full, so it is dropped, not flashed.
      const shift = cur.t1 - next.t0;
      next.t0 += shift;
      next.t1 += shift;
      if (next.t1 > duration && next.hold) next.t1 = next.t0;
      next.t1 = Math.min(duration, next.t1);
    }
    cur.t1 = Math.min(cur.t1, next.t0);
  }
  return [...out.filter(c => c.title && c.t1 > c.t0), ...body.filter(c => c.t1 > c.t0)];
}

/**
 * Ink bounds must use the same libass/font as final rendering so row sizing
 * and collision avoidance agree with the visible text.
 */
export interface CaptionInk { w: number; h: number }

function captionMargin(size: number, d: CameraDefaults): number {
  return Math.ceil(d.out_w * 0.05 + size * 0.75);
}

// A compact band title stays larger than the caption without squeezing the app card.
const titleSize = (d: CameraDefaults) => Math.round(d.caption_size * 1.125);

const luminance = (colour: string) => [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16) / 255)
  .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (a: string, b: string) => {
  const [lo, hi] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (hi! + 0.05) / (lo! + 0.05);
};
/** The bare title sits on the stage, so it takes whichever caption colour reads best there. */
export function titleColour(d: CameraDefaults): string {
  return contrast(d.text, d.background) >= contrast(d.card, d.background) ? d.text : d.card;
}

function bandCaption(caption: Caption, ink: number | CaptionInk, d: CameraDefaults) {
  const inkW = typeof ink === "number" ? ink : ink.w;
  const base = caption.title ? titleSize(d) : d.caption_size;
  const fit = caption.title ? 1 : Math.min(1, (d.out_w * 0.9 - 2 * base * 0.75) / Math.max(1, inkW));
  const size = base * fit;
  const w = inkW * fit + (caption.title ? 0 : 2 * size * 0.75);
  const inkH = typeof ink === "number" ? 0 : ink.h * fit;
  const h = caption.title ? Math.max(size, inkH) : Math.ceil(Math.max(size * 1.9, inkH + size * 0.9));
  return { w, h, size, rise: Math.round(size * 0.3) };
}

/** Shared geometry keeps keycap collision avoidance identical to caption placement. */
export function captionLayouts(captions: Caption[], widths: (number | CaptionInk)[], d: CameraDefaults, band: Band) {
  return captions.map((caption, index) => {
    const layout = bandCaption(caption, widths[index] ?? 0, d);
    const rowH = caption.title ? band.titleH : band.captionH;
    if (layout.w > d.out_w * 0.9 || layout.h + 2 * layout.rise > rowH) {
      throw new Error("text does not fit the stage band row");
    }
    return { cx: d.out_w / 2, cy: caption.title ? band.titleY : band.captionY, ...layout };
  });
}

/** In the band the title is bare display type; captions keep their pill, one line each. */
export function captionAss(captions: Caption[], widths: (number | CaptionInk)[], d: CameraDefaults, band: Band): string {
  let out = assHeader(d.out_w, d.out_h, d.caption_font, d.caption_size);
  const layouts = captionLayouts(captions, widths, d, band);
  captions.forEach((caption, index) => {
    const { cx, cy, w, h, size, rise } = layouts[index]!;
    const settle = Math.round(260 * 14 / d.spring_omega / d.spring_zeta);
    const move = `\\move(${cx},${cy + rise},${cx},${cy},0,${settle})`;
    const fade = `\\fad(220,200)`;
    const time = `${assTime(caption.t0)},${assTime(caption.t1)}`;
    const font = caption.title ? d.display_font : d.caption_font;
    const margin = captionMargin(size, d);
    if (caption.title) {
      out += `Dialogue: 3,${time},Default,,${margin},${margin},0,,{\\q0\\an5${move}${fade}\\fs${size}\\fn${font}\\1c${assColour(titleColour(d))}\\bord0\\shad0}${caption.text}\n`;
      return;
    }
    out += `Dialogue: 2,${time},Default,,0,0,0,,{\\an7${move}${fade}\\bord${d.caption_border}\\3c${assColour(d.text)}\\shad0\\blur0.6`
      + `\\1c${assColour(d.card)}\\1a${assAlpha(1 - d.caption_opacity)}\\p1}${roundRect(-w / 2, -h / 2, w, h, h / 2 * d.caption_rounding)}\n`;
    out += `Dialogue: 3,${time},Default,,${margin},${margin},0,,{\\q2\\an5${move}${fade}\\fs${size}\\fn${font}\\1c${assColour(d.text)}\\bord0\\shad0}${caption.text}\n`;
  });
  return out;
}

/** Show caption i alone during second i, with the final wrap width, to measure its ink bounds. */
export function measureAss(captions: Caption[], d: CameraDefaults, scaleX = 100): string {
  let out = assHeader(d.out_w, d.out_h, d.caption_font, d.caption_size);
  captions.forEach((caption, index) => {
    const size = caption.title ? titleSize(d) : d.caption_size;
    const margin = captionMargin(size, d);
    out += `Dialogue: 0,${assTime(index)},${assTime(index + 1)},Default,,${margin},${margin},0,,{\\q${caption.title ? 0 : 2}\\an5\\pos(${d.out_w / 2},${d.out_h / 2})${caption.title ? "" : `\\fscx${scaleX}`}\\fs${size}\\fn${caption.title ? d.display_font : d.caption_font}}${caption.text}\n`;
  });
  return out;
}

/** A deterministic still for recordings. Motion scenes may animate the same tokens.
 * Every style but solid reads input 0: the user's image, or {@link backgroundPixels}. */
export function backgroundFilter(st: Stage, d: CameraDefaults): string {
  if (d.bg_style === "solid") return `color=0x${d.background.slice(1)}:s=${st.w}x${st.h}:d=1`;
  return `[0:v]scale=${st.w}:${st.h}:force_original_aspect_ratio=increase,crop=${st.w}:${st.h},setsar=1`;
}

/** The linear, radial or mesh stage gradient as dithered 8-bit RGB; null for solid and image. */
export function backgroundPixels(st: Stage, d: CameraDefaults): PixelFrame | null {
  if (d.bg_style === "solid" || d.bg_style === "image") return null;
  const rgb = (d.bg_stops ? d.bg_stops.split(",") : [d.background, d.background_to])
    .map(c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)));
  const { w, h } = st, n = rgb.length, data = new Uint8Array(w * h * 3), colour = [0, 0, 0];
  // Mesh: four broad radial pools at fixed positions rather than banded concentric stops.
  const pools: [number, number][] = [[0.1, 0.15], [0.85, 0.15], [0.1, 0.85], [0.85, 0.85]];
  const weights = new Float64Array(n);
  // A colour ramp moves the chroma planes by about 20 levels across the frame, so an 8-bit
  // stage without dither shows each level as a band (the old blue-to-violet default measured
  // V-plane CAMBI 10 on a real film while luma read 0.01, so the luma grain never reached it).
  // Triangular dither of +-2 levels per channel from independent hashes, so the channels do
  // not cancel in chroma, held over 2x2 output px so 4:2:0 subsampling keeps it.
  const block = Math.max(1, Math.round(2 / st.restScale));
  const hash = (x: number, y: number, k: number) => {
    let v = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(k, 0x9e3779b9);
    v = Math.imul(v ^ (v >>> 15), 0x85ebca6b); v = Math.imul(v ^ (v >>> 13), 0xc2b2ae35);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  };
  // A 4K source stage is tens of millions of pixels, so everything that depends only on the column,
  // the row or the dither block is computed once: exp(-3(dx + dy)) as a column factor times a row
  // factor, and the dither per block row.
  const mesh = d.bg_style === "mesh", radial = d.bg_style === "radial", c = Float64Array.from(rgb.flat());
  const ex = new Float64Array(4 * w), ey = new Float64Array(4), dither = new Float64Array(w * 3);
  for (let k = 0; k < 4; k++) for (let x = 0; x < w; x++) ex[k * w + x] = Math.exp(-3 * (x / w - pools[k]![0]) ** 2);
  for (let y = 0; y < h; y++) {
    for (let k = 0; k < 4; k++) ey[k] = Math.exp(-3 * (y / h - pools[k]![1]) ** 2);
    if (y % block === 0) for (let x = 0, by = y / block; x < w; x++) for (let i = 0; i < 3; i++) {
      const bx = Math.floor(x / block);
      dither[x * 3 + i] = 2 * (hash(bx, by, 2 * i) + hash(bx, by, 2 * i + 1) - 1);
    }
    for (let x = 0, at = y * w * 3; x < w; x++, at += 3) {
      if (mesh) {
        let sum = 0;
        for (let j = 0; j < n; j++) sum += weights[j] = ex[(j % 4) * w + x]! * ey[j % 4]!;
        for (let i = 0; i < 3; i++) {
          let a = 0;
          for (let j = 0; j < n; j++) a += c[j * 3 + i]! * weights[j]!;
          colour[i] = a / sum;
        }
      } else {
        // Evenly spaced stops along the diagonal, or outward from the centre for radial.
        const t = radial ? Math.hypot(x - w / 2, y - h / 2) / Math.hypot(w / 2, h / 2) : (x * w + y * h) / (w * w + h * h);
        const s = Math.min(Math.max(t, 0), 1) * (n - 1), j = Math.min(Math.floor(s), n - 2), f = s - j;
        for (let i = 0; i < 3; i++) colour[i] = c[j * 3 + i]! + (c[(j + 1) * 3 + i]! - c[j * 3 + i]!) * f;
      }
      for (let i = 0; i < 3; i++) data[at + i] = Math.min(255, Math.max(0, Math.round(colour[i]! + dither[x * 3 + i]!)));
    }
  }
  return { width: w, height: h, channels: 3, data };
}

/** Low-contrast stage texture; static coordinates keep rerenders deterministic. */
function backgroundPattern(d: CameraDefaults): string {
  if (d.bg_pattern === "none") return "";
  const line = d.bg_pattern === "grid"
    ? "max(lt(mod(X,48),1),lt(mod(Y,48),1))" : "lt(mod(Y,6),1)";
  return `,geq=lum='lum(X,Y)+6*(${line})':cb='cb(X,Y)':cr='cr(X,Y)'`;
}
