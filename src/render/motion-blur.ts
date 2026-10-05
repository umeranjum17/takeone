import type { CameraDefaults } from "../camera/defaults.ts";
import type { CameraFrame } from "../camera/types.ts";
import { cameraFilter, frameExpr } from "./camera-filter.ts";
import { boxAverageWeights } from "./frame-average.ts";

/** Linear interpolation of the solved output-clock path, clamped at bookends. */
export function shutterFrame(frames: CameraFrame[], index: number): CameraFrame {
  const at = Math.max(0, Math.min(frames.length - 1, index));
  const a = frames[Math.floor(at)]!;
  const b = frames[Math.ceil(at)]!;
  const u = at % 1;
  return { t: a.t + (b.t - a.t) * u, x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u, w: a.w + (b.w - a.w) * u, h: a.h + (b.h - a.h) * u };
}

/** Maximum screen-space displacement of any point on the stage. */
function displacement(a: CameraFrame, b: CameraFrame, width: number, height: number, d: CameraDefaults): number {
  let max = 0;
  for (const x of [0, width]) for (const y of [0, height]) {
    max = Math.max(max, Math.hypot(((x - a.x) / a.w - (x - b.x) / b.w) * d.out_w,
      ((y - a.y) / a.h - (y - b.y) / b.h) * d.out_h));
  }
  return max;
}

function pathDisplacements(frames: CameraFrame[], from: number, to: number, width: number, height: number, d: CameraDefaults): number[] {
  const points = [from];
  for (let i = Math.floor(from) + 1; i < to; i++) points.push(i);
  points.push(to);
  return points.slice(1).map((point, i) => displacement(shutterFrame(frames, points[i]!), shutterFrame(frames, point), width, height, d));
}

export function shutterPlan(frames: CameraFrame[], width: number, height: number, d: CameraDefaults) {
  const half = d.motion_blur / 4; // 180 degrees at strength 1
  const groups = new Map<number, number[]>();
  const counts: number[] = [];
  let maxSpacing = 0;
  let work = 0;
  let blurredFrames = 0;
  let samples = 1;
  for (let i = 0; i < frames.length; i++) {
    const span = pathDisplacements(frames, i - half, i + half, width, height, d).reduce((sum, part) => sum + part, 0);
    let count = span <= 2 ? 1 : Math.ceil(span / 2) + 1;
    const spacing = (n: number): number => {
      let max = 0;
      for (let j = 1; j < n; j++) {
        const from = i - half + 2 * half * (j - 1) / (n - 1);
        const to = i - half + 2 * half * j / (n - 1);
        max = Math.max(max, ...pathDisplacements(frames, from, to, width, height, d));
      }
      return max;
    };
    if (count > 1023) throw new Error("camera shutter needs more than 1023 samples; reduce motion_blur or camera speed");
    let gap = spacing(count);
    while (gap > 2 && count < 1023) gap = spacing(++count);
    if (gap > 2) throw new Error("camera shutter needs more than 1023 samples; reduce motion_blur or camera speed");
    counts.push(count);
    maxSpacing = Math.max(maxSpacing, gap);
    const indices = groups.get(count) ?? [];
    indices.push(i);
    groups.set(count, indices);
    work += count;
    if (count > 1) blurredFrames++;
    samples = Math.max(samples, count);
  }
  return { groups, counts, samples, half, metrics: { strength: d.motion_blur, shutterDegrees: 180 * d.motion_blur,
    frames: frames.length, blurredFrames, samples, maxSpacingPx: maxSpacing,
    warpWorkRatio: work / frames.length,
    tiers: [...groups].map(([samples, indices]) => ({ samples, frames: indices.length })) } };
}

export function shutterFrames(frames: CameraFrame[], plan: ReturnType<typeof shutterPlan>, index: number): CameraFrame[] {
  const count = plan.counts[index]!;
  return Array.from({ length: count }, (_, j) => count === 1 ? frames[index]!
    : shutterFrame(frames, index - plan.half + 2 * plan.half * j / (count - 1)));
}

/** Duplicate source images by reference, discard unneeded samples before the
 * warp, and average only each exposure's samples. One chronological stream
 * avoids buffering whole shots across parallel velocity branches.
 */
export function motionBlurGraph(frames: CameraFrame[], plan: ReturnType<typeof shutterPlan>, width: number, height: number, d: CameraDefaults): string {
  if (!plan.metrics.blurredFrames) return `[c4]${cameraFilter(frames, width, height, d)}[camera]`;
  const counts = plan.counts;
  const sampled: CameraFrame[] = [];
  const ends: number[] = [];
  const commands: string[] = [];
  let previous = 0;
  for (let i = 0; i < frames.length; i++) {
    const count = counts[i]!;
    if (count !== previous) {
      // tmix stores oldest first. Keep one extra zero-weight slot so its
      // equal-weight running-sum shortcut cannot reuse skipped-frame sums.
      // Zero every sample from earlier exposures.
      const weights = boxAverageWeights(count, plan.samples + 1).weights.join("|");
      commands.push(`${(Math.max(0, sampled.length - 0.5) / (d.fps * plan.samples)).toFixed(9)} tmix@shutter weights ${weights}`);
      previous = count;
    }
    for (const [j, frame] of shutterFrames(frames, plan, i).entries()) {
      sampled.push(frame);
      ends.push(j === count - 1 ? 1 : 0);
    }
  }
  const countExpr = frameExpr(counts).replaceAll("in-1", `floor(n/${plan.samples})`);
  const endExpr = `eq(round(${frameExpr(ends).replaceAll("in-1", "n")}),1)`;
  // Pad before resampling: older fps filters can discard the last image at EOF.
  return `[c4]tpad=stop_mode=clone:stop=1,fps=${d.fps * plan.samples}:round=up:start_time=0,`
    + `trim=end_frame=${frames.length * plan.samples},select='lt(mod(n,${plan.samples}),round(${countExpr}))',`
    + `setpts=N/(${d.fps * plan.samples}*TB),${cameraFilter(sampled.map((f, i) => ({ ...f, t: i / (d.fps * plan.samples) })), width, height, { ...d, fps: d.fps * plan.samples })},`
    + `sendcmd=c='${commands.join(";")}',tmix@shutter=frames=${plan.samples + 1}:enable='${endExpr}',`
    + `select='${endExpr}',settb=AVTB,setpts=N/(${d.fps}*TB)[camera]`;
}

/** Actual-scale anti-alias cover before each warp; symmetric signed Q14 Lanczos-2. */
export function areaPrefilter(frames: CameraFrame[], plan: ReturnType<typeof shutterPlan>, width: number, height: number, d: CameraDefaults): string {
  const sampled = plan.metrics.blurredFrames ? frames.flatMap((_, i) => shutterFrames(frames, plan, i)) : frames;
  const fps = d.fps * (plan.metrics.blurredFrames ? plan.samples : 1);
  const TAPS = 19, HALF = (TAPS - 1) / 2, Q = 16384;
  const sinc = (x: number): number => x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
  const kernel = (s: number): number[] => {
    if (!Number.isFinite(s) || s <= 0 || s > 5) throw new Error(`area prefilter scale ${s} exceeds kernel domain (0,5]`);
    if (s <= 1) return [...Array(HALF).fill(0), Q, ...Array(HALF).fill(0)];
    // Lanczos-2 windowed sinc at the shrink factor: flat passband and steep
    // stopband, so the warp's own Lanczos stage stops double-blurring the frame.
    const shape = Array.from({ length: TAPS }, (_, i) => { const k = i - HALF;
      return Math.abs(k) < 2 * s ? sinc(k / s) * sinc(k / (2 * s)) : 0; });
    const sum = shape.reduce((a, b) => a + b, 0);
    const base = shape.map(v => (v * Q) / sum);
    const integers = base.map(v => Math.round(v));
    let residual = Q - integers.reduce((a, b) => a + b, 0);
    while (Math.abs(residual) > 1) {
      const step = Math.sign(residual);
      let best = 1, bestErr = -Infinity;
      for (let dist = 1; dist <= HALF; dist++) {
        const err = step * (base[HALF + dist]! - integers[HALF + dist]!);
        if (err > bestErr) { bestErr = err; best = dist; }
      }
      integers[HALF + best]! += step; integers[HALF - best]! += step; residual -= 2 * step;
    }
    integers[HALF]! += residual;
    if (integers.reduce((a, b) => a + Math.abs(b), 0) * 65535 > 2147483647) throw new Error(`area prefilter accumulation exceeds 32 bits at scale ${s}`);
    if (integers.some((v, i) => Math.abs(v / Q - shape[i]! / sum) > 2 / Q)) throw new Error(`area prefilter coefficient bound failed at scale ${s}`);
    return integers;
  };
  const commands: string[] = [];
  const filters: string[] = [];
  for (const [axis, dimension, output] of [["x", "w", d.out_w], ["y", "h", d.out_h]] as const) {
    const matrices = sampled.map(f => kernel(f[dimension] / output).join(" "));
    const target = `convolution@area${axis}`;
    // Stock column slicing needs 32 px per slice; extra columns are independent.
    if (axis === "y" && width < 256) filters.push("pad=256:ih:0:0");
    filters.push(`${target}=` + [0, 1, 2].map(p => `${p}mode=${axis === "x" ? "row" : "column"}:${p}m='${matrices[0]}'`).join(":"));
    if (axis === "y" && width < 256) filters.push(`crop=${width}:${height}:0:0:exact=1`);
    for (let i = 1; i < matrices.length; i++) {
      if (matrices[i] === matrices[i - 1]) continue;
      const t = plan.metrics.blurredFrames ? i / fps : sampled[i]!.t;
      const matrix = matrices[i]!.replaceAll(" ", "\\\\ ");
      commands.push(`${Math.max(0, t - 0.5 / fps).toFixed(9)} ` + [0, 1, 2].map(p => `${target} ${p}m ${matrix}`).join(","));
    }
  }
  const control = commands.length ? `sendcmd=c='${commands.join(";")};',` : "";
  return motionBlurGraph(frames, plan, width, height, d).replace("format=gbrp16le,", `format=gbrp16le,${control}${filters.join(",")},`);
}
