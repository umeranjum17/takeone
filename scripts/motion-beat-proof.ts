// Detect the actual raster discontinuity at clocked scene cuts, within one output frame.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readStoryboard, writePage } from "../src/motion/motion.ts";
import { renderFrames } from "../src/motion/render.ts";
import { decodePng } from "../src/motion/png.ts";
import { validateStoryboard } from "../src/motion/storyboard.ts";
const dir = resolve("tmp/motion-beat-proof");
mkdirSync(dir, { recursive: true });
const source = readStoryboard(resolve("tmp/motion-proof/zoom-tour"));
const sb = validateStoryboard({ ...source, tempo: { bpm: 120, phase_s: 0, snap: "beat" }, scenes: [
  { pattern: "hero-reveal", d: 3, screen: "S1", title: "Launch board" },
  { pattern: "hero-reveal", d: 3, screen: "S2", title: "Draft your launch" },
  { pattern: "hero-reveal", d: 3, screen: "S3", title: "Task created" },
] });
const { html } = writePage(dir, sb);
const measurements = [];
for (const time of [3, 6]) {
  const framesDir = join(dir, String(time));
  await renderFrames({ html, width: 1920, height: 1080, fps: 60, firstFrame: time * 60 - 2, frames: 5, workers: 1, framesDir });
  const frames = Array.from({ length: 5 }, (_, i) => decodePng(readFileSync(join(framesDir, `${String(i + 1).padStart(6, "0")}.png`))).data);
  const differences = frames.slice(1).map((frame, i) => {
    let total = 0;
    for (let x = 0; x < frame.length; x++) total += Math.abs(frame[x]! - frames[i]![x]!);
    return total / frame.length;
  });
  const changedAt = time + (differences.indexOf(Math.max(...differences)) - 1) / 60;
  const errorFrames = Math.abs(changedAt - time) * 60;
  measurements.push({ time, changedAt, errorFrames, differences, pass: errorFrames <= 1 });
  assert.ok(errorFrames <= 1, "raster cut is off the beat grid");
}
writeFileSync(resolve("tmp/evidence/t1-l8/takeone-motion-beat.json"), JSON.stringify(measurements, null, 2));
console.log(measurements);
