#!/usr/bin/env node
// All-frame text-cut audit of rendered takes: the repo's own edgeCuts (via sourceEdgeCuts) on every
// camera frame, split by how fast the card edge is sweeping. usage: node scripts/cut-audit.ts [--set k=v]... <take-dir>...
// Pass the same --set overrides the take was rendered with.
// A take dir is a rendered one: take.json, analysis/beats.json, screen.webm and camera.json.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { actionCameraMilliseconds } from "../src/beats/clock.ts";
import { resolveCamera } from "../src/cli.ts";
import { idleSqueezes, purposefulEnd, warp } from "../src/render/pace.ts";
import { editTimeline } from "../src/render/edits.ts";
import { sourceEdgeCuts } from "../src/render/render.ts";
import { bandEligible, sourceViewport, stageGeometry, takeCaptions } from "../src/render/stage.ts";
import { withFilmText } from "../src/decide/film.ts";
import { edgeSpeed, still, SWEEP_EDGE_SPEED } from "../src/camera/sweep.ts";
import type { Beat, CameraFrame, TakeMeta } from "../src/camera/types.ts";
import type { CameraDefaults } from "../src/camera/defaults.ts";

export interface CutAudit {
  take: string;
  frames: number;
  /** Frames where the crop edge slices a word or control. */
  cut: number;
  /** Cut while still: the repo's own rest test (zoom <= 0.005 ln/s, edge <= 1 output px/s). Must be 0. */
  cutAtRest: number;
  /** Cut while moving slower than SWEEP_EDGE_SPEED. Must be 0. */
  cutCreeping: number;
  /** Cut while moving at SWEEP_EDGE_SPEED or faster: the speed-gated allowance. */
  cutSweeping: number;
  /** Source second the audit's timeline ends at: take.json's trim_end, else the render's own end. */
  trimEnd: number;
  /** Frame runs [first, last] seconds of each cut class, for locating the frames. */
  runs: { atRest: [number, number][]; creeping: [number, number][]; sweeping: [number, number][] };
}

/** `d` is the camera the take was rendered with; the CLI assumes the midnight theme's. */
export function auditTake(dir: string, d: CameraDefaults = resolveCamera(dir, [], "midnight")): CutAudit {
  const read = (file: string) => JSON.parse(readFileSync(join(dir, file), "utf8"));
  const meta = read("take.json") as TakeMeta & { stream?: unknown };
  const fps = d.fps;
  const beats = read("analysis/beats.json") as Beat[];
  if ("stream" in meta) for (const b of beats) b.actions = b.actions.map(actionCameraMilliseconds);
  // The render's own end: an untrimmed take ends on its last purposeful action plus the outro.
  const start = meta.trim_start ?? 0, end = meta.trim_end ?? purposefulEnd(beats, start,
    meta.duration ?? Math.max(0, ...beats.map((beat) => beat.t1)), d);
  // take.json cuts and timed speed run the render's own edit clock; typing speed needs the take's key
  // events, so it is refused rather than audited on the wrong clock.
  if (meta.speed?.some(s => s.kind === "type_speed")) throw new Error(`${dir}: cut-audit does not model speed type_speed`);
  const clock = meta.cuts?.length || meta.speed?.length ? editTimeline(meta, beats, start, end, d) : undefined;
  const squeezes = idleSqueezes(beats, start, end, d);
  const outTime = clock?.at ?? ((t: number) => warp(t - start, squeezes, d.idle_speed));
  const sourceAt = (t: number) => {
    let lo = start, hi = end;
    for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (outTime(mid) < t) lo = mid; else hi = mid; }
    return hi;
  };
  const frames = read("camera.json") as CameraFrame[];
  // An unbound end maps every frame to no source second, so nothing decodes and every frame reads
  // clean: the end must reproduce the rendered camera's own clock, and a frame that will not decode fails.
  const duration = outTime(end), last = frames.at(-1)?.t ?? NaN;
  if (!(Math.abs(duration - last) <= 1 / fps)) throw new Error(`${dir}: end ${end} s gives ${duration} s of output, `
    + `but camera.json runs ${last} s; set trim_end in take.json to the rendered end`);
  const cuts = sourceEdgeCuts(dir, meta, t => sourceAt(t - start), true);
  if (!cuts) throw new Error(`${dir}: no screen.webm to audit`);
  // Judge the view the card shows, as the render's guard does: camera frames are source crops, and
  // without a caption band the stage margin shows around them until the camera pushes in.
  const phone = meta.device !== undefined && meta.height > meta.width;
  const shown = withFilmText(meta);
  const banded = !phone && bandEligible(meta.width, meta.height, d)
    && takeCaptions(clock ? { ...shown, captions: shown.captions?.filter(c => clock.contains(c.t)) } : shown, outTime, duration).length > 0;
  const stage = stageGeometry(meta.width, meta.height, d);
  const view = (f: CameraFrame) => banded ? f : sourceViewport(f, meta.width, meta.height, stage, d);
  const audit: CutAudit = { take: basename(dir), frames: frames.length, cut: 0, cutAtRest: 0, cutCreeping: 0,
    cutSweeping: 0, trimEnd: end, runs: { atRest: [], creeping: [], sweeping: [] } };
  const open: Record<string, [number, number] | undefined> = {};
  const close = (kind: keyof CutAudit["runs"], i: number, keep: boolean) => {
    const run = open[kind];
    if (run && (!keep || run[1] !== i - 1)) { audit.runs[kind].push([+(run[0] / fps).toFixed(3), +(run[1] / fps).toFixed(3)]); open[kind] = undefined; }
  };
  frames.forEach((f, i) => {
    const p = frames[Math.max(0, i - 1)]!;
    const kind = cuts(view(f), start + f.t, start + f.t) === 0 ? undefined
      : still(p, f, d.out_w, d.out_h, fps) ? "atRest"
        : edgeSpeed(p, f, d.out_w, d.out_h, fps) >= SWEEP_EDGE_SPEED ? "sweeping" : "creeping";
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
  const lines = audits.map(a => `${a.take} (to ${a.trimEnd} s): ${a.frames} frames, ${a.cut} cut (${pct(a.cut, a.frames)}): `
    + `${a.cutAtRest} at rest, ${a.cutCreeping} moving under ${SWEEP_EDGE_SPEED} px/s, ${a.cutSweeping} moving at or over it (allowed)`);
  const bad = audits.reduce((n, a) => n + a.cutAtRest + a.cutCreeping, 0);
  return [...lines, bad ? `FAIL: ${bad} frames cut text at rest or while crawling` : "PASS: no frame cuts text at rest or while crawling"].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), sets: string[] = [], dirs: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--set") sets.push(args[++i]!); else dirs.push(args[i]!);
  if (!dirs.length) throw new Error("usage: node scripts/cut-audit.ts [--set k=v]... <rendered-take-dir>...");
  const audits = dirs.map(dir => auditTake(dir, resolveCamera(dir, sets, "midnight")));
  for (const a of audits) console.log(JSON.stringify(a));
  console.log(report(audits));
  process.exitCode = audits.some(a => a.cutAtRest + a.cutCreeping) ? 1 : 0;
}
