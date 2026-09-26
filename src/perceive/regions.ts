// Change-region perception over decoded grey analysis frames.
// Pure functions over plain data: no Node imports, no I/O.
//
// The decoder (decode.ts) hands us fixed-size grey frames (one byte per pixel,
// row-major). Per consecutive pair: absolute difference thresholded at 12/255,
// a 40x40 analysis-px box around the pointer masked out, dilate 3 px,
// 8-connected components via union-find, components under 64 px dropped.

import type { BBox, FrameRegions, Region } from "../types.ts";

export const DIFF_THRESHOLD = 12; // of 255
export const POINTER_MASK = 40; // analysis px, square box around the pointer
export const DILATE = 3; // analysis px
export const MIN_COMPONENT = 64; // analysis px
export const CUT_FRAC = 0.45;

export interface FramePairOpts {
  /** analysis-frame pixel size */
  w: number;
  h: number;
  /** stream (source) pixel size, for mapping bboxes up */
  streamW: number;
  streamH: number;
  /** pointer position in analysis px at this frame, or null (no pointer source) */
  pointer: [number, number] | null;
}

/**
 * Compare one frame pair and return the surviving change regions.
 * `prev`/`cur` are Uint8Array grey frames of exactly w*h bytes.
 */
export function diffRegions(prev: Uint8Array, cur: Uint8Array, o: FramePairOpts): {
  regions: Region[];
  changed_frac: number;
} {
  const { w, h } = o;
  const n = w * h;
  const diff = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (Math.abs(prev[i]! - cur[i]!) >= DIFF_THRESHOLD) diff[i] = 1;
  }
  if (o.pointer) maskPointer(diff, w, h, o.pointer[0], o.pointer[1]);
  // masked-out pixels never count as change (cursor motion is not change)
  let changed = 0;
  for (let i = 0; i < n; i++) changed += diff[i]!;
  const dilated = dilate(diff, w, h, DILATE);
  const comps = labelComponents(dilated, w, h);
  const scale = o.streamW / w;
  const regions: Region[] = [];
  const screen = o.streamW * o.streamH;
  for (const c of comps) {
    if (c.count < MIN_COMPONENT) continue;
    const bbox: BBox = [
      Math.floor(c.x0 * scale),
      Math.floor(c.y0 * scale),
      Math.ceil((c.x1 + 1) * scale) - Math.floor(c.x0 * scale),
      Math.ceil((c.y1 + 1) * scale) - Math.floor(c.y0 * scale),
    ];
    regions.push({ bbox, area_frac: (c.count * scale * scale) / screen });
  }
  return { regions, changed_frac: changed / n };
}

function maskPointer(diff: Uint8Array, w: number, h: number, px: number, py: number): void {
  const half = POINTER_MASK / 2;
  const x0 = Math.max(0, Math.floor(px - half));
  const y0 = Math.max(0, Math.floor(py - half));
  const x1 = Math.min(w, Math.ceil(px + half));
  const y1 = Math.min(h, Math.ceil(py + half));
  for (let y = y0; y < y1; y++) {
    diff.fill(0, y * w + x0, y * w + x1);
  }
}

/** Square dilation with a (2r+1) structuring element, separable passes. */
function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  // horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = 0;
      const xa = Math.max(0, x - r);
      const xb = Math.min(w - 1, x + r);
      for (let xi = xa; xi <= xb; xi++) {
        if (src[row + xi]) {
          v = 1;
          break;
        }
      }
      tmp[row + x] = v;
    }
  }
  // vertical
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - r);
    const yb = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let yi = ya; yi <= yb; yi++) {
        if (tmp[yi * w + x]) {
          v = 1;
          break;
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

interface Component {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  count: number;
}

/** 8-connected components via union-find over the binary mask. */
export function labelComponents(mask: Uint8Array, w: number, h: number): Component[] {
  const parent = new Int32Array(w * h);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      // 8-neighbours already visited in raster order
      for (let dy = -1; dy <= 0; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dy === 0 && dx >= 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0) continue;
          const j = ny * w + nx;
          if (mask[j]) union(i, j);
        }
      }
      if (x > 0 && mask[i - 1]) union(i, i - 1);
    }
  }
  const stats = new Map<number, Component>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      const root = find(i);
      let c = stats.get(root);
      if (!c) {
        c = { x0: x, y0: y, x1: x, y1: y, count: 0 };
        stats.set(root, c);
      }
      c.count++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
    }
  }
  return [...stats.values()];
}

/**
 * Full perception pass over consecutive decoded frames.
 * `frames` are grey analysis frames in time order; `times` their times in ms on
 * the event clock; `pointers` the pointer position in analysis px per frame
 * (null when the take has no pointer source).
 */
export function perceiveRegions(
  frames: Uint8Array[],
  times: number[],
  pointers: ([number, number] | null)[],
  o: Omit<FramePairOpts, "pointer">,
): FrameRegions[] {
  const out: FrameRegions[] = [];
  if (frames.length === 0) return out;
  out.push({ t: times[0]!, changed_frac: 0, cut: false, regions: [] });
  for (let i = 1; i < frames.length; i++) {
    const { regions, changed_frac } = diffRegions(frames[i - 1]!, frames[i]!, {
      ...o,
      pointer: pointers[i] ?? null,
    });
    out.push({ t: times[i]!, changed_frac, cut: changed_frac >= CUT_FRAC, regions });
  }
  return out;
}
