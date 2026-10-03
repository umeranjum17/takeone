import type { CameraDefaults } from "../camera/defaults.ts";
import type { CameraFrame } from "../camera/types.ts";

/**
 * Compact piecewise-linear lookup for shutter sample counts and exposure ends.
 * Approximation stays within tolerance in the supplied values' units; balanced
 * lookup keeps ffmpeg expression parser depth logarithmic on long takes.
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
      // Callers replace the legacy one-based `in-1` token with their frame index.
      return `${values[a]!.toFixed(9)}+clip(in-1-${a},0,${b - a})*${slope.toFixed(9)}`;
    }
    const mid = Math.floor((lo + hi) / 2);
    return `if(lt(in-1,${knots[mid]}),${lookup(lo, mid)},${lookup(mid, hi)})`;
  };
  return lookup(0, knots.length - 1);
}

/** Affine camera reconstruction with exact source-pixel area coverage.
 * FFmpeg geq prefix sums use doubles. Bilinear interpolation of the integral
 * image gives fractional rectangle coverage with nonnegative, unit-sum weights;
 * the only colour clamp occurs after division by the covered area.
 */
export function cameraFilter(frames: CameraFrame[], width: number, height: number, d: CameraDefaults): string {
  if (!frames.length || width < 2 || height < 2) throw new Error("invalid camera surface");
  const path = (key: "x" | "y" | "w" | "h") => frameExpr(frames.map(f => f[key]), 0.000001).replaceAll("in-1", "N");
  // Keep geq's input pixels intact. Only the output-sized upper-left rectangle
  // is evaluated; crop removes the unused part of the source-sized canvas.
  const bounds = `st(0,${path("w")}/${d.out_w});st(1,${path("h")}/${d.out_h});`
    + `st(2,${path("x")}+(X+0.5)*ld(0));st(3,${path("y")}+(Y+0.5)*ld(1));`
    + `st(4,clip(ld(2)-max(1,ld(0))/2,0,${width}));`
    + `st(5,clip(ld(2)+max(1,ld(0))/2,0,${width}));`
    + `st(6,clip(ld(3)-max(1,ld(1))/2,0,${height}));`
    + `st(7,clip(ld(3)+max(1,ld(1))/2,0,${height}));`;
  const channel = (c: string) => {
    // S(i,j) includes pixel (i,j). S(-1,j)=S(i,-1)=0, so
    // interpolating S at (edgeX-1,edgeY-1) integrates from zero to that edge.
    const integral = (x: number, y: number) => {
      const a = `ld(${x})`, b = `ld(${y})`;
      const fx = `(${a}-floor(${a}))`, fy = `(${b}-floor(${b}))`;
      const sum = (dx: number, dy: number) => `${c}sum(floor(${a})-${1 - dx},floor(${b})-${1 - dy})`;
      return `((1-${fx})*(1-${fy})*${sum(0,0)}+${fx}*(1-${fy})*${sum(1,0)}`
        + `+(1-${fx})*${fy}*${sum(0,1)}+${fx}*${fy}*${sum(1,1)})`;
    };
    return `${c}='if(lt(X,${d.out_w})*lt(Y,${d.out_h}),${bounds}`
      + `clip((${integral(5,7)}-${integral(4,7)}-${integral(5,6)}+${integral(4,6)})/((ld(5)-ld(4))*(ld(7)-ld(6))),0,65535),0)'`;
  };
  return `format=gbrp16le,pad=${Math.max(width,d.out_w)}:${Math.max(height,d.out_h)}:0:0,`
    + `geq=${["r","g","b"].map(channel).join(":")},crop=${d.out_w}:${d.out_h}:0:0,setsar=1`;
}
