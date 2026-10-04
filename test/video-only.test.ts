import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stageFrames, stageGeometry } from "../src/render/stage.ts";
import { segmentBeats, MAX_BEATS_PER_MIN } from "../src/beats/segment.ts";
import { zonesForBeat } from "../src/beats/zones.ts";
import { heuristicDecision } from "../src/decide/heuristics.ts";
import { whatHappened } from "../src/decide/request.ts";
import { solveCamera } from "../src/camera/solver.ts";
import {idleSqueezes,warp} from "../src/render/pace.ts";
import { DEFAULTS } from "../src/camera/defaults.ts";
import type { FrameRegions } from "../src/types.ts";
import type { Beat as CameraBeat, Decision as CameraDecision } from "../src/camera/types.ts";

const stream = { w: 1170, h: 2532 };
const options = { stream, takeMs: 20000, startMs: 0, endMs: 20000, videoOnly: true };
function change(t: number, y = 400): FrameRegions {
  return { t, changed_frac: 0.04, cut: false,
    regions: [{ bbox: [90, y, 980, 350], area_frac: 0.07 }] };
}

test("video-only localized screen changes drive shared zones and purposeful camera moves", () => {
  const frames = [1000, 4000, 7000, 10000, 13000, 16000].flatMap((t, i) =>
    [change(t, 400 + i % 3 * 700), change(t + 100, 400 + i % 3 * 700)]);
  const beats = segmentBeats([], frames, options);
  assert.equal(beats.filter((b) => b.kind === "change").length, 6);
  assert.ok(beats.every((b) => b.actions.length === 0));
  const renderBeats: CameraBeat[] = [];
  const decisions: CameraDecision[] = [];
  for (const b of beats) {
    b.zones = zonesForBeat(b, { stream, scale: 3, winRect: null, frames });
    const d = heuristicDecision(b, { viewport: null });
    if (b.kind === "change") {
      assert.equal(b.zones.find((z) => z.name === d.A)?.kind, "res");
      assert.match(whatHappened(b), /app view changed/);
      assert.doesNotMatch(whatHappened(b), /clicked|idle/);
    }
    renderBeats.push({ ...b, t0: b.t0 / 1000, t1: b.t1 / 1000, anchor_t: b.anchor_t / 1000,
      zones: b.zones.map((z) => ({ name: z.name, type: z.kind, bbox: z.bbox, boxes: z.boxes })) });
    decisions.push({ ...d, conf: 1 });
  }
  const camera = solveCamera(renderBeats, decisions,
    { width: stream.w, height: stream.h, trim_start: 0, trim_end: 20 },
    { ...DEFAULTS, out_w: 1080, out_h: 1920 });
  const at = (t: number) => camera[Math.round(t * DEFAULTS.fps)]!;
  // Each new screen-change subject causes a different framing in the real solver.
  assert.ok(Math.abs(at(3).h - at(0).h) > 100);
  for (const t of [6, 9, 12, 15, 18]) assert.ok(Math.abs(at(t).y - at(t - 3).y) > 100);
});

test("video-only animation groups, noise stays idle, trims and beat cap remain bounded", () => {
  assert.deepEqual(segmentBeats([], [ { ...change(100), regions: [{ bbox: [1, 1, 12, 12], area_frac: 0.0001 }] } ], options)
    .map((b) => b.kind), ["idle"]);
  assert.equal(segmentBeats([], Array.from({ length: 100 }, (_, i) => change(i * 100)), options)
    .filter((b) => b.kind === "change").length, 1);
  const frames = Array.from({ length: 15 }, (_, i) => change(i * 1300));
  assert.ok(segmentBeats([], frames, options).length <= Math.ceil(20 / 60 * MAX_BEATS_PER_MIN));
  const trimmed = segmentBeats([], [change(1000), change(6000), change(12000)],
    { ...options, startMs: 5000, endMs: 10000, takeMs: 5000 });
  assert.ok(trimmed.every((b) => b.t0 >= 5000 && b.t1 <= 10000));
});


test("video-only whole-screen redraws stay wide and do not crowd out the next local change", () => {
  const frames: FrameRegions[] = [{ t: 700, changed_frac: 0.4, cut: false,
    regions: [{ bbox: [0, 0, stream.w, stream.h], area_frac: 0.4 }] }, change(2200)];
  const beats = segmentBeats([], frames, options);
  const redraw = beats.find((b) => b.t0 === 700)!;
  redraw.zones = zonesForBeat(redraw, { stream, scale: 3, winRect: null, frames });
  const decision = heuristicDecision(redraw, { viewport: null });
  assert.equal(redraw.kind, "cut");
  assert.equal(redraw.zones.find((z) => z.name === decision.A)?.kind, "all");
  assert.match(whatHappened(redraw), /screen changed at once/);
  assert.equal(beats.find((b) => b.t0 === 2200)?.kind, "change");
});


test("video-only result holds keep their real timing through shared pacing", () => {
  const frames = [2200, 5300, 8500, 11600, 14800].map((t,i)=>change(t,400+i%3*700));
  const beats = segmentBeats([], frames, options).map(b=>({ ...b,
    t0:b.t0/1000,t1:b.t1/1000,anchor_t:b.anchor_t/1000,zones:[] }));
  const gaps = idleSqueezes(beats,0,20,DEFAULTS);
  for(const {a,b} of gaps) assert.ok(b <= 2.2, `result hold squeezed at ${a}-${b}`);
  assert.equal(warp(20,gaps,DEFAULTS.idle_speed),20);
});

test("Simulator fragmented opening redraw does not delay the first purposeful shot", () => {
  // Perception output from our Tidewater Simulator recording, relative to its trim.
  const frames: FrameRegions[] = JSON.parse(readFileSync(new URL("./fixtures/ios-screen-changes.json", import.meta.url), "utf8"));
  const stream = { w: 1178, h: 2556 };
  const beats = segmentBeats([], frames, { ...options, stream, endMs: 17900 });
  const decisions: CameraDecision[] = [];
  const renderBeats = beats.map((b) => {
    b.zones = zonesForBeat(b, { stream, scale: 2, winRect: null, frames });
    decisions.push({ ...heuristicDecision(b, { viewport: null }), conf: 1 });
    return { ...b, t0: b.t0 / 1000, t1: b.t1 / 1000, anchor_t: b.anchor_t / 1000,
      zones: b.zones.map((z) => ({ name: z.name, type: z.kind, bbox: z.bbox, boxes: z.boxes })) };
  });
  const d = { ...DEFAULTS, out_w: 1080, out_h: 1920 };
  const camera = solveCamera(renderBeats, decisions,
    { width: stream.w, height: stream.h, trim_start: 0, trim_end: 17.9 }, d);
  const projected = stageFrames(camera, stream.w, stream.h, stageGeometry(stream.w, stream.h, d), d);
  let still = 0, longest = 0, moves = 0, wasMoving = false;
  for (let i = 1; i < projected.length; i++) {
    const a = projected[i - 1]!, b = projected[i]!;
    const dt = b.t - a.t;
    const pan = Math.hypot(b.x * d.out_w / b.w - a.x * d.out_w / a.w,
      b.y * d.out_h / b.h - a.y * d.out_h / a.h) / dt;
    const moving = pan > 1 || Math.abs(Math.log(b.w / a.w)) / dt > 0.005;
    if (moving) { if (!wasMoving && b.t < 16.4) moves++; still = 0; }
    else { still += dt; longest = Math.max(longest, still); }
    wasMoving = moving;
  }
  assert.ok(longest <= 4, `longest static interval ${longest.toFixed(3)}s exceeds 4s`);
  assert.ok(moves >= 3, `only ${moves} screen-change moves`);
  assert.equal(beats.find((b) => b.t0 === 700)?.kind, "cut");
});
