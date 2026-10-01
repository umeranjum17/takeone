// The stage: the screen as a rounded card on a gradient, click ripples drawn in
// source space (so they zoom with the content) and captions drawn in output space.
// Everything here is local ffmpeg/libass work and costs zero tokens.
import type { CameraDefaults } from "../camera/defaults.ts";
import { zMax } from "../camera/solver.ts";
import type { Beat, CameraFrame, TakeMeta } from "../camera/types.ts";

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
 * Map solver viewports (source px) onto the stage. At rest the whole stage shows;
 * zooming eases the margin away so the deepest zoom still fills the frame with screen.
 */
export function stageFrames(frames: CameraFrame[], width: number, height: number, st: Stage, d: CameraDefaults): CameraFrame[] {
  const top = zMax(width, height, d);
  const aspect = d.out_w / d.out_h;
  const portraitCrop = d.out_h > d.out_w && width / height > aspect;
  const portraitFillWidth = height * aspect;
  return frames.map((f) => {
    const zoom = st.baseW / f.w;
    const keep = top > 1 ? 1 - smooth(clamp((zoom - 1) / (top - 1), 0, 1)) : 1;
    const portraitMargin = portraitCrop
      ? clamp((f.w - portraitFillWidth) / (st.baseW - portraitFillWidth), 0, 1)
      : 1;
    const naturalW = Math.min(st.w, f.w * (1 + 2 * d.stage_margin * keep * portraitMargin));
    let w = naturalW;
    let h = Math.min(st.h, w / aspect);
    // Ease stage padding out as the portrait viewport approaches screen fill.
    // A hard clamp here changes the visible viewport in one frame at the
    // fill threshold, even though the solver path itself is smooth.
    if (portraitCrop && f.w < portraitFillWidth * 1.1) {
      const fillMix = smooth(clamp((f.w - portraitFillWidth) / (portraitFillWidth * 0.1), 0, 1));
      w = portraitFillWidth + (naturalW - portraitFillWidth) * fillMix;
      h = Math.min(height, w / aspect);
    }
    const cx = f.x + f.w / 2 + st.screenX;
    const cy = f.y + f.h / 2 + st.screenY;
    const relaxX = smooth(clamp((w - width + st.screenX * 2) / (st.screenX * 4), 0, 1));
    const relaxY = smooth(clamp((h - height + st.screenY * 2) / (st.screenY * 4), 0, 1));
    // The source-bounded and stage-bounded clamp ranges meet at the source
    // dimensions. Switching between them there can move an edge-tracked view
    // by an entire stage margin in one frame. Expand the allowed range smoothly.
    const halfX = Math.max(0, (width - w) / 2 + relaxX * st.screenX);
    const halfY = Math.max(0, (height - h) / 2 + relaxY * st.screenY);
    const centerX = st.w / 2;
    const centerY = st.h / 2;
    return {
      t: f.t,
      x: portraitCrop ? clamp(cx, centerX - halfX, centerX + halfX) - w / 2
        : clamp(cx - w / 2, 0, st.w - w),
      y: portraitCrop ? clamp(cy, centerY - halfY, centerY + halfY) - h / 2
        : clamp(cy - h / 2, 0, st.h - h),
      w,
      h,
    };
  });
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
export function stageImageFilter(width: number, height: number, st: Stage, d: CameraDefaults): string {
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
    `[look]format=rgb24,split[stage][cut]`,
    `[m2]negate,pad=${st.w}:${st.h}:${st.screenX}:${st.screenY}:white[hole]`,
    `[cut][hole]alphamerge[holes]`,
  ].join(";");
}

/** Main-graph filters that lay the opaque [screen] on the looped [stage] and round its corners. */
export function cardFilter(width: number, height: number, st: Stage, d: CameraDefaults, still: string): string {
  const c = cornerSize(st, d);
  const spots = [[0, 0], [width - c, 0], [0, height - c], [width - c, height - c]]
    .map(([x, y]) => [st.screenX + x!, st.screenY + y!]);
  const parts = [
    `[1:v]format=yuv420p,${still}[stage]`,
    `[2:v]format=yuva420p,${still},split=4${spots.map((_, i) => `[h${i}]`).join("")}`,
    ...spots.map(([x, y], i) => `[h${i}]crop=${c}:${c}:${x}:${y}[k${i}]`),
    `[stage][screen]overlay=${st.screenX}:${st.screenY}:shortest=1[c0]`,
    ...spots.map(([x, y], i) => `[c${i}][k${i}]overlay=${x}:${y}[c${i + 1}]`),
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

function assTime(s: number): string {
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

function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  const k = r * 0.4477; // r - 0.5523r: bezier handle offset from the corner
  return `m ${n(x + r)} ${n(y)} l ${n(x + w - r)} ${n(y)} `
    + `b ${n(x + w - k)} ${n(y)} ${n(x + w)} ${n(y + k)} ${n(x + w)} ${n(y + r)} `
    + `l ${n(x + w)} ${n(y + h - r)} b ${n(x + w)} ${n(y + h - k)} ${n(x + w - k)} ${n(y + h)} ${n(x + w - r)} ${n(y + h)} `
    + `l ${n(x + r)} ${n(y + h)} b ${n(x + k)} ${n(y + h)} ${n(x)} ${n(y + h - k)} ${n(x)} ${n(y + h - r)} `
    + `l ${n(x)} ${n(y + r)} b ${n(x)} ${n(y + k)} ${n(x + k)} ${n(y)} ${n(x + r)} ${n(y)}`;
}

function assHeader(w: number, h: number, font: string, size: number): string {
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

function drawing(start: number, end: number, colour: string, clear: number, path: string, layer = 0): string {
  // \pos(0,0) with \an7 keeps drawing coordinates absolute on the canvas.
  return `Dialogue: ${layer},${assTime(start)},${assTime(end)},Default,,0,0,0,,`
    + `{\\an7\\pos(0,0)\\bord0\\shad0\\1c${assColour(colour)}\\1a${assAlpha(clear)}\\p1}${path}\n`;
}

export interface Click { t: number; x: number; y: number }

/** Clicks and drag presses from beat actions (ms timestamps), deduplicated, in seconds. */
export function beatClicks(beats: Beat[]): Click[] {
  const clicks = new Map<string, Click>();
  for (const beat of beats) for (const action of beat.actions) {
    const a = action as { k?: string; t?: number; t0?: number; x?: number; y?: number; from?: [number, number] };
    const hit = a.k === "click" && a.t !== undefined && a.x !== undefined && a.y !== undefined
      ? { t: a.t / 1000, x: a.x, y: a.y }
      : a.k === "drag" && a.t0 !== undefined && a.from ? { t: a.t0 / 1000, x: a.from[0], y: a.from[1] } : null;
    if (hit) clicks.set(`${hit.t}:${hit.x}:${hit.y}`, hit);
  }
  return [...clicks.values()].sort((a, b) => a.t - b.t);
}

/**
 * Click emphasis in source px: a soft press dot and an expanding accent ring,
 * baked per output frame so the easing is exact and renderer-independent.
 */
export function clickAss(clicks: Click[], width: number, height: number, start: number, st: Stage, d: CameraDefaults): string {
  let out = assHeader(width, height, d.caption_font, d.caption_size);
  const duration = d.ripple_ms / 1000;
  if (duration <= 0) return out;
  const px = 1 / st.restScale; // one output px at rest, in source px
  const step = 1 / d.fps;
  const easeOut = (u: number) => 1 - (1 - u) ** 3;
  for (const click of clicks) {
    const t0 = click.t - start;
    for (let u0 = 0; u0 < 1; u0 += step / duration) {
      const u = Math.min(1, u0 + step / duration / 2);
      const r = (8 + (d.ripple_r - 8) * easeOut(u)) * px;
      const thick = (5 - 3 * u) * px;
      const from = t0 + u0 * duration;
      const to = Math.min(t0 + duration, from + step);
      if (to <= 0) continue;
      // A white halo under the accent ring keeps it visible on accent-coloured targets.
      const halo = 1.5 * px;
      out += drawing(from, to, "#ffffff", 0.25 + 0.75 * u ** 1.8,
        `${circle(click.x, click.y, r + halo)} ${circle(click.x, click.y, Math.max(0, r - thick - halo), true)}`);
      out += drawing(from, to, d.accent, u ** 1.8,
        `${circle(click.x, click.y, r)} ${circle(click.x, click.y, Math.max(0, r - thick), true)}`, 1);
      if (u < 0.5) {
        out += drawing(from, to, d.accent, 0.45 + 1.1 * u,
          circle(click.x, click.y, (16 - 10 * u) * px), 2);
      }
    }
  }
  return out;
}

export interface Caption { t0: number; t1: number; text: string; title: boolean }

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
    if (text && t1 > t0) out.push({ t0, t1, text, title: false });
  }
  const body = out.filter(c => !c.title).sort((a, b) => a.t0 - b.t0);
  for (let i = 0; i + 1 < body.length; i++) body[i]!.t1 = Math.min(body[i]!.t1, body[i + 1]!.t0);
  return [...out.filter(c => c.title && c.t1 > c.t0), ...body.filter(c => c.t1 > c.t0)];
}

/**
 * Captions as rounded pills near the bottom, sized from `widths`: ink widths
 * and heights measured with the same libass/font that renders them.
 */
export interface CaptionInk { w: number; h: number }

function captionMargin(size: number, d: CameraDefaults): number {
  return Math.ceil(d.out_w * 0.05 + size * 0.75);
}

export function captionAss(captions: Caption[], widths: (number | CaptionInk)[], d: CameraDefaults): string {
  let out = assHeader(d.out_w, d.out_h, d.caption_font, d.caption_size);
  const heights = captions.map((caption, index) => {
    const size = caption.title ? Math.round(d.caption_size * 1.4) : d.caption_size;
    const ink = widths[index] ?? 0;
    const h = typeof ink === "number"
      ? Math.ceil(ink / Math.max(1, d.out_w - 2 * captionMargin(size, d))) * size * 1.2 : ink.h;
    return Math.ceil(Math.max(size, h) + size * 0.9);
  });
  captions.forEach((caption, index) => {
    const size = caption.title ? Math.round(d.caption_size * 1.4) : d.caption_size;
    const padX = size * 0.75;
    const pillH = heights[index]!;
    const ink = widths[index] ?? 0;
    const pillW = Math.min(d.out_w * 0.9, (typeof ink === "number" ? ink : ink.w) + 2 * padX);
    const cx = d.out_w / 2;
    const below = caption.title ? Math.max(0, ...captions.map((other, i) =>
      !other.title && other.t0 < caption.t1 && other.t1 > caption.t0 ? heights[i]! : 0)) : 0;
    const cy = d.out_h - d.out_h * 0.075 - pillH / 2 - (below ? below + size * 0.35 : 0);
    const rise = Math.round(size * 0.3);
    const settle = Math.round(260 * 14 / d.spring_omega / d.spring_zeta);
    const move = `\\move(${cx},${cy + rise},${cx},${cy},0,${settle})`;
    const fade = `\\fad(220,200)`;
    const x = -pillW / 2;
    const y = -pillH / 2;
    const time = `${assTime(caption.t0)},${assTime(caption.t1)}`;
    // The pill is drawn around its own origin so \move animates it with the text.
    out += `Dialogue: 2,${time},Default,,0,0,0,,{\\an7${move}${fade}\\bord${d.caption_border}\\3c${assColour(d.text)}\\shad0\\blur0.6`
      + `\\1c${assColour(d.card)}\\1a${assAlpha(1 - d.caption_opacity)}\\p1}${roundRect(x, y, pillW, pillH, pillH / 2 * d.caption_rounding)}\n`;
    const margin = captionMargin(size, d);
    out += `Dialogue: 3,${time},Default,,${margin},${margin},0,,{\\q0\\an5${move}${fade}\\fs${size}\\fn${caption.title ? d.display_font : d.caption_font}\\1c${assColour(d.text)}\\bord0\\shad0}${caption.text}\n`;
  });
  return out;
}

/** Show caption i alone during second i, with the final wrap width, to measure its ink bounds. */
export function measureAss(captions: Caption[], d: CameraDefaults): string {
  let out = assHeader(d.out_w, d.out_h, d.caption_font, d.caption_size);
  captions.forEach((caption, index) => {
    const size = caption.title ? Math.round(d.caption_size * 1.4) : d.caption_size;
    const margin = captionMargin(size, d);
    out += `Dialogue: 0,${assTime(index)},${assTime(index + 1)},Default,,${margin},${margin},0,,{\\q0\\an5\\pos(${d.out_w / 2},${d.out_h / 2})\\fs${size}\\fn${caption.title ? d.display_font : d.caption_font}}${caption.text}\n`;
  });
  return out;
}

/** A deterministic still for recordings. Motion scenes may animate the same tokens. */
export function backgroundFilter(st: Stage, d: CameraDefaults): string {
  const hex = (colour: string) => `0x${colour.slice(1)}`;
  if (d.bg_style === "image") return `[0:v]scale=${st.w}:${st.h}:force_original_aspect_ratio=increase,crop=${st.w}:${st.h},setsar=1`;
  if (d.bg_style === "solid") return `color=${hex(d.background)}:s=${st.w}x${st.h}:d=1`;
  const stops = d.bg_stops ? d.bg_stops.split(",") : [d.background, d.background_to];
  if (d.bg_style === "mesh") {
    // Four broad radial pools rather than banded concentric stops. Fixed positions
    // make this independent of ffmpeg random state and output frame number.
    const rgb = stops.map(c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)));
    const positions = [[0.1, 0.15], [0.85, 0.15], [0.1, 0.85], [0.85, 0.85]];
    const weights = rgb.map((_, i) => {
      const [x, y] = positions[i % 4]!;
      return `exp(-3*(pow(X/W-${x},2)+pow(Y/H-${y},2)))`;
    });
    const channel = (i: number) => rgb.map((c, j) => `${c[i]}*${weights[j]}`).join("+") + `)/(${weights.join("+")})`;
    return `nullsrc=s=${st.w}x${st.h}:d=1,format=gbrp,geq=r='(${channel(0)}':g='(${channel(1)}':b='(${channel(2)}'`;
  }
  const radial = d.bg_style === "radial";
  return `gradients=s=${st.w}x${st.h}:d=1:${stops.map((c, i) => `c${i}=${hex(c)}`).join(":")}`
    + `:x0=${radial ? Math.round(st.w / 2) : 0}:y0=${radial ? Math.round(st.h / 2) : 0}:x1=${st.w}:y1=${st.h}`
    + `:nb_colors=${stops.length}:seed=0${radial ? ":type=radial" : ""}`;
}

/** Low-contrast stage texture; static coordinates keep rerenders deterministic. */
function backgroundPattern(d: CameraDefaults): string {
  if (d.bg_pattern === "none") return "";
  const line = d.bg_pattern === "grid"
    ? "max(lt(mod(X,48),1),lt(mod(Y,48),1))" : "lt(mod(Y,6),1)";
  return `,geq=lum='lum(X,Y)+6*(${line})':cb='cb(X,Y)':cr='cr(X,Y)'`;
}
