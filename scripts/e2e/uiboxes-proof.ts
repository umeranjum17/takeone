import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { makeTake } from "../../src/make.ts";
import { zonesForBeat } from "../../src/beats/zones.ts";
import { heuristicDecision } from "../../src/decide/heuristics.ts";
import { renderTake } from "../../src/render/render.ts";
import { DEFAULTS } from "../../src/camera/defaults.ts";
import { clippedFractions } from "../../src/camera/solver.ts";
import type { CameraFrame } from "../../src/camera/types.ts";
import type { BBox, FrameRegions } from "../../src/types.ts";

const evidence = resolve("tmp/evidence/t1-uiboxes");
const dir = resolve("tmp/uiboxes-proof");
const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args], { stdio: "inherit" });
const clicks: number[][] = JSON.parse(readFileSync(join(dir, "proof-clicks.json"), "utf8"));
const camera = { ...DEFAULTS, preset: "veryfast", idle_speed: 1 };
const planned = await makeTake(dir, { noJev: true, apiKey: null, camera, planOnly: true });
const changes = JSON.parse(readFileSync(join(dir, "analysis/regions.json"), "utf8")).frames as FrameRegions[];
for (const [t] of clicks) {
  const near = changes.filter(f => Math.abs(f.t - t!) <= 200);
  assert.ok(near.length && near.every(f => f.regions.length === 0), `click at ${t} must have no perception regions`);
}
// Validate the source case before spending time on either encode. Planning and
// rendering use the same durable artifacts as ordinary make.
writeFileSync(join(dir, "take.json"), JSON.stringify({ ...planned.take, width: 2560, height: 1440,
  trim_start: 0, trim_end: changes.length / 10 }));
writeFileSync(join(dir, "analysis/decisions.jsonl"), planned.decisions.map(d => JSON.stringify({ ...d,
  conf: Math.max(0, Math.min(1, d.conf.A ?? d.conf.B ?? d.conf.L ?? 0)) })).join("\n") + "\n");
const after = { ...planned, ...await renderTake(dir, camera) };
const afterFrames = JSON.parse(readFileSync(join(dir, "camera.json"), "utf8")) as CameraFrame[];
const afterBeats = readFileSync(join(dir, "analysis/beats.json"));
const afterDecisions = readFileSync(join(dir, "analysis/decisions.jsonl"));
copyFileSync(after.out!, join(evidence, "takeone-uiboxes-after.mp4"));
// Fixed scene geometry is an independent output oracle only, never detector input.
const cards: BBox[] = [[336, 200, 488, 132], [336, 348, 488, 132], [336, 496, 488, 132],
  [888, 200, 488, 132], [888, 348, 488, 132], [1440, 200, 488, 132], [1440, 348, 488, 132], [1984, 128, 544, 1272]];
const dialog: BBox = [900, 340, 760, 620];
const holds = [cards[4]!, cards[2]!, cards[7]!, dialog].map((box, i) => [clicks[i]![0]! / 1000 + 2, box] as [number, BBox]);
const quality = holds.map(([t, subject]) => {
  const shot = afterFrames.filter(f => f.t >= t - .2 && f.t <= t + .2);
  assert.ok(shot.length);
  const boxes = t < holds[3]![0] - 2 ? cards : [dialog];
  for (const f of shot) {
    assert.equal(clippedFractions(f, [subject])[0], 0, `focused surface clipped at ${f.t}`);
    assert.ok(clippedFractions(f, boxes).every(c => c === 0 || c >= .9), `neighbor clipped at ${f.t}`);
  }
  return { t, subject, frames: shot.length, crop: shot[Math.floor(shot.length / 2)], clips: clippedFractions(shot[0]!, boxes) };
});
// Baseline reuses precisely the same recorded frames, segmentation and camera;
// it only omits the new static hints when computing zones.
const baselineBeats = after.beats.map(b => ({ ...b, zones: zonesForBeat(b, { winRect: [0, 0, 2560, 1440],
  stream: { w: 2560, h: 1440 }, scale: 1, frames: changes }) }));
writeFileSync(join(dir, "analysis/beats.json"), JSON.stringify(baselineBeats.map(b => ({ ...b,
  t0: b.t0 / 1000, t1: b.t1 / 1000, anchor_t: b.anchor_t / 1000,
  actions: b.actions.map(a => "t" in a ? { ...a, t: a.t / 1000 } : { ...a, t0: a.t0 / 1000, t1: a.t1 / 1000 }),
  zones: b.zones.map(z => ({ name: z.name, type: z.kind, bbox: z.bbox, boxes: z.boxes,
    ...(z.kind === "res" && z.t !== undefined ? { t_change: z.t / 1000 } : {}) })) }))));
writeFileSync(join(dir, "analysis/decisions.jsonl"), baselineBeats.map(b => JSON.stringify({ ...heuristicDecision(b, { viewport: null }), conf: 0 })).join("\n") + "\n");
const before = await renderTake(dir, camera);
copyFileSync(before.out, join(evidence, "takeone-uiboxes-before.mp4"));
const beforeFrames = JSON.parse(readFileSync(join(dir, "camera.json"), "utf8")) as CameraFrame[];
assert.ok(holds.slice(0, 2).some(([t]) => {
  const crop = beforeFrames.find(f => Math.abs(f.t - t) < .02)!;
  return clippedFractions(crop, cards).some(clipped => clipped > 0 && clipped < .9);
}), "baseline must reproduce the half-card crop");
for (const kind of ["before", "after"]) {
  const select = holds.map(([t]) => `eq(n,${Math.round(t * camera.fps)})`).join("+");
  ffmpeg(["-i", join(evidence, `takeone-uiboxes-${kind}.mp4`), "-vf", `select='${select}',scale=640:360,tile=1x4`, "-frames:v", "1", join(evidence, `takeone-uiboxes-${kind}.png`)]);
}
ffmpeg(["-i", join(evidence, "takeone-uiboxes-before.png"), "-i", join(evidence, "takeone-uiboxes-after.png"),
  "-filter_complex", "hstack", join(evidence, "takeone-uiboxes-contact-sheet.png")]);
writeFileSync(join(dir, "analysis/beats.json"), afterBeats);
writeFileSync(join(dir, "analysis/decisions.jsonl"), afterDecisions);
const analysis = JSON.parse(readFileSync(join(dir, "analysis/ui-boxes.json"), "utf8"));
writeFileSync(join(evidence, "takeone-uiboxes-quality.json"), JSON.stringify({ fixture: "isolated Xvfb Tidewater recording + browser input events", empty_region_clicks: clicks,
  cost: analysis.cost, holds: quality, output: { width: camera.out_w, height: camera.out_h, fps: camera.fps }, model_calls: 0 }, null, 2));
console.log(JSON.stringify({ evidence, cost: analysis.cost, holds: quality.length }));
