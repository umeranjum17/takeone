import type { CameraDefaults } from "../camera/defaults.ts";
import type { CameraFrame } from "../camera/types.ts";

/**
 * ffmpeg reparses perspective expressions every frame. Keep a compact piecewise
 * linear path, with at most 0.001 working-pixel error at any sampled corner.
 * Balanced lookup also keeps parser depth logarithmic on long takes.
 */
export function frameExpr(values: number[], tolerance = 0.001): string {
  if (values.length === 1) return values[0]!.toFixed(9);
  const knots = [0];
  const simplify = (lo: number, hi: number): void => {
    const slope = (values[hi]! - values[lo]!) / (hi - lo);
    let worst = tolerance;
    let split = -1;
    for (let i = lo + 1; i < hi; i++) {
      const error = Math.abs(values[i]! - values[lo]! - (i - lo) * slope);
      if (error > worst) { worst = error; split = i; }
    }
    if (split < 0) { knots.push(hi); return; }
    simplify(lo, split);
    simplify(split, hi);
  };
  simplify(0, values.length - 1);
  const lookup = (lo: number, hi: number): string => {
    if (hi - lo === 1) {
      const a = knots[lo]!;
      const b = knots[hi]!;
      const slope = (values[b]! - values[a]!) / (b - a);
      // perspective's input frame counter starts at one.
      return `${values[a]!.toFixed(9)}+clip(in-1-${a},0,${b - a})*${slope.toFixed(9)}`;
    }
    const mid = Math.floor((lo + hi) / 2);
    return `if(lt(in-1,${knots[mid]}),${lookup(lo, mid)},${lookup(mid, hi)})`;
  };
  return lookup(0, knots.length - 1);
}

/** Subpixel source warp; master supersamples at 2x before Lanczos downsampling. */
export function cameraFilter(frames: CameraFrame[], width: number, height: number, d: CameraDefaults, tolerance = 0.001): string {
  const factor = d.quality === "master" ? 2 : 1;
  const w = d.out_w * factor;
  const h = d.out_h * factor;
  const interpolation = d.quality === "draft" ? "linear" : "cubic";
  const x0 = frameExpr(frames.map((f) => f.x * w / width), tolerance);
  const y0 = frameExpr(frames.map((f) => f.y * h / height), tolerance);
  const x1 = frameExpr(frames.map((f) => (f.x + f.w) * w / width), tolerance);
  const y1 = frameExpr(frames.map((f) => (f.y + f.h) * h / height), tolerance);
  return `scale=${w}:${h}:flags=lanczos,perspective=x0='${x0}':y0='${y0}'`
    + `:x1='${x1}':y1='${y0}':x2='${x0}':y2='${y1}':x3='${x1}':y3='${y1}'`
    + `:sense=source:eval=frame:interpolation=${interpolation},`
    + (factor === 1 ? "" : `scale=${d.out_w}:${d.out_h}:flags=lanczos,`) + "setsar=1";
}
