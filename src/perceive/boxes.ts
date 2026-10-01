// Local UI-surface boundaries, independent of temporal change perception.
// Product-specific framing hints, not semantic recognition or a model backend.
import type { BBox, FrameRegions } from "../types.ts";
import { bboxArea, bboxIoU, clampBBox } from "../types.ts";
import type { Decoded } from "./decode.ts";

export interface BoxFrame { t: number; boxes: BBox[] }
export const BOX_INTERVAL_MS = 1000;
export const BOX_MAX_PER_FRAME = 24;

/** Flat, connected surfaces with rectangular occupancy survive text holes and rounded corners.
 * Text, tiny controls, scrims and the screen background are deliberately excluded.
 * Uses the existing quarter-size grey decode; supports both light and dark surfaces.
 */
export function detectUiBoxes(data: Uint8Array, w: number, h: number, streamW: number, streamH: number): BBox[] {
  if (data.length !== w * h) throw new Error("UI box frame size mismatch");
  const seen = new Uint8Array(data.length);
  const queue = new Int32Array(data.length);
  const boxes: BBox[] = [];
  for (let seed = 0; seed < data.length; seed++) {
    if (seen[seed]) continue;
    const shade = data[seed]!;
    let head = 0, tail = 1;
    queue[0] = seed;
    seen[seed] = 1;
    let x0 = seed % w, x1 = x0, y0 = Math.floor(seed / w), y1 = y0;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % w, y = Math.floor(i / w);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      const visit = (j: number): void => {
        if (!seen[j] && Math.abs(data[j]! - shade) <= 3) {
          seen[j] = 1;
          queue[tail++] = j;
        }
      };
      if (x > 0) visit(i - 1);
      if (x + 1 < w) visit(i + 1);
      if (y > 0) visit(i - w);
      if (y + 1 < h) visit(i + w);
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const area = bw * bh;
    if (bw < Math.max(16, w * .04) || bh < Math.max(12, h * .025)
      || area < w * h * .002 || area > w * h * .5 || tail / area < .6) continue;
    // Two analysis pixels cover the antialias/border fringe, preserving the outer box.
    const box = clampBBox([(x0 - 2) * streamW / w, (y0 - 2) * streamH / h,
      (bw + 4) * streamW / w, (bh + 4) * streamH / h], streamW, streamH);
    if (box) boxes.push(box);
  }
  return boxes.sort((a, b) => bboxArea(b) - bboxArea(a))
    .filter((box, i, all) => !all.slice(0, i).some(b => bboxIoU(box, b) > .9))
    .slice(0, BOX_MAX_PER_FRAME);
}

/** One reference per occupied second, preferring shot anchors over the cadence frame.
 * At most ceil(duration seconds) references; no extra decode or network/model calls.
 */
export function analyzeUiBoxes(dec: Decoded, stream: { w: number; h: number }, start: number, end: number,
  anchors: number[]): { frames: BoxFrame[]; cost: { references: number; references_per_minute: number;
    elapsed_ms: number; analysis_ms_per_minute: number; model_calls: number; usd_per_minute: number } } {
  const began = performance.now();
  const frames: BoxFrame[] = [];
  const preferred = new Map<number, number>();
  for (const t of anchors) {
    if (t >= start && t < end) {
      const bucket = Math.floor((t - start) / BOX_INTERVAL_MS);
      if (!preferred.has(bucket)) preferred.set(bucket, t);
    }
  }
  let cursor = 0;
  for (let from = start; from < end; from += BOX_INTERVAL_MS) {
    const until = Math.min(end, from + BOX_INTERVAL_MS);
    const target = preferred.get(Math.floor((from - start) / BOX_INTERVAL_MS)) ?? from;
    while (cursor < dec.frames.length && dec.frames[cursor]!.t < from) cursor++;
    let selected = cursor;
    for (let i = cursor; i < dec.frames.length && dec.frames[i]!.t < until; i++) {
      if (Math.abs(dec.frames[i]!.t - target) < Math.abs((dec.frames[selected]?.t ?? Infinity) - target)) selected = i;
    }
    const f = dec.frames[selected];
    if (!f || f.t >= until) continue;
    frames.push({ t: f.t, boxes: detectUiBoxes(f.data, dec.w, dec.h, stream.w, stream.h) });
  }
  const elapsed_ms = performance.now() - began;
  const minutes = (end - start) / 60000;
  return { frames, cost: { references: frames.length, references_per_minute: frames.length / minutes,
    elapsed_ms, analysis_ms_per_minute: elapsed_ms / minutes, model_calls: 0, usd_per_minute: 0 } };
}

/** Never borrow a surface across a cut/redraw, or from a distant reference. */
export function uiBoxesAt(frames: BoxFrame[], changes: FrameRegions[], at: number): BBox[] {
  let nearest: BoxFrame | undefined;
  for (const frame of frames) {
    if (Math.abs(frame.t - at) <= 500 && (!nearest || Math.abs(frame.t - at) < Math.abs(nearest.t - at))) nearest = frame;
  }
  if (!nearest) return [];
  const from = Math.min(at, nearest.t), to = Math.max(at, nearest.t);
  if (changes.some(f => f.t > from && f.t <= to && (f.cut || f.changed_frac >= .015))) return [];
  return nearest.boxes;
}
