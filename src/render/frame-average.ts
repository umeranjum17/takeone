// Shared, deterministic integer averaging for camera and motion subframe accumulation.
export interface PixelFrame { width: number; height: number; channels: 3 | 4; data: Uint8Array }

/** The box exposure shared by raw motion frames and ffmpeg's camera tmix filter.
 * Leading zero slots isolate the current exposure from earlier samples. */
export function boxAverageWeights(count: number, slots = count): { weights: number[]; divisor: number } {
  if (!Number.isInteger(count) || !Number.isInteger(slots) || count < 1 || slots < count) throw new Error("invalid box exposure size");
  return { weights: Array.from({ length: slots }, (_, i) => i < slots - count ? 0 : 1), divisor: count };
}

/** Equally weighted box average, round half up. Input dimensions and channel layouts must match. */
export function averageRaw(frames: PixelFrame[]): PixelFrame {
  const [first] = frames;
  if (!first) throw new Error("no frames to average");
  for (const frame of frames) if (frame.width !== first.width || frame.height !== first.height || frame.channels !== first.channels || frame.data.length !== first.data.length) throw new Error("sub-frame size mismatch");
  const n = boxAverageWeights(frames.length).divisor, sum = new Uint32Array(first.data.length);
  for (const frame of frames) for (let i = 0; i < sum.length; i++) sum[i]! += frame.data[i]!;
  const data = new Uint8Array(sum.length);
  for (let i = 0; i < sum.length; i++) data[i] = Math.floor((sum[i]! * 2 + n) / (2 * n));
  return { ...first, data };
}
