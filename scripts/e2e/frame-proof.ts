// Render a ten-second camera proof from the realistic Tidewater scene screenshot.
// First capture scene.html at 2560x1440 CSS pixels, device scale 1.5, with chrome-devtools-axi into
// tmp/frame-proof/scene.png, then run: node scripts/e2e/frame-proof.ts
// The fixed scene's measured UI boundaries are perception fixtures, not inferred DOM
// access in the product. They exercise zonesForBeat -> renderTake without a planner call.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { zonesForBeat } from "../../src/beats/zones.ts";
import { DEFAULTS } from "../../src/camera/defaults.ts";
import { clippedFractions, HIGH_CLIP_FRACTION } from "../../src/camera/solver.ts";
import type { CameraFrame } from "../../src/camera/types.ts";
import { renderTake } from "../../src/render/render.ts";
import type { BBox, Beat } from "../../src/types.ts";

const dir = resolve("tmp/frame-proof");
await mkdir(`${dir}/analysis`, { recursive: true });
const scale = 1.5;
const width = 3840;
const height = 2160;
const logicalBoxes: BBox[] = [
  [0, 0, 2560, 88], [0, 88, 280, 1352],
  [336, 200, 488, 132], [336, 348, 488, 132], [336, 496, 488, 132],
  [888, 200, 488, 132], [888, 348, 488, 132],
  [1440, 200, 488, 132], [1440, 348, 488, 132], [1984, 128, 544, 1272],
];
const boxes = logicalBoxes.map(b => b.map(v => v * scale) as BBox);
const beat: Beat = { id: "focus-card", kind: "click", t0: 2000, t1: 10000, anchor_t: 3000,
  window_cls: "chromium", zones: [], actions: [{ k: "click", t: 3000, x: 1120 * scale, y: 403 * scale, window_cls: "chromium" }] };
const zones = zonesForBeat(beat, { winRect: null, stream: { w: width, h: height }, scale,
  frames: [{ t: 3000, cut: false, changed_frac: .1,
    regions: boxes.map(bbox => ({ bbox, area_frac: bbox[2] * bbox[3] / (width * height) })) }] });
const focused = zones.find(z => z.kind === "act")!;
await writeFile(`${dir}/take.json`, JSON.stringify({ id: "takeone-frame", width, height, trim_end: 10, events: "none" }));
await writeFile(`${dir}/analysis/beats.json`, JSON.stringify([{ id: beat.id, kind: beat.kind, t0: 2, t1: 10, anchor_t: 3,
  actions: [{ k: "click", t: 3000, x: 1120 * scale, y: 403 * scale }],
  zones: zones.map(z => ({ name: z.name, type: z.kind, bbox: z.bbox, boxes: z.boxes })) }]));
await writeFile(`${dir}/analysis/decisions.jsonl`, JSON.stringify({ beat: beat.id, A: focused.name,
  L: 3, p: 0, K: 1, conf: 1, decided_by: "fixture" }));
if (!process.argv.includes("--prepare-only")) {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-loop", "1", "-i", `${dir}/scene.png`, "-t", "10", "-r", "30",
    "-c:v", "libvpx-vp9", "-threads", "2", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p", `${dir}/screen.webm`]);
  const rendered = await renderTake(dir, { ...DEFAULTS, preset: "veryfast", idle_speed: 1 });
  const frames = JSON.parse(await readFile(`${dir}/camera.json`, "utf8")) as CameraFrame[];
  // This fixture has one settled held shot, between the arrival and the outro.
  const holds = frames.filter(f => f.t >= 4 && f.t <= 7).map(f => ({ t: f.t, clipped: clippedFractions(f, boxes) }));
  await writeFile(`${dir}/camera-quality.json`, JSON.stringify({ threshold: HIGH_CLIP_FRACTION, boxes, holds }, null, 2));
  assert.ok(holds.length > 0);
  assert.ok(holds.every(f => f.clipped.every(c => c === 0 || c >= HIGH_CLIP_FRACTION)), "held shot cuts a UI box");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "6", "-i", rendered.out, "-frames:v", "1", `${dir}/takeone-frame-after.png`]);
  console.log(JSON.stringify({ ...rendered, still: `${dir}/takeone-frame-after.png`, quality: `${dir}/camera-quality.json` }));
}
