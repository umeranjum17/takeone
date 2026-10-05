#!/usr/bin/env node
// Compare camera paths on the same output clock. Any lost acted-on region fails.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Beat, CameraFrame } from "../src/camera/types.ts";
import { gestures, gesturePointer } from "../src/camera/gesture.ts";
import { clippedFractions, HIGH_CLIP_FRACTION } from "../src/camera/solver.ts";
import { shutterFrame } from "../src/render/motion-blur.ts";

export function contains(f: CameraFrame, r: readonly number[]): boolean {
  const epsilon = 1e-6;
  return f.x <= r[0]! + epsilon && f.y <= r[1]! + epsilon
    && f.x + f.w >= r[0]! + r[2]! - epsilon && f.y + f.h >= r[1]! + r[3]! - epsilon;
}

export interface Coverage {
  beat: string;
  frames: number;
  before: number;
  after: number;
  lost: number;
  dragFrames: number;
  dragLost: number;
  /** Reference boxes checked on this row's frames (film-global on the "references" row). */
  refFrames: number;
  /** Frames where a reference box is sliced instead of held whole or left out. */
  refCut: number;
  /** Every reference box sliced anywhere in the row's settled frames. */
  refCutBoxes: string[];
  firstRefCut: { t: number; box: string; clipped: number } | null;
  passed: boolean;
}

/** A static surface the crop may hold whole or leave out, never slice. */
export interface Reference { name?: string; bbox: readonly number[] }

/** Sliced reference boxes on one camera frame, per shutter exposure. */
export function referenceCuts(frame: CameraFrame, references: readonly Reference[], exposures: readonly number[], frames: readonly CameraFrame[], index: number) {
  const cuts: { exposure: number; box: string; clipped: number }[] = [];
  for (const exposure of exposures) {
    const at = index + exposure;
    const view = (exposure === 0 ? frame : shutterFrame([...frames], at));
    clippedFractions(view, references.map(r => [...r.bbox] as [number, number, number, number])).forEach((clipped, i) => {
      if (clipped > 0 && clipped < HIGH_CLIP_FRACTION) {
        cuts.push({ exposure, box: references[i]!.name ?? JSON.stringify(references[i]!.bbox), clipped });
      }
    });
  }
  return cuts;
}

/**
 * Frames where the shot has already arrived: a held frame that slices a label
 * row is a defect, while a deliberate move legitimately carries surfaces
 * through the crop edge. Looks a quarter second ahead so a decelerating arrival
 * still counts as the hold it becomes.
 */
export function settledFrames(frames: readonly CameraFrame[], fps = 60, holdS = 0.25, tolerancePx = 1) {
  const ahead = Math.max(1, Math.round(fps * holdS));
  return frames.map((frame, i) => {
    const stop = Math.min(frames.length - 1, i + ahead);
    return ["x", "y", "w", "h"].every(k => Math.abs(frame[k as "x"]! - frames[stop]![k as "x"]!) <= tolerancePx);
  });
}

/** One row per beat, every frame checked, not only settled shots or anchors. */
export function framingCoverage(beats: Beat[], before: CameraFrame[], after: CameraFrame[], start = 0,
  references: readonly Reference[] = [], exposures: readonly number[] = [0]): Coverage[] {
  if (!Number.isFinite(start) || start < 0 || !before.length || before.length !== after.length || [...before, ...after].some(f => ![f.t, f.x, f.y, f.w, f.h].every(Number.isFinite) || f.w <= 0 || f.h <= 0) || before.some((f, i) => Math.abs(f.t - after[i]!.t) > 1e-6) || !Array.isArray(exposures) || exposures.some(e => !Number.isFinite(e) || e < 0) || !Array.isArray(references) || references.some(r => !Array.isArray(r?.bbox) || r.bbox.length !== 4 || !r.bbox.every(Number.isFinite) || r.bbox[2]! <= 0 || r.bbox[3]! <= 0)) {
    throw new Error("framing comparison requires identical frame timestamps");
  }
  return beats.map(beat => {
    const row: Coverage = { beat: beat.id, frames: 0, before: 0, after: 0, lost: 0, dragFrames: 0, dragLost: 0,
      refFrames: 0, refCut: 0, refCutBoxes: [], firstRefCut: null, passed: true };
    const acted = beat.kind === "type"
      ? beat.zones.find(z => z.type === "txt") ?? beat.zones.find(z => z.type === "act")
      : beat.zones.find(z => z.type === "act") ?? beat.zones.find(z => z.type === "txt");
    const drags = gestures(beat);
    for (let i = 0; i < after.length; i++) {
      const t = after[i]!.t + start;
      const inBeat = t >= beat.t0 && t <= beat.t1;
      const active = drags.filter(g => g.t0 / 1000 <= t && g.t1 / 1000 >= t);
      if (!inBeat && !active.length) continue;
      row.frames++;
      if (acted && inBeat) {
        const wasVisible = contains(before[i]!, acted.bbox);
        const isVisible = contains(after[i]!, acted.bbox);
        row.before += Number(wasVisible); row.after += Number(isVisible);
        row.lost += Number(wasVisible && !isVisible);
      }
      for (const g of active) {
        const [x, y] = gesturePointer(g, t);
        const subject = g.whole_object;
        const object = subject ? [subject[0] + x - g.from[0], subject[1] + y - g.from[1], subject[2], subject[3]] : undefined;
        row.dragFrames++;
        row.dragLost += Number(!object || !contains(after[i]!, object) || !contains(after[i]!, [x - 8, y - 8, 32, 40]));
      }
    }
    row.passed = row.frames > 0 && row.lost === 0 && row.dragLost === 0;
    return row;
  }).concat(references.length ? [referenceRow(after, references, exposures, start)] : []);
}

/** Every settled frame, not only beat frames: a shot that parks mid-glyph is still a cut heading. */
function referenceRow(after: CameraFrame[], references: readonly Reference[], exposures: readonly number[], start: number): Coverage {
  const settled = settledFrames(after);
  const row: Coverage = { beat: "references", frames: after.filter((_, i) => settled[i]).length, before: 0, after: 0, lost: 0,
    dragFrames: 0, dragLost: 0, refFrames: 0, refCut: 0, refCutBoxes: [], firstRefCut: null, passed: true };
  const cutBoxes = new Set<string>();
  for (let i = 0; i < after.length; i++) {
    if (!settled[i]) continue;
    row.refFrames++;
    const cuts = referenceCuts(after[i]!, references, exposures, after, i);
    if (!cuts.length) continue;
    row.refCut++;
    for (const cut of cuts) cutBoxes.add(cut.box);
    row.firstRefCut ??= { t: after[i]!.t + start, box: cuts[0]!.box, clipped: cuts[0]!.clipped };
  }
  row.refCutBoxes = [...cutBoxes];
  row.passed = row.refFrames > 0 && row.refCut === 0;
  return row;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [beatFile, startArg, beforeFile, afterFile, referenceFile, exposureArg] = process.argv.slice(2);
  const start = Number(startArg);
  if (!beatFile || !startArg || !beforeFile || !afterFile || !Number.isFinite(start) || start < 0) throw new Error("usage: check-framing.ts output-clock-beats.json trim-start-seconds before-camera.json after-camera.json [reference-boxes.json [exposure-offsets]]");
  const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  const references: Reference[] = referenceFile ? json(referenceFile) : [];
  const exposures = exposureArg ? exposureArg.split(",").map(Number) : [0];
  if (exposures.some(e => !Number.isFinite(e) || e < 0)) throw new Error("usage: check-framing.ts output-clock-beats.json trim-start-seconds before-camera.json after-camera.json [reference-boxes.json [exposure-offsets]]");
  const rows = framingCoverage(json(beatFile), json(beforeFile), json(afterFile), start, references, exposures);
  console.log("beat | frames | before visible | after visible | regressions | drag frames | drag clipped | result");
  for (const r of rows) {
    const reference = r.beat === "references"
      ? ` (${r.refCut} ref-cut frames of ${r.refFrames} settled${r.refCutBoxes.length ? `: ${r.refCutBoxes.join(", ")}; first cut ${r.firstRefCut!.box} at ${r.firstRefCut!.t.toFixed(3)}s, ${(r.firstRefCut!.clipped * 100).toFixed(1)}% sliced` : ""})`
      : "";
    console.log(`${r.beat} | ${r.frames} | ${r.before} | ${r.after} | ${r.lost} | ${r.dragFrames} | ${r.dragLost} | ${r.passed ? "PASS" : "FAIL"}${reference}`);
  }
  if (rows.some(r => !r.passed)) process.exitCode = 1;
}
