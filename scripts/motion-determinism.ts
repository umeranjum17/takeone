#!/usr/bin/env node
// Determinism check for two renders of the same storyboard: the same frame count and size, and every
// frame within MIN_FRAME_PSNR of its twin. HyperFrames renders are not bit-exact (decoder and GPU-free
// raster rounding move a few low bits), so this is the tolerance, not md5 equality.
// usage: node scripts/motion-determinism.ts <a.mp4> <b.mp4>
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Lowest per-frame PSNR (dB, average of Y/U/V) two renders of one storyboard may show. 50 dB is far below visible. */
export const MIN_FRAME_PSNR = 50;

export interface Determinism { frames: number; differing: number; minPsnr: number; ok: boolean }

const threads = String(process.env["TAKEONE_RENDER_THREADS"] ?? 2);

function frameHashes(file: string): string[] {
  return execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-threads", threads, "-i", file, "-map", "0:v", "-f", "framemd5", "-"], { encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\n").filter(l => l && !l.startsWith("#")).map(l => l.split(",").at(-1)!.trim());
}

export function compareRenders(a: string, b: string): Determinism {
  const ha = frameHashes(a), hb = frameHashes(b);
  if (ha.length !== hb.length) return { frames: Math.max(ha.length, hb.length), differing: Math.abs(ha.length - hb.length), minPsnr: 0, ok: false };
  const differing = ha.filter((h, i) => h !== hb[i]).length;
  let minPsnr = Infinity;
  if (differing) {
    const log = execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-threads", threads, "-filter_threads", "2", "-filter_complex_threads", "2",
      "-i", a, "-i", b, "-lavfi", "[0:v][1:v]psnr=stats_file=-", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 28 });
    for (const m of log.matchAll(/psnr_avg:(\S+)/g)) if (m[1] !== "inf") minPsnr = Math.min(minPsnr, Number(m[1]));
  }
  return { frames: ha.length, differing, minPsnr, ok: minPsnr >= MIN_FRAME_PSNR };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) { console.error("usage: node scripts/motion-determinism.ts <a.mp4> <b.mp4>"); process.exit(2); }
  const r = compareRenders(a, b);
  console.log(`${r.frames} frames, ${r.differing} differ, lowest frame PSNR ${Number.isFinite(r.minPsnr) ? r.minPsnr.toFixed(2) + " dB" : "inf"} (floor ${MIN_FRAME_PSNR} dB): ${r.ok ? "PASS" : "FAIL"}`);
  process.exit(r.ok ? 0 : 1);
}
