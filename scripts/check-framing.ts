#!/usr/bin/env node
// Compare camera paths on the same output clock. Any lost acted-on region fails.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Beat, CameraFrame } from "../src/camera/types.ts";
import { gestures, gesturePointer } from "../src/camera/gesture.ts";

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
  passed: boolean;
}

/** One row per beat, every frame checked, not only settled shots or anchors. */
export function framingCoverage(beats: Beat[], before: CameraFrame[], after: CameraFrame[], start = 0): Coverage[] {
  if (!Number.isFinite(start) || start < 0 || !before.length || before.length !== after.length || [...before, ...after].some(f => ![f.t, f.x, f.y, f.w, f.h].every(Number.isFinite) || f.w <= 0 || f.h <= 0) || before.some((f, i) => Math.abs(f.t - after[i]!.t) > 1e-6)) {
    throw new Error("framing comparison requires identical frame timestamps");
  }
  return beats.map(beat => {
    const row: Coverage = { beat: beat.id, frames: 0, before: 0, after: 0, lost: 0, dragFrames: 0, dragLost: 0, passed: true };
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
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [beatFile, startArg, beforeFile, afterFile] = process.argv.slice(2);
  const start = Number(startArg);
  if (!beatFile || !startArg || !beforeFile || !afterFile || !Number.isFinite(start) || start < 0) throw new Error("usage: check-framing.ts output-clock-beats.json trim-start-seconds before-camera.json after-camera.json");
  const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  const rows = framingCoverage(json(beatFile), json(beforeFile), json(afterFile), start);
  console.log("beat | frames | before visible | after visible | regressions | drag frames | drag clipped | result");
  for (const r of rows) console.log(`${r.beat} | ${r.frames} | ${r.before} | ${r.after} | ${r.lost} | ${r.dragFrames} | ${r.dragLost} | ${r.passed ? "PASS" : "FAIL"}`);
  if (rows.some(r => !r.passed)) process.exitCode = 1;
}
