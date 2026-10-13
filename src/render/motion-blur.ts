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

/** Margin around the sampled windows: covers the warp's Lanczos taps (2 px), the
 * 4:2:0 chroma upsampling in the RGB16 conversion and the prefilter blur's tail. */
const READ_MARGIN = 16;

/** Even-aligned surface box that holds every sample window plus READ_MARGIN, or
 * null when that is the whole surface. The pixels the warp reads are the same
 * whether the surface is cropped to it before conversion or not. */
function readBox(frames: CameraFrame[], width: number, height: number): { x: number; y: number; w: number; h: number } | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const f of frames) {
    left = Math.min(left, f.x); top = Math.min(top, f.y);
    right = Math.max(right, f.x + f.w); bottom = Math.max(bottom, f.y + f.h);
  }
  const x = Math.max(0, 2 * Math.floor((left - READ_MARGIN) / 2));
  const y = Math.max(0, 2 * Math.floor((top - READ_MARGIN) / 2));
  const w = Math.min(width, 2 * Math.ceil((right + READ_MARGIN) / 2)) - x;
  const h = Math.min(height, 2 * Math.ceil((bottom + READ_MARGIN) / 2)) - y;
  // An odd edge cannot be cropped exactly in 4:2:0; keep the whole surface then.
  return (w < width || h < height) && w % 2 === 0 && h % 2 === 0 ? { x, y, w, h } : null;
}

/** Crop the composed surface to what the camera reads and convert it to RGB16
 * once per source frame, ahead of the shutter resampling, then warp. A
 * crop-to-fill export samples a small window of a tall card, and every motion
 * blur sample used to convert the whole card. */
function warpGraph(frames: CameraFrame[], width: number, height: number, d: CameraDefaults): { input: string; warp: string } {
  const box = readBox(frames, width, height);
  if (!box) return { input: "format=gbrp16le,", warp: cameraFilter(frames, width, height, d) };
  return {
    input: `crop=${box.w}:${box.h}:${box.x}:${box.y},format=gbrp16le,`,
    warp: cameraFilter(frames.map(f => ({ ...f, x: f.x - box.x, y: f.y - box.y })), box.w, box.h, d),
  };
}

/** Duplicate source images by reference, discard unneeded samples before the
 * warp, and average only each exposure's samples. One chronological stream
 * avoids buffering whole shots across parallel velocity branches.
 */
export function motionBlurGraph(frames: CameraFrame[], plan: ReturnType<typeof shutterPlan>, width: number, height: number, d: CameraDefaults): string {
  if (!plan.metrics.blurredFrames) {
    const { input, warp } = warpGraph(frames, width, height, d);
    return `[c4]${input}${warp}[camera]`;
  }
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
  const { input, warp } = warpGraph(sampled.map((f, i) => ({ ...f, t: i / (d.fps * plan.samples) })), width, height,
    { ...d, fps: d.fps * plan.samples });
  // Pad before resampling: older fps filters can discard the last image at EOF.
  return `[c4]${input}tpad=stop_mode=clone:stop=1,fps=${d.fps * plan.samples}:round=up:start_time=0,`
    + `trim=end_frame=${frames.length * plan.samples},select='lt(mod(n,${plan.samples}),round(${countExpr}))',`
    + `setpts=N/(${d.fps * plan.samples}*TB),${warp},`
    + `sendcmd=c='${commands.join(";")}',tmix@shutter=frames=${plan.samples + 1}:enable='${endExpr}',`
    + `select='${endExpr}',settb=AVTB,setpts=N/(${d.fps}*TB)[camera]`;
}
