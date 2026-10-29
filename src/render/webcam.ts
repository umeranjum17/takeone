import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CameraDefaults } from "../camera/defaults.ts";
import type { CameraFrame, TakeMeta } from "../camera/types.ts";

/** The zoom at which the bubble reaches `webcam_shrink`; shallower pushes shrink it part way. */
export const FULL_ZOOM = 2.5;

const smooth = (u: number) => u * u * (3 - 2 * u);

/** The take's webcam clip and where its first frame lands on the screen video's clock, or null for none. */
export function webcamClip(dir: string, meta: TakeMeta, d: CameraDefaults, videoStartMs: number): { file: string; offset: number } | null {
  if (d.webcam === "off") return null;
  if (d.webcam) {
    const file = resolve(dir, d.webcam);
    if (!existsSync(file)) throw new Error(`webcam: ${file} does not exist`);
    return { file, offset: 0 };
  }
  if (!meta.webcam) return null;
  const file = resolve(dir, meta.webcam.file);
  if (!existsSync(file)) throw new Error(`webcam: ${file} is listed in take.json but missing; render with --set webcam=off to drop it`);
  return { file, offset: (meta.webcam.start_ms - videoStartMs) / 1000 };
}

/** Bubble scale on each output frame: 1 at rest, easing to `webcam_shrink` as the camera pushes in. */
export function bubbleScales(frames: CameraFrame[], restW: number, d: CameraDefaults): { t: number; s: number }[] {
  return frames.map(f => ({ t: f.t, s: 1 - (1 - d.webcam_shrink) * smooth(Math.min(1, Math.max(0, (restW / f.w - 1) / (FULL_ZOOM - 1)))) }));
}

/** Fewest breakpoints that keep every sample within `eps` of the line through them (Douglas-Peucker). */
export function breakpoints(points: { t: number; s: number }[], eps: number): { t: number; s: number }[] {
  if (points.length < 3) return points;
  const [a, b] = [points[0]!, points.at(-1)!];
  let worst = 0, at = 0;
  points.forEach((p, i) => {
    const err = Math.abs(a.s + (b.s - a.s) * (p.t - a.t) / (b.t - a.t || 1) - p.s);
    if (err > worst) { worst = err; at = i; }
  });
  if (worst <= eps) return [a, b];
  return [...breakpoints(points.slice(0, at + 1), eps).slice(0, -1), ...breakpoints(points.slice(at), eps)];
}

/** An ffmpeg expression of `t` that follows the breakpoints linearly and holds the ends. */
export function scaleExpr(points: { t: number; s: number }[]): string {
  const f = (n: number) => n.toFixed(5);
  let expr = f(points.at(-1)!.s);
  for (let i = points.length - 2; i >= 0; i--) {
    const [a, b] = [points[i]!, points[i + 1]!];
    expr = `if(lt(t,${f(b.t)}),${f(a.s)}+${f((b.s - a.s) / (b.t - a.t || 1))}*(t-${f(a.t)}),${expr})`;
  }
  return expr;
}

/** Rounded-rectangle signed distance over a w x h box: negative inside, one pixel across the edge. */
const sdf = (w: number, h: number, r: number) =>
  `hypot(max(abs(X-${w / 2}+0.5)-${w / 2 - r},0),max(abs(Y-${h / 2}+0.5)-${h / 2 - r},0))-${r}`;

export interface BubbleSpec {
  /** Input stream label of the webcam clip, such as "3:v". */
  input: string;
  offset: number;
  trimStart: number;
  trimEnd: number;
  /** The same output-clock warp the screen footage gets: idle squeezes, cuts and speed regions.
   * Its `PTS-STARTPTS` re-zeroing is dropped: the clip is already on the screen's clock, offset included. */
  clock: string;
  /** Trailing `,trim=start=...` the screen chain uses when a segment skips its leading frames. */
  from: string;
  frames: CameraFrame[];
  restW: number;
  fps: number;
}

/** The size, margin and pixel box of the bubble at rest. */
export function bubbleBox(d: CameraDefaults): { w: number; h: number; margin: number; radius: number } {
  const short = Math.min(d.out_w, d.out_h);
  const h = Math.round(d.webcam_size * short / 2) * 2;
  const w = d.webcam_shape === "circle" ? h : Math.round(h * 4 / 3 / 2) * 2;
  return { w, h, margin: Math.round(short * 0.04), radius: d.webcam_shape === "circle" ? h / 2 : Math.round(h * 0.18) };
}

/**
 * Filter graph lines that turn the webcam clip into a masked, ringed bubble on the film's clock and
 * shrink it with the camera zoom. The bubble comes out as `[bubble]`; `overlayExpr` places it.
 */
export function bubbleGraph(spec: BubbleSpec, d: CameraDefaults): { lines: string[]; overlay: string } {
  const { w, h, margin, radius } = bubbleBox(d);
  const ring = Math.max(2, Math.round(h / 90));
  const crop = d.webcam_shape === "circle" ? "crop='min(iw,ih)':'min(iw,ih)'" : "crop='min(iw,ih*4/3)':'min(iw*3/4,ih)'";
  const edge = sdf(w, h, radius);
  // The ring blends in over its own inner pixel, and the outer pixel feathers the alpha.
  const rim = `clip((${edge})+${ring}+0.5,0,1)`;
  const mix = (plane: string, ink: number) => `${plane}='${plane}(X,Y)*(1-${rim})+${ink}*${rim}'`;
  const scales = breakpoints(bubbleScales(spec.frames, spec.restW, d), 0.002);
  const e = `trunc(${w}*(${scaleExpr(scales)})/2)*2`;
  const at = {
    br: [`main_w-overlay_w-${margin}`, `main_h-overlay_h-${margin}`], bl: [`${margin}`, `main_h-overlay_h-${margin}`],
    tr: [`main_w-overlay_w-${margin}`, `${margin}`], tl: [`${margin}`, `${margin}`],
  }[d.webcam_corner];
  return {
    lines: [
      `[${spec.input}]setpts=PTS+${spec.offset.toFixed(6)}/TB,trim=start=${spec.trimStart}:end=${spec.trimEnd},setpts=PTS-${spec.trimStart}/TB,`
        + `${spec.clock.replaceAll("PTS-STARTPTS", "PTS")},fps=${spec.fps}${spec.from},${crop},scale=${w}:${h}:flags=lanczos,format=yuva444p,`
        + `geq=${mix("lum", 235)}:${mix("cb", 128)}:${mix("cr", 128)}:a='255*clip(0.5-(${edge}),0,1)'[bubbleMax]`,
      `[bubbleMax]scale=w='${e}':h=-1:eval=frame:flags=lanczos[bubble]`,
    ],
    overlay: `overlay=x='${at[0]}':y='${at[1]}':eof_action=pass:format=auto`,
  };
}
