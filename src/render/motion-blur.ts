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
    maxSpacing = Math.max(maxSpacing, gap);
    const indices = groups.get(count) ?? [];
    indices.push(i);
    groups.set(count, indices);
    work += count;
    if (count > 1) blurredFrames++;
    samples = Math.max(samples, count);
  }
  return { groups, samples, half, metrics: { strength: d.motion_blur, shutterDegrees: 180 * d.motion_blur,
    frames: frames.length, blurredFrames, samples, maxSpacingPx: maxSpacing,
    warpWorkRatio: work / frames.length,
    tiers: [...groups].map(([samples, indices]) => ({ samples, frames: indices.length })) } };
}

/** Duplicate source images by reference, discard unneeded samples before the
 * warp, and average only each exposure's samples. One chronological stream
 * avoids buffering whole shots across parallel velocity branches.
 */
export function motionBlurGraph(frames: CameraFrame[], plan: ReturnType<typeof shutterPlan>, width: number, height: number, d: CameraDefaults): string {
  if (!plan.metrics.blurredFrames) return `[c4]${cameraFilter(frames, width, height, d)}[camera]`;
  const counts = frames.map(() => 1);
  for (const [count, indices] of plan.groups) for (const i of indices) counts[i] = count;
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
    for (let j = 0; j < count; j++) {
      sampled.push(count === 1 ? frames[i]! : shutterFrame(frames, i - plan.half + 2 * plan.half * j / (count - 1)));
      ends.push(j === count - 1 ? 1 : 0);
    }
  }
  const countExpr = frameExpr(counts).replaceAll("in-1", `floor(n/${plan.samples})`);
  const endExpr = `eq(round(${frameExpr(ends).replaceAll("in-1", "n")}),1)`;
  return `[c4]fps=${d.fps * plan.samples}:round=up:start_time=0,tpad=stop_mode=clone:stop=${plan.samples},`
    + `trim=end_frame=${frames.length * plan.samples},select='lt(mod(n,${plan.samples}),round(${countExpr}))',`
    + `setpts=N/(${d.fps * plan.samples}*TB),${cameraFilter(sampled.map((f, i) => ({ ...f, t: i / (d.fps * plan.samples) })), width, height, { ...d, fps: d.fps * plan.samples })},`
    + `sendcmd=c='${commands.join(";")}',tmix@shutter=frames=${plan.samples + 1}:enable='${endExpr}',`
    + `select='${endExpr}',settb=AVTB,setpts=N/(${d.fps}*TB)[camera]`;
}

/** A fixed-support reconstruction kernel aliases hard edges whenever the view
 * minifies the composite (more source texels than output pixels per axis).
 * Area-averaging the composite to ~1/gate, upsampling it back and letting the
 * unchanged warp sample that restores coverage for minified frames (measured
 * RMS 0.10 vs 0.28); magnified frames keep the untouched raw pixels, so zoomed
 * text is never filtered. */
export function cameraGraph(frames: CameraFrame[], plan: ReturnType<typeof shutterPlan>, width: number, height: number, d: CameraDefaults, gate = 1.45): string {
  const w = Math.round(width / gate), h = Math.round(height / gate);
  const minified = frames.map(f => f.w / d.out_w >= width / w - 1e-9 && f.h / d.out_h >= height / h - 1e-9);
  if (!minified.some(Boolean)) return motionBlurGraph(frames, plan, width, height, d);
  // Switch branches between frame timestamps so decimal rounding cannot delay a flip.
  const hidden = -width; // overlay x parks the raw layer off-frame while minified
  let expr = String(minified.at(-1) ? hidden : 0);
  for (let i = frames.length - 1; i > 0; i--) {
    if (minified[i] === minified[i - 1]) continue;
    expr = `if(lt(t,${Math.max(0, frames[i]!.t - 0.5 / d.fps).toFixed(9)}),${minified[i] ? 0 : hidden},${expr})`;
  }
  return `[c4]split=2[pf][praw];[pf]scale=${w}:${h}:flags=area,scale=${width}:${height}:flags=bilinear[pup];`
    + `[pup][praw]overlay=x='${expr}':y=0:shortest=1[camin];`
    + motionBlurGraph(frames, plan, width, height, d).replaceAll("[c4]", "[camin]");
}
