#!/usr/bin/env node
// All-frame text-cut audit of rendered takes: the repo's own edgeCuts (via sourceEdgeCuts) on every
// camera frame, split by how fast the card edge is sweeping. usage: node scripts/cut-audit.ts <take-dir>...
// A take dir is a rendered one: take.json, analysis/beats.json, screen.webm and camera.json.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { actionCameraMilliseconds } from "../src/beats/clock.ts";
import { resolveCamera } from "../src/cli.ts";
import { idleSqueezes, warp } from "../src/render/pace.ts";
import { sourceEdgeCuts } from "../src/render/render.ts";
import type { Beat, CameraFrame, TakeMeta } from "../src/camera/types.ts";

/** A cut frame is allowed only while the card edge sweeps the screen faster than this, in output px/s:
 * 2 px per 60 fps frame. The reference demo's camera is effectively at rest (95% of frame pairs move the
 * view under 130 px/s, median 0.1) and its moves (frames over 30 px/s) have p25 85 and median 349 px/s, so 120
 * sits in the slow part of a real move and a view crawling below it is reading, not travelling. On the
 * real takes under the old follow, a quarter of the moving cuts crawled below this speed (A p25 93 px/s). */
export const MOVING_EDGE_SPEED = 120;

export interface CutAudit {
  take: string;
  frames: number;
  /** Frames where the crop edge slices a word or control. */
  cut: number;
  /** Cut while still: the repo's own rest test (zoom <= 0.005 ln/s, edge <= 1 output px/s). Must be 0. */
  cutAtRest: number;
  /** Cut while moving slower than MOVING_EDGE_SPEED. Must be 0. */
  cutCreeping: number;
  /** Cut while moving at MOVING_EDGE_SPEED or faster: the speed-gated allowance. */
  cutSweeping: number;
  /** Frame runs [first, last] seconds of each cut class, for locating the frames. */
  runs: { atRest: [number, number][]; creeping: [number, number][]; sweeping: [number, number][] };
}

/** Fastest a crop edge crosses the screen between frames i-1 and i, in output px/s. */
export function edgeSpeed(p: CameraFrame, q: CameraFrame, outW: number, outH: number, fps: number): number {
  const sx = outW / q.w, sy = outH / q.h;
  return Math.max(Math.abs(q.x - p.x) * sx, Math.abs(q.x + q.w - p.x - p.w) * sx,
    Math.abs(q.y - p.y) * sy, Math.abs(q.y + q.h - p.y - p.h) * sy) * fps;
}

/** The repo's rest definition, as used by the camera bars and the drag-ease proof. */
export function still(p: CameraFrame, q: CameraFrame, outW: number, outH: number, fps: number): boolean {
  return Math.abs(Math.log(q.w / p.w)) * fps <= 0.005
    && Math.abs(q.x / q.w - p.x / p.w) * outW * fps <= 1
    && Math.abs(q.y / q.h - p.y / p.h) * outH * fps <= 1;
}

export function auditTake(dir: string, theme = "midnight", fps = 60): CutAudit {
  const read = (file: string) => JSON.parse(readFileSync(join(dir, file), "utf8"));
  const meta = read("take.json") as TakeMeta & { stream?: unknown };
  const d = resolveCamera(dir, [], theme);
  const beats = read("analysis/beats.json") as Beat[];
  if ("stream" in meta) for (const b of beats) b.actions = b.actions.map(actionCameraMilliseconds);
  const start = meta.trim_start ?? 0, end = meta.trim_end!;
  const squeezes = idleSqueezes(beats, start, end, d);
  const outTime = (t: number) => warp(t - start, squeezes, d.idle_speed);
  const sourceAt = (t: number) => {
    let lo = start, hi = end;
    for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (outTime(mid) < t) lo = mid; else hi = mid; }
    return hi;
  };
  const cuts = sourceEdgeCuts(dir, meta, t => sourceAt(t - start));
  if (!cuts) throw new Error(`${dir}: no screen.webm to audit`);
  const frames = read("camera.json") as CameraFrame[];
  const audit: CutAudit = { take: basename(dir), frames: frames.length, cut: 0, cutAtRest: 0, cutCreeping: 0,
    cutSweeping: 0, runs: { atRest: [], creeping: [], sweeping: [] } };
  const open: Record<string, [number, number] | undefined> = {};
  const close = (kind: keyof CutAudit["runs"], i: number, keep: boolean) => {
    const run = open[kind];
    if (run && (!keep || run[1] !== i - 1)) { audit.runs[kind].push([+(run[0] / fps).toFixed(3), +(run[1] / fps).toFixed(3)]); open[kind] = undefined; }
  };
  frames.forEach((f, i) => {
    const p = frames[Math.max(0, i - 1)]!;
    const kind = cuts({ x: f.x, y: f.y, w: f.w, h: f.h } as never, start + f.t, start + f.t) === 0 ? undefined
      : still(p, f, d.out_w, d.out_h, fps) ? "atRest"
        : edgeSpeed(p, f, d.out_w, d.out_h, fps) >= MOVING_EDGE_SPEED ? "sweeping" : "creeping";
    for (const k of ["atRest", "creeping", "sweeping"] as const) close(k, i, k === kind);
    if (!kind) return;
    audit.cut++;
    audit[kind === "atRest" ? "cutAtRest" : kind === "creeping" ? "cutCreeping" : "cutSweeping"]++;
    open[kind] = [open[kind]?.[0] ?? i, i];
  });
  for (const k of ["atRest", "creeping", "sweeping"] as const) close(k, frames.length + 1, false);
  return audit;
}

export function report(audits: CutAudit[]): string {
  const pct = (n: number, of: number) => `${(100 * n / of).toFixed(1)}%`;
  const lines = audits.map(a => `${a.take}: ${a.frames} frames, ${a.cut} cut (${pct(a.cut, a.frames)}): `
    + `${a.cutAtRest} at rest, ${a.cutCreeping} moving under ${MOVING_EDGE_SPEED} px/s, ${a.cutSweeping} moving at or over it (allowed)`);
  const bad = audits.reduce((n, a) => n + a.cutAtRest + a.cutCreeping, 0);
  return [...lines, bad ? `FAIL: ${bad} frames cut text at rest or while crawling` : "PASS: no frame cuts text at rest or while crawling"].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) throw new Error("usage: node scripts/cut-audit.ts <rendered-take-dir>...");
  const audits = dirs.map(dir => auditTake(dir));
  for (const a of audits) console.log(JSON.stringify(a));
  console.log(report(audits));
  process.exitCode = audits.some(a => a.cutAtRest + a.cutCreeping) ? 1 : 0;
}
