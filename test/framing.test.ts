import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { cameraMetrics } from "../scripts/quality.ts";
import { actionCameraMilliseconds } from "../src/beats/clock.ts";
import { DEFAULTS } from "../src/camera/defaults.ts";
import { solveCamera } from "../src/camera/solver.ts";
import type { Beat, Decision } from "../src/camera/types.ts";
import { edgeCuts, holdPath } from "../src/render/framing.ts";
import { idleSqueezes, warp, warpBeats } from "../src/render/pace.ts";
import { sourceViewport, stageFrames, stageGeometry } from "../src/render/stage.ts";

const W = 3840, H = 2160;

test("an edge through a word cuts it; an edge across a page-wide rule does not", () => {
  const g = new Uint8Array(W * H).fill(200);
  for (let y = 100; y < 130; y++) for (let x = 1000; x < 1100; x += 6) g[y * W + x] = g[y * W + x + 1] = 20;
  g.fill(20, 1500 * W, 1501 * W);
  const cuts = edgeCuts([g], W, H);
  assert.equal(cuts({ x: 500, y: 1000, w: 2000, h: 1125 }), 0);
  assert.ok(cuts({ x: 1050, y: 50, w: 2000, h: 1125 }) >= 1e4);
  assert.equal(cuts({ x: 900, y: 50, w: 2000, h: 1125 }), 0);
});

// The committed tidewater plan, through render.ts's own pacing and solve, in crop-to-fill
// portrait and in the 16:9 stage: the held path passes every camera gate on what is shown,
// and each held framing is exactly what the stage renders.
test("camera_path=hold passes the camera gates on the tidewater plan", () => {
  const dir = "docs/quality-evidence/t1-pm-4/tidewater-plan";
  const meta = JSON.parse(readFileSync(`${dir}/take.json`, "utf8"));
  const beats: Beat[] = JSON.parse(readFileSync(`${dir}/analysis/beats.json`, "utf8"))
    .map((b: Beat) => ({ ...b, actions: b.actions.map(actionCameraMilliseconds) }));
  const decisions: Decision[] = readFileSync(`${dir}/analysis/decisions.jsonl`, "utf8").trim().split("\n").map(l => JSON.parse(l));
  // Every decided subject carries content, so no landmark reads as gone.
  const frame = new Uint8Array(W * H).fill(200);
  for (const [x, y, w, h] of beats.map(b => b.zones.find(z => z.name === decisions.find(d => d.beat === b.id)?.A)!.bbox))
    if (w < W) for (let r = y; r < y + h; r += 4) frame.fill(20, r * W + x, r * W + x + w);
  for (const d of [{ ...DEFAULTS, out_w: 1080, out_h: 1920 }, DEFAULTS]) {
    const squeezes = idleSqueezes(beats, 0, meta.trim_end, d), stage = stageGeometry(W, H, d);
    const solved = solveCamera(warpBeats(beats, 0, squeezes, d.idle_speed), decisions,
      { ...meta, trim_end: warp(meta.trim_end, squeezes, d.idle_speed) },
      { ...d, min_shot: d.min_shot * d.pace, dwell: d.dwell * d.pace, dwell_k2: d.dwell_k2 * d.pace },
      (f) => sourceViewport(f, W, H, stage, d));
    const { frames, holds } = holdPath(solved, warpBeats(beats, 0, squeezes, d.idle_speed), decisions,
      { band: null, stage, width: W, height: H, d, minShot: d.min_shot * d.pace }, () => frame);
    const shown = stageFrames(frames, W, H, stage, d);
    for (const [name, m] of Object.entries(cameraMetrics(shown, d.fps, d.out_w, d.out_h, d.min_shot))) assert.ok(m.goalPassed, `${d.out_w}x${d.out_h} ${name} ${m.value}`);
    assert.ok(holds.length >= 3);
    for (const h of holds) assert.ok((["x", "y", "w"] as const).reduce((s, k) => s + Math.abs(shown[(h.a + h.b) >> 1]![k] - h.r[k]), 0) < 1e-3, `held framing at ${h.a}`);
  }
});
