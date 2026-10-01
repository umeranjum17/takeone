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

/** A flat-to-flat transform is an affine crop: no rotation or lens distortion.
 * v360 samples the native stage directly into export pixels with Lanczos.
 * RGB16 preserves fractional colour/edge precision until the final conversion.
 * Its normalized coordinates use (input size - 1) and output pixel centres.
 */
export function cameraFilter(frames: CameraFrame[], width: number, height: number, d: CameraDefaults): string {
  const degrees = (range: number) => 2 * Math.atan(range) * 180 / Math.PI;
  const parameters = (f: CameraFrame) => ({
    h_fov: degrees(f.w / (width - 1)),
    v_fov: degrees(f.h / (height - 1)),
    h_offset: 2 * (f.x + f.w / 2 - 0.5) / (width - 1) - 1,
    v_offset: 2 * (f.y + f.h / 2 - 0.5) / (height - 1) - 1,
  });
  const first = frames[0];
  if (!first || width < 2 || height < 2) throw new Error("invalid camera surface");
  const initial = parameters(first);
  let previous = first;
  let applied = Object.fromEntries(Object.entries(initial).map(([key, value]) => [key, value.toFixed(10)]));
  const commands: string[] = [];
  for (const f of frames.slice(1)) {
    // Ignore only sub-millipixel spring tails; no whole-pixel camera quantization.
    const error = Math.max(Math.abs(f.x - previous.x),
      Math.abs(f.w - previous.w)) * d.out_w / f.w;
    const verticalError = Math.max(Math.abs(f.y - previous.y), Math.abs(f.h - previous.h)) * d.out_h / f.h;
    if (Math.max(error, verticalError) < 0.001) continue;
    const values = parameters(f);
    const next = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.toFixed(10)]));
    const updates = Object.entries(next).filter(([key, value]) => value !== applied[key])
      .map(([key, value]) => `v360 ${key} ${value}`).join(",");
    if (!updates) continue;
    // Put updates between frame timestamps so decimal rounding cannot delay a move by one frame.
    commands.push(`${Math.max(0, f.t - 0.5 / d.fps).toFixed(9)} ${updates}`);
    previous = f;
    applied = next;
  }
  const control = commands.length ? `sendcmd=commands='${commands.join(";")};',` : "";
  const settings = Object.entries(initial).map(([key, value]) => `${key}=${value.toFixed(10)}`).join(":");
  // Lanczos normalizes its kernel coefficients, preserving flat card colours.
  return `format=gbrp16le,${control}v360=input=flat:output=flat:w=${d.out_w}:h=${d.out_h}:ih_fov=90:iv_fov=90:${settings}`
    + `:interp=${d.quality === "draft" ? "linear" : "lanczos"},setsar=1`;
}

