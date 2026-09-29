// Shared synthetic fixtures for the planner tests. Everything is generated in
// code; the only external binary used is ffmpeg, for one tiny webm.

import type { Event, FrameRegions, Region } from "../src/types.ts";
import { execFileSync } from "node:child_process";

let ffmpegCache: boolean | undefined;
/** True when system ffmpeg+ffprobe are on PATH; video tests skip explicitly otherwise. */
export function hasFfmpeg(): boolean {
  ffmpegCache ??= ((): boolean => {
    try {
      execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
      execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  return ffmpegCache;
}

export const STREAM = { w: 160, h: 120 };

export function greyFrame(w: number, h: number, fill = 0): Uint8Array {
  return new Uint8Array(w * h).fill(fill);
}

/** Draw a filled box into a grey frame. */
export function drawBox(f: Uint8Array, w: number, h: number, x: number, y: number, bw: number, bh: number, v = 255): void {
  for (let yy = y; yy < Math.min(h, y + bh); yy++) {
    for (let xx = x; xx < Math.min(w, x + bw); xx++) f[yy * w + xx] = v;
  }
}

export function region(bbox: [number, number, number, number], t: number, areaFrac?: number): FrameRegions {
  const [x, y, w, h] = bbox;
  const r: Region = { bbox, area_frac: areaFrac ?? (w * h) / (STREAM.w * STREAM.h) };
  return { t, changed_frac: 0.01, cut: false, regions: [r] };
}

/** A minimal event stream: focus, then a click at (x,y). */
export function clickEvents(x: number, y: number, t = 500): Event[] {
  return [
    { t: 0, k: "win", cls: "chromium", title: "Doc", rect: [0, 0, STREAM.w, STREAM.h] },
    { t: t - 50, k: "ptr", x, y },
    { t, k: "btn", b: "left", down: true },
    { t: t + 60, k: "btn", b: "left", down: false },
  ];
}

export function noopFrames(count: number, startT = 0, stepMs = 100): FrameRegions[] {
  return Array.from({ length: count }, (_, i) => ({
    t: startT + i * stepMs,
    changed_frac: 0,
    cut: false,
    regions: [],
  }));
}
