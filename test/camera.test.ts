import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { applyOverrides, DEFAULTS } from "../src/camera/defaults.ts";
import { baseWidth, clippedFractions, HIGH_CLIP_FRACTION, frame, moveDuration, solveCamera, zMax } from "../src/camera/solver.ts";
import type { Beat, Decision, Zone } from "../src/camera/types.ts";
import type { Event } from "../src/types.ts";
import { renderTake } from "../src/render/render.ts";
import { dialogResults } from "../src/perceive/dialogs.ts";
import { idleSqueezes, warp, warpBeats } from "../src/render/pace.ts";
import { actionCameraMilliseconds } from "../src/beats/clock.ts";
import { framingCoverage } from "../scripts/check-framing.ts";
import { hasFfmpeg } from "./helpers.ts";

// Only tests pass a fast preset and tiny output: shipped output stays
// 1920x1080 slow (see DEFAULTS). Small frames keep CI software encodes fast;
// ripple and fade add per-frame stage work, so tests turn them off (both are
// already no-ops at 0 in the render path, and the shipped defaults are untouched).
const FAST = { ...DEFAULTS, preset: "veryfast", out_w: 320, out_h: 180, ripple_ms: 0, fade_s: 0 };

// The two render tests below shell out to system ffmpeg/ffprobe, so they skip
// explicitly where those binaries are absent instead of failing with ENOENT.
// CI installs ffmpeg (see .github/workflows/ci.yml) so coverage stays real there.
const needsFfmpeg = hasFfmpeg() ? undefined : "requires system ffmpeg and ffprobe on PATH";

const zone = (name: string, bbox: [number, number, number, number]): Zone => ({
  name,
  type: "act",
  bbox,
});

function beat(id: string, anchor: number, x: number, kind: Beat["kind"] = "click"): Beat {
  return {
    id,
    t0: anchor - 0.5,
    t1: anchor + 1,
    anchor_t: anchor,
    actions: [],
    zones: [zone(id, [x, 900, 180, 120])],
    kind,
  };
}

function decision(b: Beat, importance: 0 | 1 | 2 = 1): Decision {
  return {
    beat: b.id,
    A: b.zones[0]!.name,
    L: 3,
    p: 0,
    K: importance,
    conf: 1,
    decided_by: "test",
  };
}

// Motion mechanics may explicitly opt into upscaling; native-default limits are tested separately.
const noBookends = { ...DEFAULTS, max_upscale: 1.5, establish_s: 0, outro_s: 0 };

test("automatic portrait fill retains a wide active subject without window zones", () => {
  const d = { ...DEFAULTS, out_w: 1080, out_h: 1920, outro_s: 0 };
  const b: Beat = { id: "wide-active", kind: "click", t0: 2, t1: 10, anchor_t: 2,
    zones: [zone("active", [500, 400, 1400, 400])], actions: [] };
  const frames = solveCamera([b], [decision(b)], { width: 2560, height: 1440, trim_end: 10 }, d);
  assert.ok(frames.some(f => f.w < frames[0]!.w - 100), "automatic framing moves in");
  for (const f of frames.filter(f => f.t >= 5 && f.t <= 9)) {
    assert.ok(f.w >= 1400 * d.hold_pad - 1e-6, `subject-fit width at ${f.t}: ${f.w}`);
    assert.ok(f.x <= 500 && f.x + f.w >= 1900, `whole subject horizontally at ${f.t}`);
    assert.ok(f.y <= 400 && f.y + f.h >= 800, `whole subject vertically at ${f.t}`);
  }
});

test("automatic payoff reservations preserve manual anticipation and holds", () => {
  const zooms = [{ t0: 6, t1: 15, bbox: [0, 600, 100, 100] as [number, number, number, number] }];
  const take = { width: 2560, height: 1440, trim_end: 20, zooms };
  for (const output of [{ out_w: 1080, out_h: 1080 }, { out_w: 1080, out_h: 1920 }, { out_w: 1920, out_h: 1080 }]) {
    const d = { ...DEFAULTS, ...output, outro_s: 0 };
    const baselineTiming = { cuts: [], arrivals: [] as import("../src/camera/solver.ts").CameraArrival[] };
    const baseline = solveCamera([], [], take, d, baselineTiming);
    for (const t_change of [5, 10, 14, 16]) {
      const b: Beat = { id: "payoff", kind: "click", t0: t_change - 1, t1: t_change + 3,
        anchor_t: t_change - 1, actions: [], zones: [
          { name: "all", type: "all", bbox: [0, 0, 2560, 1440] },
          { name: "result", type: "res", bbox: [2100, 600, 200, 200], t_change },
        ] };
      for (const B of ["result", undefined]) {
        const actual = solveCamera([b], [{ ...decision(b), A: "all", B, L: 0 }], take, d);
        const first = Math.ceil(baselineTiming.arrivals[0]!.feasibleStart * d.fps);
        assert.deepEqual(actual.slice(first, 15 * d.fps + 1), baseline.slice(first, 15 * d.fps + 1),
          `${output.out_w}x${output.out_h} payoff ${t_change}, B=${B}`);
      }
    }
  }
});

// Rest-width assertions use baseWidth after the accepted padded-viewport change.
// Mechanics tests opt out of the opening hold and closing wide shot.
function camera(beats: Beat[], decisions: Decision[], end = 8) {
  return solveCamera(beats, decisions, {
    width: 3840,
    height: 2160,
    trim_start: 0,
    trim_end: end,
  }, noBookends);
}

function at(frames: ReturnType<typeof camera>, seconds: number) {
  return frames[Math.round(seconds * DEFAULTS.fps)]!;
}

test("framing expands to 16:9 and respects source and upscale clamps", () => {
  assert.ok(Math.abs(zMax(3840, 2160) - 2 * (1 + 2 * DEFAULTS.stage_margin)) < 1e-9);
  assert.ok(Math.abs(zMax(3840, 2160, { ...DEFAULTS, max_upscale: 1.5 }) - 3 * (1 + 2 * DEFAULTS.stage_margin)) < 1e-9);
  for (let level = 0; level <= 3; level++) {
    const result = frame(zone("edge", [3600, 1900, 100, 100]), level, 3840, 2160);
    assert.ok(result.z >= 1 && result.z <= zMax(3840, 2160));
    assert.ok(result.cx >= 0 && result.cx <= 3840);
    assert.ok(result.cy >= 0 && result.cy <= 2160);
  }
});

test("FIT holds a whole opened panel at a real zoom instead of padding out to the whole screen", () => {
  const panel = zone("panel", [84, 224, 972, 692]);
  for (let level = 2; level <= 3; level++) {
    const s = frame(panel, level, 1920, 1080, undefined, noBookends);
    const w = 1920 / s.z;
    const h = w * 9 / 16;
    // The heading at the panel's top edge and every other edge stay in frame.
    assert.ok(s.cx - w / 2 <= 84 && s.cx + w / 2 >= 84 + 972, `level ${level} x`);
    assert.ok(s.cy - h / 2 <= 224 && s.cy + h / 2 >= 224 + 692, `level ${level} y`);
    assert.ok(s.z > 1.2, `level ${level} zoomed ${s.z}`);
  }
  // Small zones keep their full per-level padding.
  assert.deepEqual(frame(zone("button", [900, 500, 60, 30]), 1, 1920, 1080),
    frame(zone("button", [900, 500, 60, 30]), 1, 1920, 1080, undefined, { ...DEFAULTS, frame_max: 1 }));
});

test("whole-screen non-16:9 frames cover the full source while 16:9 framing is unchanged", () => {
  for (const [width, height] of [[3440, 1440], [1440, 2560]] as const) {
    const whole = solveCamera([], [], { width, height, trim_start: 0, trim_end: 1 })[0]!;
    assert.ok(whole.x <= 0 && whole.y <= 0);
    assert.ok(whole.x + whole.w >= width && whole.y + whole.h >= height);
    assert.ok(Math.abs(whole.w / whole.h - 16 / 9) < 1e-9);
    assert.equal(DEFAULTS.out_w, 1920);
    assert.equal(DEFAULTS.out_h, 1080);
  }
  const wide = solveCamera([], [], { width: 3840, height: 2160, trim_start: 0, trim_end: 1 })[0]!;
  // Accepted padded-viewport change: the rest margin is part of camera geometry.
  const paddedW = baseWidth(3840, 2160);
  assert.deepEqual(wide, { t: 0, x: (3840 - paddedW) / 2, y: (2160 - paddedW * 9 / 16) / 2, w: paddedW, h: paddedW * 9 / 16 });
  const zoomBeat = beat("wide-zoom", 2, 2500);
  const zoomed = solveCamera([zoomBeat], [decision(zoomBeat)], {
    width: 3840, height: 2160, trim_start: 0, trim_end: 4,
  }, noBookends);
  assert.ok(at(zoomed, 2).w < 1400);
  assert.ok(at(zoomed, 2).x > 1800);
});

test("phone footage into 16:9 zooms against the padded canvas and keeps the card centred", () => {
  // 1080x2400 sits on a stage-padded 4267-wide 16:9 canvas.
  assert.ok(zMax(1080, 2400) > 1);
  assert.ok(Math.abs(zMax(1080, 2400) - 2400 * 16 / 9 * (1 + 2 * DEFAULTS.stage_margin) / DEFAULTS.out_w) < 1e-9);
  const tap: Beat = { ...beat("tap", 2, 0), zones: [zone("tap", [120, 1900, 240, 120])] };
  const frames = solveCamera([tap], [decision(tap)], {
    width: 1080, height: 2400, trim_start: 0, trim_end: 4,
  }, noBookends);
  const deepest = frames.reduce((a, b) => (b.w < a.w ? b : a));
  assert.ok(Math.abs(deepest.w - 1280) < 1e-6); // max_upscale 1.5 into 1920 wide
  for (const f of frames) {
    assert.ok(Math.abs(f.w / f.h - 16 / 9) < 1e-9);
    // Wider than the phone: the card stays centred, never pushed to one side.
    if (f.w > 1080) assert.ok(Math.abs(f.x + f.w / 2 - 540) < 1e-6);
    // Shorter than the phone: the shot stays on the screen, never above or below it.
    if (f.h < 2400) assert.ok(f.y >= 0 && f.y + f.h <= 2400);
  }
  // The tapped region is framed whole.
  assert.ok(deepest.y <= 1900 && deepest.y + deepest.h >= 2020);
  assert.ok(frames.every((f, i) => !i || Math.abs(f.w - frames[i - 1]!.w) < 200));
});

test("non-16:9 padding eases through zoom and back without a crop jump", () => {
  const zoom = beat("zoom", 2.5, 2500);
  const all = { ...beat("all", 5.5, 0), zones: [{ name: "all", type: "all" as const, bbox: [0, 0, 3440, 1440] as [number, number, number, number] }] };
  const frames = solveCamera([zoom, all], [decision(zoom), { ...decision(all), L: 0 }], {
    width: 3440, height: 1440, trim_start: 0, trim_end: 8,
  }, { ...DEFAULTS, max_upscale: 1.5 });
  assert.ok(Math.abs(frames[0]!.w / frames[0]!.h - 16 / 9) < 1e-9);
  assert.ok(frames[0]!.x <= 0 && frames[0]!.x + frames[0]!.w >= 3440);
  assert.ok(Math.min(...frames.map((f) => f.w)) < 1700);
  const contained = frames.find((f) => f.w <= 3440 && f.h <= 1440)!;
  assert.ok(contained.x >= 0 && contained.y >= 0);
  assert.ok(contained.x + contained.w <= 3440 && contained.y + contained.h <= 1440);
  assert.ok(Math.abs(contained.w / contained.h - 16 / 9) < 1e-9);
  assert.ok(frames.at(-1)!.w > 3400);
  assert.ok(frames.every((f, i) => !i || Math.abs(f.w - frames[i - 1]!.w) < 200));
});

test("move duration clamps", () => {
  assert.equal(moveDuration(0), 0.6);
  assert.ok(moveDuration(100) <= 1.4);
});

test("deadzone skips framing that already fits with the configured margin", () => {
  const b = beat("wide", 2, 300);
  b.zones[0]!.bbox = [200, 500, 3200, 1100];
  const result = camera([b], [decision(b)], 4);
  assert.equal(at(result, 3).w, baseWidth(3840, 2160));
});

test("minimum dwell delays the next shot and merges its zone with the previous one", () => {
  const first = beat("first", 2, 500);
  const next = beat("next", 2.2, 3000);
  const result = camera([first, next], [decision(first, 2), decision(next, 2)], 5);
  // After the opposite zoom has held for min_shot, the merged framing spans
  // both distant subjects rather than jumping to the second alone.
  assert.ok(at(result, 5).x < 1000);
  assert.ok(at(result, 5).x + at(result, 5).w > 2800);
});

test("minimum shot length drops an arrival that is too close to the previous one", () => {
  const first = beat("first", 2, 500);
  const tooSoon = beat("soon", 2.5, 3000);
  const withShortShot = camera([first, tooSoon], [decision(first), decision(tooSoon)], 5);
  const withoutShortShot = camera([first], [decision(first)], 5);
  assert.deepEqual(at(withShortShot, 4), at(withoutShortShot, 4));
});

test("Tidewater b3 retains the typed region after a simultaneous whole-screen cut", async () => {
  const root = new URL("../docs/quality-evidence/t1-pm-4/", import.meta.url);
  const json = async (path: string) => JSON.parse(await readFile(new URL(path, root), "utf8"));
  const take = await json("tidewater-plan/take.json");
  const beats: Beat[] = (await json("tidewater-plan/analysis/beats.json"))
    .map((b: Beat) => ({ ...b, actions: b.actions.map(actionCameraMilliseconds) }));
  const decisions: Decision[] = (await readFile(new URL("tidewater-plan/analysis/decisions.jsonl", root), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line));
  const squeezes = idleSqueezes(beats, 0, take.trim_end, DEFAULTS);
  const outputBeats = warpBeats(beats, 0, squeezes, DEFAULTS.idle_speed);
  const frames = solveCamera(outputBeats, decisions,
    { ...take, trim_end: warp(take.trim_end, squeezes, DEFAULTS.idle_speed) });
  const coverage = framingCoverage(outputBeats, await json("tidewater-main-before-camera.json"), frames);
  const typing = coverage.find(row => row.beat === "b3")!;
  assert.equal(typing.before, 134, "exercise the recorded baseline-visible frames");
  assert.equal(typing.lost, 0, "retain the whole declared typed region, including its top edge");
  assert.ok(coverage.every(row => row.lost === 0), JSON.stringify(coverage));
});

test("redundant beats do not consume the move-rate budget", () => {
  const beats = [2, 4, 6, 8, 10].map((time, index) => beat(`same${index}`, time, index === 4 ? 3300 : 300));
  const result = camera(beats, beats.map((b) => decision(b, 2)), 12);
  assert.ok(at(result, 11).x > at(result, 8.5).x + 500);
});

test("higher-priority repeat retains its zone under the move cap", () => {
  const beats = [2, 3.5, 5, 6.5, 8, 9.5].map((time, index) =>
    beat(`priority${index}`, time, index < 2 || index % 2 ? 300 : 3300));
  const decisions = beats.map((b, index) => decision(b, index === 0 ? 0 : 2));
  const result = camera(beats, decisions, 11);
  assert.ok(at(result, 2.2).w < 3000);
});

test("four-moves-per-ten-seconds limit discards lowest-importance excess", () => {
  const beats = [1, 3, 5, 7, 9].map((time, index) => beat(`b${index}`, time, index % 2 ? 3300 : 300));
  const decisions = beats.map((b, index) => decision(b, index === 0 ? 0 : 2));
  const result = camera(beats, decisions, 11);
  // The low-importance first target is discarded, so it has not zoomed by its arrival.
  assert.equal(at(result, 1.1).w, baseWidth(3840, 2160));
});

test("later targets wait until the action shot is visible", () => {
  const action = beat("action", 2, 300);
  action.zones.push({ ...zone("result", [3300, 900, 180, 120]), t_change: 2 });
  const withResult = camera([action], [{ ...decision(action), B: "result" }], 6);
  const actionOnly = camera([action], [decision(action)], 4);
  assert.deepEqual(at(withResult, 1.9), at(actionOnly, 1.9));
  assert.ok(at(withResult, 4.5).x > 1000); // after the action shot's minimum dwell

  const next = beat("next", 3.3, 3300);
  assert.deepEqual(at(camera([action, next], [decision(action), decision(next)], 5), 1.9),
    at(actionOnly, 1.9));

  const idle = beat("idle-widen", 0.5, 2500, "idle");
  idle.t0 = 0;
  idle.t1 = 5;
  idle.zones[0]!.bbox = [2100, 600, 1400, 900];
  // The idle beat holds (no shot) and its breathe target cannot preempt the action.
  assert.deepEqual(at(camera([action, idle], [decision(action), decision(idle)], 5), 1.9),
    at(actionOnly, 1.9));
});

test("cut move waits until changed_frac remains settled for 300ms", () => {
  const cut = beat("cut", 2, 2800, "cut");
  cut.changed_frac = [
    { t: 2, f: 0.5 },
    { t: 2.2, f: 0.3 },
    { t: 2.4, f: 0.01 },
    { t: 2.7, f: 0.01 },
  ];
  const result = camera([cut], [decision(cut)], 5);
  assert.equal(at(result, 2.5).w, baseWidth(3840, 2160));
  assert.ok(at(result, 3.5).w < 3840);
});

test("scroll is never chased", () => {
  const scroll = beat("scroll", 2, 3000, "scroll");
  assert.equal(at(camera([scroll], [decision(scroll, 2)], 4), 3).w, baseWidth(3840, 2160));
});

test("long, distant high-zoom pans hop through a wider midpoint", () => {
  const first = beat("first", 2, 300);
  const next = beat("next", 5, 3300);
  const result = camera([first, next], [decision(first), decision(next)], 7);
  assert.ok(at(result, 4.3).w > at(result, 3.4).w);
  assert.ok(at(result, 4.3).w > at(result, 4.9).w);
});

test("long idle gap breathes back to the window framing", () => {
  const activity = beat("activity", 1, 2600);
  const idle: Beat = {
    id: "idle",
    t0: 2,
    t1: 7,
    anchor_t: 2,
    actions: [],
    zones: [{ name: "all", type: "all", bbox: [0, 0, 3840, 2160] }],
    kind: "idle",
  };
  const result = camera([activity, idle], [decision(activity), decision(idle)], 8);
  assert.ok(at(result, 2).w < 3000);
  assert.ok(at(result, 5).w > 3700);
});

test("timestamped pointer actions follow interpolation, not the final position early", () => {
  const drag = beat("drag", 2, 1900, "drag");
  drag.t0 = 1;
  drag.t1 = 5;
  drag.zones[0]! = zone("drag", [1700, 900, 400, 200]);
  drag.actions = [{ t: 1000, x: 0, y: 1080 }, { t: 5000, x: 3840, y: 1080 }];
  const moving = camera([drag], [decision(drag)], 5);
  const stationary = camera([{ ...drag, actions: [{ t: 1000, x: 0, y: 1080 }, { t: 5000, x: 0, y: 1080 }] }], [decision(drag)], 5);
  assert.deepEqual(at(moving, 1), at(stationary, 1));
  assert.ok(at(moving, 4).x > at(stationary, 4).x + 100);
});

test("ultrawide whole-screen viewport is 16:9 and covers every source pixel", () => {
  const f = solveCamera([], [], { width: 3440, height: 1440, trim_end: 1 })[0]!;
  assert.ok(Math.abs(f.w / f.h - 16 / 9) < 1e-9);
  assert.ok(f.x <= 0 && f.y <= 0 && f.x + f.w >= 3440 && f.y + f.h >= 1440);
});

test("invalid planner references fail before rendering", () => {
  const b = beat("a", 2, 300);
  assert.throws(() => camera([b], []), /missing decision/);
  assert.throws(() => camera([b], [{ ...decision(b), A: "missing" }]), /unknown zone/);
  assert.throws(() => camera([b], [{ ...decision(b), B: "missing" }]), /unknown zone/);
  assert.throws(() => camera([b], [{ ...decision(b), B: "" }]), /unknown zone/);
  assert.doesNotThrow(() => camera([b], [decision(b)]));
  assert.throws(() => camera([b], [{ ...decision(b), L: 4 as 3 }]), /invalid or missing decision/);
});

test("camera rejects unusable take, planner, and event inputs", () => {
  const valid = () => {
    const b = beat("validated", 2, 300, "cut");
    b.window_rect = [0, 0, 3840, 2160];
    b.zones[0]!.t_change = 2;
    b.changed_frac = [{ t: 2, f: 0.1 }];
    b.actions = [{ k: "ptr", t: 2000, x: 350, y: 950 }];
    return b;
  };
  const take = { width: 3840, height: 2160, trim_start: 0, trim_end: 4 };
  const b = valid();
  assert.ok(solveCamera([b], [decision(b, 2)], take).length > 0);
  for (const patch of [
    { width: 0 }, { height: NaN }, { trim_start: -1 },
    { trim_end: Infinity }, { trim_start: 4, trim_end: 2 },
  ]) assert.throws(() => solveCamera([b], [decision(b)], { ...take, ...patch }), /invalid/);
  for (const change of [
    (item: Beat) => { item.anchor_t = NaN; },
    (item: Beat) => { item.t0 = Infinity; },
    (item: Beat) => { item.t1 = -1; },
    (item: Beat) => { item.zones[0]!.bbox = [300, 900, 0, 120]; },
    (item: Beat) => { item.zones[0]!.bbox = [3800, 900, 180, 120]; },
    (item: Beat) => { item.window_rect = [0, 0, 4000, 2160]; },
    (item: Beat) => { item.zones[0]!.t_change = NaN; },
    (item: Beat) => { item.changed_frac = [{ t: NaN, f: 0.1 }]; },
    (item: Beat) => { item.changed_frac = [{ t: 2, f: 2 }]; },
    (item: Beat) => { item.actions = [{ k: "ptr", t: NaN, x: 350, y: 950 }]; },
    (item: Beat) => { item.actions = [{ k: "ptr", t: 2000, x: NaN, y: 950 }]; },
    (item: Beat) => { item.actions = [{ k: "ptr", t: 2000, x: 350, y: 4000 }]; },
  ]) {
    const broken = valid();
    change(broken);
    assert.throws(() => solveCamera([broken], [decision(broken)], take), /invalid/);
  }
  assert.throws(() => solveCamera([b], [{ ...decision(b), K: undefined as unknown as 2 }], take), /invalid/);
  assert.throws(() => solveCamera([b], [{ ...decision(b), K: 3 as 2 }], take), /invalid/);
});

test("camera rejects ambiguous identities and times outside beats", () => {
  const b = beat("unique", 2, 300);
  const d = decision(b);
  assert.ok(camera([b], [d], 4).length > 0);
  assert.throws(() => camera([{ ...b, anchor_t: 20 }], [d], 4), /invalid/);
  assert.throws(() => camera([{ ...b, zones: [{ ...b.zones[0]!, t_change: 20 }] }], [d], 4), /invalid/);
  assert.throws(() => camera([b, { ...b }], [d], 4), /invalid/);
  assert.throws(() => camera([{ ...b, zones: [b.zones[0]!, { ...b.zones[0]! }] }], [d], 4), /invalid/);
  assert.throws(() => camera([b], [d, { ...d }], 4), /invalid/);
  assert.throws(() => camera([b], [d, { ...d, beat: "unknown" }], 4), /invalid/);
});

test("trimmed beats and targets cannot steer visible frames", () => {
  const take = { width: 3840, height: 2160, trim_start: 10, trim_end: 12 };
  const visible = beat("visible", 11, 3000);
  const before = beat("before", 1, 300);
  const after = beat("after", 13, 300);
  const alone = solveCamera([visible], [decision(visible)], take);
  assert.deepEqual(solveCamera([before, visible, after],
    [decision(before), decision(visible), decision(after)], take), alone);
  assert.deepEqual(solveCamera([before, after], [decision(before), decision(after)], take),
    solveCamera([], [], take));

  const result = beat("result", 10.3, 300);
  result.t0 = 9.5;
  result.t1 = 11;
  result.zones.push({ ...zone("B", [3300, 900, 180, 120]), t_change: 9.9 });
  const withoutResult = solveCamera([result], [decision(result)], { ...take, trim_end: 11 });
  assert.deepEqual(solveCamera([result], [{ ...decision(result), B: "B" }],
    { ...take, trim_end: 11 }), withoutResult);

  const late = beat("late", 11.4, 3000);
  late.t0 = 10.5;
  late.t1 = 12.4;
  assert.deepEqual(solveCamera([late], [decision(late)], { ...take, trim_end: 11 }),
    solveCamera([], [], { ...take, trim_end: 11 }));
  const lateCut = { ...late, id: "late-cut", kind: "cut" as const,
    changed_frac: [{ t: 11.5, f: 0.01 }] };
  assert.deepEqual(solveCamera([lateCut], [decision(lateCut)], { ...take, trim_end: 11 }),
    solveCamera([], [], { ...take, trim_end: 11 }));

  const idle = beat("idle-trim", 10.2, 300, "idle");
  idle.t0 = 7;
  idle.t1 = 11;
  // Idle beats hold; the breathe target lands before trim and must not steer.
  assert.deepEqual(solveCamera([idle], [decision(idle)], { ...take, trim_end: 11 }),
    solveCamera([], [], { ...take, trim_end: 11 }));
});

test("FOLLOW ignores a drag whose shot arrives after trim", () => {
  const take = { width: 3840, height: 2160, trim_start: 10, trim_end: 11 };
  const first = beat("first", 10.2, 300);
  first.t0 = 9.7;
  first.t1 = 11;
  const late = beat("late-drag", 11.4, 300, "drag");
  late.t0 = 10.5;
  late.t1 = 12.4;
  late.actions = [{ k: "ptr", t: 10500, x: 3840, y: 1080 }];
  assert.deepEqual(solveCamera([first, late], [decision(first), decision(late)], take),
    solveCamera([first], [decision(first)], take));

  const active = beat("active-drag", 10.4, 300, "drag");
  active.t0 = 10.2;
  active.t1 = 11;
  active.actions = [{ k: "ptr", t: 10200, x: 3840, y: 1080 }];
  const withoutPointer = { ...active, actions: [] };
  assert.notDeepEqual(solveCamera([active], [decision(active)], take, noBookends),
    solveCamera([withoutPointer], [decision(withoutPointer)], take, noBookends));
});

test("the first shot waits for the establishing hold and the take ends wide", () => {
  const early = { ...beat("early", 0.3, 2600), t0: 0 };
  const result = solveCamera([early], [decision(early)],
    { width: 3840, height: 2160, trim_start: 0, trim_end: 8 });
  // Still wide until the move toward the establish-delayed arrival starts.
  // Accepted padded-viewport change includes the full rest margin.
  const paddedW = baseWidth(3840, 2160);
  assert.deepEqual(result[10], { t: 10 / DEFAULTS.fps, x: (3840 - paddedW) / 2, y: (2160 - paddedW * 9 / 16) / 2, w: paddedW, h: paddedW * 9 / 16 });
  assert.ok(result[Math.round(DEFAULTS.establish_s * DEFAULTS.fps) + 3]!.w < 3000);
  assert.ok(result.at(-1)!.w > 3839);
  const kept = solveCamera([early], [decision(early)],
    { width: 3840, height: 2160, trim_start: 0, trim_end: 8 }, noBookends);
  assert.ok(kept[10]!.w < paddedW && kept.at(-1)!.w < 3000);
});

test("frame samples have smooth log zoom and fixed aspect", () => {
  const first = beat("first", 1, 2800);
  const second = beat("second", 3, 500, "type");
  second.actions = [{ x: 700, y: 900 }];
  const result = camera([first, second], [decision(first), decision(second)], 5);
  assert.equal(result.length, 5 * DEFAULTS.fps + 1);
  for (let index = 1; index < result.length; index++) {
    const current = result[index]!
    const previous = result[index - 1]!;
    assert.ok(Math.abs(current.w / current.h - 16 / 9) < 1e-9);
    assert.ok(Math.abs(Math.log(current.w / previous.w)) < 0.5);
  }
});

test("render CLI rejects unknown and malformed override arguments", () => {
  for (const args of [["--sset", "fps=24"], ["--set", "fps=24=30"], ["--set", "fps=24", "extra"]]) {
    const result = spawnSync(process.execPath,
      ["--experimental-strip-types", "src/cli.ts", "render", ".", ...args],
      { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown option|invalid --set/);
  }
});

test("--set overrides validate values", () => {
  assert.equal(applyOverrides({ fps: 24 }).fps, 24);
  assert.equal(applyOverrides({}).preset, "slow"); // shipped default unchanged
  assert.equal(applyOverrides({ preset: "veryfast" }).preset, "veryfast");
  assert.throws(() => applyOverrides({ preset: "ludicrous" }));
  assert.throws(() => applyOverrides({ unknown: 1 } as never));
  for (const overrides of [
    { fps: 0 }, { out_w: 0 }, { out_h: -2 }, { max_upscale: 0 },
    { rate_max: 0 }, { rate_window: 0 }, { move_t_min: -1 },
    { move_t_min: 2, move_t_max: 1 }, { hop_t_scale: 0 },
    { follow_omega: 0 }, { deadzone_margin: 0.5 }, { follow_inner: 2 },
  ]) assert.throws(() => applyOverrides(overrides), /invalid|must be at least/);
});

test("render without trim_end uses the latest beat end", { timeout: 120_000, skip: needsFfmpeg }, async () => {
  const dir = await mkdtemp(join(process.cwd(), "takeone:duration-"));
  try {
    await mkdir(join(dir, "analysis"));
    // mpeg4, not VP9: software VP9 stalls weak CI runners; input codec is
    // incidental here (see buildTake in make.test.ts for the full rationale).
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=2",
      "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska",
      "-y", join(dir, "screen.webm"),
    ]);
    const later = { ...beat("later", 0.8, 20), t0: 0.2, t1: 1.8,
      zones: [zone("later", [20, 20, 40, 30])] };
    const earlier = { ...beat("earlier", 0.7, 80), t0: 0.1, t1: 1.2,
      zones: [zone("earlier", [80, 20, 40, 30])] };
    await writeFile(join(dir, "take.json"), JSON.stringify({ id: "duration", width: 320, height: 180 }));
    await writeFile(join(dir, "analysis/beats.json"), JSON.stringify([later, earlier]));
    await writeFile(join(dir, "analysis/decisions.jsonl"),
      [decision(later), decision(earlier)].map((d) => JSON.stringify(d)).join("\n") + "\n");
    const output = (await renderTake(dir, FAST)).out;
    const frames = JSON.parse(await readFile(join(dir, "camera.json"), "utf8"));
    assert.equal(frames.at(-1).t, 1.8);
    const count = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=nb_frames", "-of", "default=noprint_wrappers=1:nokey=1", output],
    { encoding: "utf8" });
    assert.equal(Number(count.trim()), Math.round(1.8 * DEFAULTS.fps));
    // Square pixels must survive per-frame crop-size changes (ffmpeg 6.1
    // stalls on per-frame SAR changes; see setsar=1 each side of scale).
    const sar = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=sample_aspect_ratio", "-of", "default=noprint_wrappers=1:nokey=1", output],
    { encoding: "utf8" });
    assert.equal(sar.trim(), "1:1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("synthetic source renders silent H.264 at the configured size and 60fps", {
  timeout: 120_000, skip: needsFfmpeg,
}, async () => {
  const dir = await mkdtemp(join(process.cwd(), "takeone:render-"));
  try {
    await mkdir(join(dir, "analysis"));
    // Tiny fixtures: a 4K source stalled a weak CI runner past the test
    // timeout (software scale + x264). Resolution is incidental here - only
    // the rendered MP4 codec, size and frame count are asserted - and the
    // shipped 1920x1080 default is untouched (see DEFAULTS). Matroska muxer
    // because stock webm allows only VP8/VP9/AV1; the pipeline probes
    // content, so the .webm name is cosmetic.
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=2",
      "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska",
      "-y", join(dir, "screen.webm"),
    ]);
    await writeFile(join(dir, "take.json"), JSON.stringify({
      id: "fixture", width: 320, height: 180, trim_start: 0, trim_end: 2,
    }));
    const fixtureBeat = beat("fixture", 0.6, 2600);
    // Small-frame zone: the default helper zone sits in 4K coordinates and
    // would fail input validation before the take-id check below runs.
    fixtureBeat.zones = [zone("fixture", [20, 20, 40, 30])];
    await writeFile(join(dir, "analysis/beats.json"), JSON.stringify([fixtureBeat]));
    await writeFile(join(dir, "analysis/decisions.jsonl"), `${JSON.stringify(decision(fixtureBeat))}\n`);

    await writeFile(join(dir, "take.json"), JSON.stringify({
      id: "../../other", width: 320, height: 180, trim_start: 0, trim_end: 2,
    }));
    await assert.rejects(renderTake(dir), /invalid take id/);
    await writeFile(join(dir, "take.json"), JSON.stringify({
      id: "fixture", width: 320, height: 180, trim_start: 0, trim_end: 2,
    }));
    const output = (await renderTake(dir, FAST)).out;
    const probe = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries",
      "stream=width,height,nb_frames,codec_name,r_frame_rate,color_range,color_space,color_transfer,color_primaries", "-of", "json", output,
    ], { encoding: "utf8" })).streams[0];
    assert.deepEqual(probe, { codec_name: "h264", width: 320, height: 180, color_range: "tv",
      color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", r_frame_rate: "60/1", nb_frames: "120" });
    for (const quality of ["draft", "standard", "master"] as const) {
      await renderTake(dir, { ...FAST, quality });
      const first = await readFile(output);
      await renderTake(dir, { ...FAST, quality });
      assert.deepEqual(await readFile(output), first, `${quality} must encode byte-identically`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("L1 frames a real window, but pads the zone inside a fullscreen window", () => {
  const button = zone("button", [3300, 30, 300, 80]);
  const windowed = frame(button, 1, 3840, 2160, [1920, 0, 1920, 1080]);
  // Accepted padded-viewport change measures zoom against the padded canvas.
  assert.equal(windowed.z, baseWidth(3840, 2160) / 1920);
  const fullscreen = frame(button, 1, 3840, 2160, [0, 0, 3840, 2160]);
  assert.equal(fullscreen.z, zMax(3840, 2160));
  assert.equal(fullscreen.z, frame(button, 1, 3840, 2160).z);
});

test("a long idle inside a fullscreen window breathes out to the whole screen", () => {
  const activity = beat("activity", 1, 2600);
  const idle: Beat = {
    id: "idle", t0: 2, t1: 7, anchor_t: 2, actions: [], kind: "idle",
    window_rect: [0, 0, 3840, 2160],
    zones: [zone("tiny", [2600, 900, 120, 60]), { name: "all", type: "all", bbox: [0, 0, 3840, 2160] }],
  };
  const result = camera([activity, idle], [decision(activity), decision(idle)], 8);
  assert.ok(at(result, 2).w < 3000);
  assert.ok(at(result, 5).w > 3700);
});

test("a short pause between two nearby actions holds instead of pulling out", () => {
  const first = beat("first", 1, 1000);
  const pause: Beat = {
    id: "pause", t0: 2, t1: 4.5, anchor_t: 2.5, actions: [], kind: "idle",
    zones: [{ name: "all", type: "all", bbox: [0, 0, 3840, 2160] }],
  };
  const next = beat("next", 5, 1100);
  const result = camera([first, pause, next], [decision(first), { ...decision(pause), L: 0 }, decision(next)], 6);
  const widest = Math.max(...result.filter((f) => f.t >= 1.8 && f.t <= 5).map((f) => f.w));
  assert.ok(widest < 2000, `widest=${widest}`);
});

test("a result move waits out the minimum dwell after the action shot arrives", () => {
  const action = beat("action", 2, 300);
  action.zones.push({ ...zone("result", [3300, 900, 180, 120]), t_change: 2 });
  const frames = camera([action], [{ ...decision(action), B: "result" }], 6);
  const speed = frames.slice(1).map((f, i) => Math.abs(f.x - frames[i]!.x) + Math.abs(f.w - frames[i]!.w));
  const moving = speed.map((s) => s > 2);
  // find the first hold after the camera first moves, and check it lasts
  const firstMove = moving.indexOf(true);
  const holdStart = moving.indexOf(false, firstMove);
  const holdEnd = moving.indexOf(true, holdStart);
  assert.ok(holdEnd < 0 || (holdEnd - holdStart) / DEFAULTS.fps >= DEFAULTS.dwell, `hold ${(holdEnd - holdStart) / DEFAULTS.fps}s`);
});

test("a typing beat does not chase its earlier click points off the result shot", () => {
  const typing = beat("typing", 1, 1500, "type");
  typing.t1 = 6;
  typing.actions = [{ t: 1000, x: 1600, y: 300 }];
  typing.zones.push({ ...zone("menu", [1500, 1500, 400, 200]), t_change: 3 });
  const frames = camera([typing], [{ ...decision(typing), B: "menu" }], 6);
  const last = frames.at(-1)!;
  assert.ok(last.y <= 1500 && last.y + last.h >= 1700, `menu cropped: y=${last.y} h=${last.h}`);
});

test("the move cap never drops the breathe out of a long closing idle", () => {
  const busy = [1, 2.5, 4, 5.5].map((time, index) => beat(`busy${index}`, time, index % 2 ? 3300 : 300));
  const idle: Beat = {
    id: "closing", t0: 6.5, t1: 14, anchor_t: 6.5, actions: [], kind: "idle",
    zones: [{ name: "all", type: "all", bbox: [0, 0, 3840, 2160] }],
  };
  const result = camera([...busy, idle], [...busy.map((b) => decision(b, 2)), decision(idle)], 14);
  assert.ok(at(result, 5.6).w < 3000);
  assert.ok(at(result, 12).w > 3700, `still close at the end: w=${at(result, 12).w}`);
});

test("a whole-stage shot during the establish hold does not crowd out the shot behind it", () => {
  const click = beat("click", 0.6, 3300);
  const typing = beat("typing", 1.7, 1500, "type");
  const frames = solveCamera([click, typing], [{ ...decision(click), L: 0 }, decision(typing)],
    { width: 3840, height: 2160, trim_start: 0, trim_end: 6 });
  assert.ok(at(frames, 3.5).w < 3000, `typing never framed: w=${at(frames, 3.5).w}`); // before the outro
});

test("opposite zooms hold for min_shot, including result targets", () => {
  const action = beat("zoom", 1, 1200);
  action.t1 = 3;
  action.zones.push({ name: "wide", type: "all", bbox: [0,0,3840,2160], t_change: 1.1 });
  const frames = solveCamera([action], [{ ...decision(action), B: "wide" }],
    { width:3840,height:2160,trim_end:7 }, {...noBookends, dwell:0.2,min_shot:1.5});
  const speed = frames.slice(1).map((f,i)=>Math.log(frames[i]!.w/f.w)*30);
  const first = speed.findIndex(v=>v>0.01);
  const hold = speed.findIndex((v,i)=>i>first && Math.abs(v)<=0.01);
  const opposite = speed.findIndex((v,i)=>i>hold && v < -0.01);
  assert.ok(opposite > hold && (opposite-hold)/30 >= 1.5, `hold=${(opposite-hold)/30}`);
});

test("Tidewater holds whole cards, retains enclosing context and balances the visible cluster", () => {
  // Tight composition requires explicit enlargement at this source/output size.
  const contextDefaults = { ...DEFAULTS, max_upscale: 1.5 };
  const boxes: Zone['bbox'][] = [
    [336, 200, 488, 132], [336, 348, 488, 132], [336, 496, 488, 132],
    [888, 200, 488, 132], [888, 348, 488, 132],
    [1440, 200, 488, 132], [1440, 348, 488, 132], [1984, 128, 544, 1272],
    [0, 0, 2560, 88], [0, 88, 280, 1352],
  ];
  const b: Beat = { id: 'board', kind: 'click', t0: 2, t1: 10, anchor_t: 3, actions: [],
    zones: [{ ...zone('focus', [1080, 375, 80, 56]), boxes }] };
  const frames = solveCamera([b], [decision(b)], { width: 2560, height: 1440, trim_end: 10 }, contextDefaults);
  for (const crop of frames.filter(f => f.t >= 4 && f.t <= 7)) {
    assert.ok(clippedFractions(crop, boxes).every(f => f === 0 || f >= HIGH_CLIP_FRACTION), `half card at ${crop.t}`);
    const panel = boxes[4]!;
    assert.equal(clippedFractions(crop, [panel])[0], 0);
    assert.ok(panel[0] - crop.x >= crop.w * .01 && crop.x + crop.w - panel[0] - panel[2] >= crop.w * .005);
    assert.ok(crop.w < 1800, 'widen only enough to hold the cards between the side panels');
    // The two visible columns are centred, rather than the clicked field alone.
    assert.ok(Math.abs(crop.x + crop.w / 2 - (336 + 1928) / 2) < crop.w * .06);
  }
  const modal: Zone = { ...zone('field', [944, 450, 200, 56]), type: 'txt', boxes: [[900, 340, 760, 620]] };
  const state = frame(modal, 3, 2560, 1440, undefined, contextDefaults);
  const w = baseWidth(2560, 1440, contextDefaults) / state.z;
  const crop = { x: state.cx - w / 2, y: state.cy - w * 9 / 32, w, h: w * 9 / 16 };
  assert.equal(clippedFractions(crop, modal.boxes!)[0], 0);
  assert.ok(crop.h >= 620 * DEFAULTS.hold_pad, 'zoom relaxes to fit the enclosing dialog');
  // A panel taller than the minimum crop forces a wider hold, including at screen edges.
  const tall: Zone = { ...zone('edge-field', [2400, 250, 80, 56]), boxes: [[1984, 128, 544, 1272]] };
  const edgeState = frame(tall, 3, 2560, 1440, undefined, contextDefaults);
  const edgeW = baseWidth(2560, 1440, contextDefaults) / edgeState.z;
  assert.equal(clippedFractions({ x: Math.min(2560 - edgeW, edgeState.cx - edgeW / 2),
    y: Math.max(0, edgeState.cy - edgeW * 9 / 32), w: edgeW, h: edgeW * 9 / 16 }, tall.boxes!)[0], 0);
});

test("a dialog close reveals its result despite dwell, shot suppression and pointer follow", () => {
  const board = new Uint8Array(160 * 90).fill(230);
  const fadeOut = [222, 214, 206, 198, 190].map((level) => board.map(() => level));
  const created = board.slice();
  for (let y = 10; y < 25; y++) created.fill(90, y * 160 + 10, y * 160 + 40);
  for (let y = 65; y < 75; y++) created.fill(80, y * 160 + 110, y * 160 + 135);
  const fadeIn = [198, 206, 214, 222].map((level) => board.map(() => level));
  for (let y = 10; y < 25; y++) fadeIn.at(-1)!.fill(90, y * 160 + 10, y * 160 + 40);
  for (let y = 65; y < 75; y++) fadeIn.at(-1)!.fill(80, y * 160 + 110, y * 160 + 135);
  const dialogFrames = [board, ...fadeOut, ...fadeIn, created];
  const times = dialogFrames.map((_, index) => 1300 + index * 100);
  const results = dialogResults(dialogFrames, times, [],
    { w: 160, h: 90, streamW: 3840, streamH: 2160 });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.t, 2300);
  const [resultX, resultY, resultW, resultH] = results[0]!.bbox;
  assert.ok(resultX <= 10 * 24 && resultY <= 10 * 24);
  assert.ok(resultX + resultW >= 135 * 24 && resultY + resultH >= 75 * 24);
  const modal = beat("modal", 1, 2200);
  modal.t1 = 4;
  const close = beat("close", 1.2, 2200, "drag");
  close.t1 = 4;
  close.actions = [{ k: "ptr", t: 2200, x: 3000, y: 1800 }];
  close.dialog_results = results.map((result) => ({ ...result, t: result.t / 1000 }));
  // The close's action shot is suppressed by min_shot, but its result is kept.
  const frames = camera([modal, close], [decision(modal), decision(close)], 4);
  for (const f of frames.filter((f) => f.t >= 2.2 && f.t <= 3.3)) {
    assert.ok(f.x <= resultX && f.y <= resultY
      && f.x + f.w >= resultX + resultW && f.y + f.h >= resultY + resultH,
      `result cropped at ${f.t}`);
  }
  const warped = warpBeats([close], 0, [{ a: 0, b: 1 }], 4)[0]!;
  assert.ok(Math.abs(warped.dialog_results![0]!.t - 1.55) < 1e-9);
});


test("master blur preserves full-resolution chroma through production rendering", { skip: needsFfmpeg }, async () => {
  const dir = await mkdtemp(join(process.cwd(), "takeone-chroma-"));
  try {
    const width = 160, height = 90, plane = width * height;
    const source = Buffer.alloc(plane * 3, 128);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      source[plane + y * width + x] = x % 2 ? 176 : 80;
    }
    const input = join(dir, "source.yuv");
    await writeFile(input, source);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-stream_loop", "-1", "-f", "rawvideo",
      "-pix_fmt", "yuv444p", "-s", "160x90", "-r", "10", "-i", input,
      "-t", "0.6", "-c:v", "ffv1", "-f", "matroska", join(dir, "screen.webm")]);
    await mkdir(join(dir, "analysis"));
    await writeFile(join(dir, "analysis/beats.json"), "[]");
    await writeFile(join(dir, "analysis/decisions.jsonl"), "");
    await writeFile(join(dir, "take.json"), JSON.stringify({ id: "chroma", width, height,
      trim_end: 0.6, blur: [{ t: 0.2, d: 0.2, rect: [10, 10, 30, 20] }] }));
    const { out } = await renderTake(dir, { ...FAST, quality: "master", out_w: width, out_h: height,
      fps: 10, stage_margin: 0, corner_radius: 0, motion_blur: 0 });
    const format = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=pix_fmt", "-of", "default=nw=1:nk=1", out], { encoding: "utf8" });
    assert.equal(format.trim(), "yuv444p");
    const pixels = execFileSync("ffmpeg", ["-v", "error", "-i", out,
      "-pix_fmt", "yuv444p", "-f", "rawvideo", "-"], { maxBuffer: 1_000_000 });
    assert.equal(pixels.length, 6 * plane * 3);
    const contrast = (frame: number, x: number, y: number) => {
      const at = frame * plane * 3 + plane + y * width + x;
      return Math.abs(pixels[at]! - pixels[at + 1]!);
    };
    for (let frame = 0; frame < 6; frame++) {
      assert.ok(contrast(frame, 80, 45) > 60, `outside blur frame ${frame}`);
      if (frame === 2 || frame === 3) assert.ok(contrast(frame, 20, 20) < 10, `active blur frame ${frame}`);
      else assert.ok(contrast(frame, 20, 20) > 60, `inactive blur frame ${frame}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a dwell before a curved drag cannot hide the object or regress the next action", async () => {
  const { actionsFromEvents } = await import("../src/perceive/actions.ts");
  const { gestures, gesturePointer } = await import("../src/camera/gesture.ts");
  const { framingCoverage } = await import("../scripts/check-framing.ts");
  const { warpBeats } = await import("../src/render/pace.ts");
  const actions = actionsFromEvents([
    { k: "ptr", t: 2000, x: 400, y: 900 },
    { k: "btn", t: 2000, b: "left", down: true },
    { k: "ptr", t: 2500, x: 400, y: 900 },
    { k: "ptr", t: 3000, x: 1700, y: 1400 },
    { k: "ptr", t: 4000, x: 3000, y: 900 },
    { k: "btn", t: 4000, b: "left", down: false },
  ], [{ t: 2100, changed_frac: 0.02, cut: false,
    regions: [{ bbox: [200, 800, 500, 200], area_frac: 0.012 }] }],
  { stream: { w: 3840, h: 2160 }, pointer: "mapped" });
  const drag: Beat = { ...beat("drag-resolve", 1.5, 300, "drag"), t0: 1, t1: 5,
    actions: [{ k: "dwell", t0: 1000, t1: 1900, x: 3500, y: 100 }, ...actions],
    zones: [zone("object", [200, 800, 500, 200])] };
  const g = gestures(drag)[0]!;
  drag.actions.push({ ...g, k: "travel" });
  assert.equal(gestures(drag).length, 1);
  assert.equal(g.whole_object, undefined);
  g.whole_object = [200, 800, 500, 200];
  assert.deepEqual(gesturePointer(g, 2.5), [400, 900]);
  assert.deepEqual(gesturePointer(g, 3), [1700, 1400]);
  const warped = warpBeats([drag], 0, [{ a: 0, b: 1 }], 4)[0]!;
  assert.deepEqual(gesturePointer(gestures(warped)[0]!, 2.25), [1700, 1400]);
  const next = beat("handoff", 5.5, 3300);
  next.t0 = 5.2;
  next.t1 = 7;
  const solved = camera([drag, next], [decision(drag), decision(next)], 8);
  const rows = framingCoverage([drag, next], solved, solved);
  assert.ok(rows.every(r => r.passed), JSON.stringify(rows));
  assert.equal(rows[0]!.dragFrames, 121);
  // Prove the check catches a lost acted-on control, not merely missing cursors.
  const clipped = solved.map(f => f.t >= next.t0 && f.t <= next.t1
    ? { ...f, x: 0, y: 0, w: 100, h: 100 } : f);
  assert.ok(framingCoverage([drag, next], solved, clipped)[1]!.lost > 0);
  const invalid = { ...drag, actions: [{ ...g, path: [{ t: 3000, x: NaN, y: 1400 }] }] };
  assert.throws(() => camera([invalid], [decision(invalid)], 8), /invalid/);
});

test("paused pickup rejects changed-pixel footprints and preserves established whole objects", async () => {
  const { actionsFromEvents } = await import("../src/perceive/actions.ts");
  const { gestures, gesturePointer, applyDragVisibility } = await import("../src/camera/gesture.ts");
  const { framingCoverage, contains } = await import("../scripts/check-framing.ts");
  const events: Event[] = [
    { k: "ptr" as const, t: 8000, x: 2500, y: 1000 },
    { k: "btn" as const, t: 8000, b: "left", down: true },
    { k: "ptr" as const, t: 8600, x: 2500, y: 1000 },
    { k: "ptr" as const, t: 10000, x: 3300, y: 1000 },
    { k: "ptr" as const, t: 11000, x: 2500, y: 1000 },
    { k: "btn" as const, t: 12000, b: "left", down: false },
  ];
  const changed = { t: 10000, changed_frac: 0.025, cut: false,
    regions: [{ bbox: [2800, 900, 1000, 200] as [number, number, number, number], area_frac: 0.025 }] };
  const highlight = { t: 8100, changed_frac: 0.005, cut: false,
    regions: [{ bbox: [2400, 900, 200, 200] as [number, number, number, number], area_frac: 0.005 }] };
  const previous: Beat = { ...beat("settled-card", 4, 2000), t0: 0, t1: 7,
    zones: [zone("card", [2000, 900, 1000, 200])] };
  const next: Beat = { ...beat("after-drop", 13, 2500), t0: 12.1, t1: 15 };
  for (const released of [true, false]) {
    for (const known of [true, false]) {
      const actions = actionsFromEvents(released ? events : events.slice(0, -1),
        [highlight, changed, { ...changed, t: 13000 }], { stream: { w: 3840, h: 2160 }, pointer: "mapped", endMs: 12000 });
      const drag: Beat = { ...beat("paused-card", 8, 2000, "drag"), t0: 7.5, t1: 12,
        zones: [zone("card", [2000, 900, 1000, 200])], actions };
      const g = gestures(drag)[0]!;
      assert.ok(g);
      assert.equal(g.whole_object, undefined);
      assert.equal((g as { subject?: unknown }).subject, undefined);
      if (known) g.whole_object = [2000, 900, 1000, 200];
      else Object.assign(g, { subject: [2400, 900, 200, 200] });
      assert.deepEqual(gesturePointer(g, 8.5), [2500, 1000]);
      assert.deepEqual(gesturePointer(g, 10), [3300, 1000]);
      assert.deepEqual(gesturePointer(g, 11), [2500, 1000]);
      assert.equal(g.t0, 8000);
      assert.equal(g.t1, 12000);
      const warped = warpBeats([drag], 0, [{ a: 0, b: 1 }], 4)[0]!;
      assert.deepEqual(gestures(warped)[0]!.whole_object, g.whole_object);
      assert.deepEqual(gesturePointer(gestures(warped)[0]!, 9.25), [3300, 1000]);
      const beats = [previous, drag, next];
      const baseline = camera(beats.map(b => ({ ...b, actions: [] })), beats.map(b => decision(b)), 16);
      const solved = camera(beats, beats.map(b => decision(b)), 16);
      const rows = framingCoverage(beats, baseline, solved);
      assert.ok(rows.every(r => r.lost === 0), JSON.stringify(rows));
      assert.equal(rows[1]!.passed, known, JSON.stringify(rows));
      for (const f of solved.filter(f => f.t >= g.t0 / 1000 && f.t <= g.t1 / 1000)) {
        const [x, y] = gesturePointer(g, f.t);
        assert.ok(contains(f, [x - 500, y - 100, 1000, 200]), JSON.stringify(f));
        assert.ok(contains(f, [x - 8, y - 8, 32, 40]), JSON.stringify(f));
        if (!known) assert.ok(contains(f, [0, 0, 3840, 2160]), JSON.stringify(f));
      }
      const reported = [{ t: 10, x: 1463.2, y: 416.8, w: 2073.6, h: 1166.4 }];
      assert.equal(framingCoverage([drag], reported, reported)[0]!.passed, false);
      const invalid = { ...drag, actions: [{ ...g, whole_object: [2000, 900, 2000, 200] }] };
      assert.throws(() => camera([invalid], [decision(invalid)], 16), /invalid/);
      for (const [out_w, out_h] of [[1920, 1080], [1080, 1920], [2560, 1080]]) {
        const aspect = out_w! / out_h!;
        const before = [{ t: 10, x: 1540, y: 500, w: 1920, h: 1920 / aspect }];
        const safe = applyDragVisibility(before, [drag], 3840, 2160, 0, { ...DEFAULTS, out_w: out_w!, out_h: out_h! });
        assert.ok(contains(safe[0]!, [2800, 900, 1000, 200]));
        if (!known) assert.ok(contains(safe[0]!, [0, 0, 3840, 2160]));
      }
    }
  }
});

test("unreleased drag protects every stationary held-tail frame through recording end", async () => {
  const { actionsFromEvents } = await import("../src/perceive/actions.ts");
  const { segmentBeats } = await import("../src/beats/segment.ts");
  const { zonesForBeat } = await import("../src/beats/zones.ts");
  const { idleSqueezes, warp } = await import("../src/render/pace.ts");
  const { gestures, gesturePointer } = await import("../src/camera/gesture.ts");
  const { framingCoverage, contains } = await import("../scripts/check-framing.ts");
  const stream = { w: 3840, h: 2160 };
  const windowRect: [number, number, number, number] = [0, 0, 1920, 1080];
  const events: Event[] = [
    { k: "win" as const, t: 0, cls: "board", title: "Tidewater", rect: windowRect },
    { k: "ptr" as const, t: 8000, x: 1100, y: 800 },
    { k: "btn" as const, t: 8000, b: "left", down: true },
    { k: "ptr" as const, t: 10000, x: 3300, y: 800 },
  ];
  for (const endMs of [30000, 25000]) {
    const extracted = actionsFromEvents(events, [], { stream, pointer: "mapped", endMs });
    const held = extracted.find(a => a.k === "drag")!;
    assert.equal(held.t1, endMs);
    assert.deepEqual(held.to, [3300, 800]);
    assert.deepEqual(held.path, [{ t: 8000, x: 1100, y: 800 }, { t: 10000, x: 3300, y: 800 }]);
    const planned = segmentBeats(extracted, [], { stream, takeMs: 30000, startMs: 0, endMs });
    const beats: Beat[] = JSON.parse(JSON.stringify(planned.map(b => ({
      ...b, t0: b.t0 / 1000, t1: b.t1 / 1000, anchor_t: b.anchor_t / 1000,
      window_rect: windowRect,
      zones: zonesForBeat(b, { stream, scale: 1, winRect: windowRect, frames: [] })
        .map(z => ({ name: z.name, type: z.kind, bbox: z.bbox })),
    }))));
    assert.ok(!beats.some(b => b.kind === "idle" && b.t1 > 10));
    for (const start of [0, 5]) {
      const end = endMs / 1000;
      const squeezes = idleSqueezes(beats, start, end, DEFAULTS);
      assert.ok(squeezes.every(s => s.b <= 8 - start));
      const duration = warp(end - start, squeezes, DEFAULTS.idle_speed);
      const warped = warpBeats(beats, start, squeezes, DEFAULTS.idle_speed)
        .filter(b => b.t1 > start && b.t0 < start + duration);
      const tail = warp(10 - start, squeezes, DEFAULTS.idle_speed);
      const dragBeat = warped.find(b => gestures(b).length)!;
      const g = gestures(dragBeat)[0]!;
      assert.equal(g.t1 / 1000, start + duration);
      assert.deepEqual(gesturePointer(g, start + duration), [3300, 800]);
      const take = { width: stream.w, height: stream.h, trim_start: start, trim_end: start + duration };
      const decisions = warped.map(b => decision(b));
      const baseline = solveCamera(warped.map(b => ({ ...b, actions: [] })), decisions, take, DEFAULTS);
      const solved = solveCamera(warped, decisions, take, DEFAULTS);
      const rows = framingCoverage(warped, baseline, solved, start);
      assert.ok(rows.every(r => r.lost === 0), JSON.stringify(rows));
      const heldFrames = solved.filter(f => f.t >= tail);
      assert.ok(heldFrames.length >= (end - 10) * DEFAULTS.fps);
      for (const f of heldFrames) {
        assert.ok(contains(f, [0, 0, 3840, 2160]), JSON.stringify(f));
        assert.ok(contains(f, [3200, 700, 400, 200]), JSON.stringify(f));
        assert.ok(contains(f, [3292, 792, 32, 40]), JSON.stringify(f));
      }
      assert.ok(rows.find(r => r.beat === dragBeat.id)!.dragFrames >= heldFrames.length);
      g.whole_object = [1000, 700, 400, 200];
      const established = solveCamera(warped, decisions, take, DEFAULTS);
      assert.ok(framingCoverage(warped, baseline, established, start).every(r => r.passed));
      const clipped = established.map(f => f.t >= tail ? { ...f, x: 0, y: 0, w: 1920, h: 1080 } : f);
      assert.ok(framingCoverage(warped, baseline, clipped, start).some(r => r.dragLost >= heldFrames.length));
    }
  }
  const released = actionsFromEvents([...events,
    { k: "btn", t: 12000, b: "left", down: false }], [], { stream, pointer: "mapped", endMs: 30000 });
  assert.equal(released.find(a => a.k === "drag")!.t1, 12000);
});

test("overlapping buttons retain the longer drag through its stationary tail", async () => {
  const { actionsFromEvents } = await import("../src/perceive/actions.ts");
  const { segmentBeats } = await import("../src/beats/segment.ts");
  const { zonesForBeat } = await import("../src/beats/zones.ts");
  const { idleSqueezes, warp } = await import("../src/render/pace.ts");
  const { gestures } = await import("../src/camera/gesture.ts");
  const { framingCoverage, contains } = await import("../scripts/check-framing.ts");
  const stream = { w: 3840, h: 2160 };
  const rect: [number, number, number, number] = [0, 0, 1920, 1080];
  const events: Event[] = [
    { k: "win" as const, t: 0, cls: "board", title: "Tidewater", rect },
    { k: "ptr" as const, t: 8000, x: 1100, y: 800 },
    { k: "btn" as const, t: 8000, b: "left", down: true },
    { k: "ptr" as const, t: 10000, x: 3300, y: 800 },
    { k: "ptr" as const, t: 12000, x: 500, y: 800 },
    { k: "btn" as const, t: 12000, b: "right", down: true },
    { k: "btn" as const, t: 13000, b: "right", down: false },
    { k: "ptr" as const, t: 14000, x: 3300, y: 800 },
  ];
  const actions = actionsFromEvents(events, [], { stream, pointer: "mapped", endMs: 30000 });
  assert.deepEqual(actions.filter(a => a.k === "drag").map(a => [a.t0, a.t1]), [[8000, 30000], [12000, 13000]]);
  const capped = segmentBeats(actions, [], { stream, takeMs: 1000, startMs: 0, endMs: 30000 });
  assert.equal(capped.length, 1);
  assert.equal(capped[0]!.t1, 30000);
  const beats: Beat[] = segmentBeats(actions, [], { stream, takeMs: 30000, startMs: 0, endMs: 30000 }).map(b => ({
    ...b, t0: b.t0 / 1000, t1: b.t1 / 1000, anchor_t: b.anchor_t / 1000, window_rect: rect,
    zones: zonesForBeat(b, { stream, scale: 1, winRect: rect, frames: [] })
      .map(z => ({ name: z.name, type: z.kind, bbox: z.bbox })),
  }));
  const squeezes = idleSqueezes(beats, 0, 30, DEFAULTS);
  const end = warp(30, squeezes, DEFAULTS.idle_speed);
  const tail = warp(14, squeezes, DEFAULTS.idle_speed);
  const warped = warpBeats(beats, 0, squeezes, DEFAULTS.idle_speed);
  for (const shortened of [false, true]) {
    const owners = JSON.parse(JSON.stringify(warped)) as Beat[];
    const owner = owners.find(b => gestures(b).some(g => g.t1 / 1000 === end))!;
    if (shortened) owner.t1 = warp(13, squeezes, DEFAULTS.idle_speed);
    for (const start of [0, tail]) {
      const take = { width: 3840, height: 2160, trim_start: start, trim_end: end };
      const decisions = owners.map(b => decision(b));
      const solved = solveCamera(owners, decisions, take, DEFAULTS);
      const held = solved.filter(f => f.t + start >= tail);
      assert.ok(held.length > 100);
      for (const f of held) {
        assert.ok(contains(f, [0, 0, 3840, 2160]), JSON.stringify(f));
        assert.ok(contains(f, [3292, 792, 32, 40]), JSON.stringify(f));
      }
      const unknown = framingCoverage(owners, solved, solved, start).find(r => r.beat === owner.id)!;
      assert.ok(unknown.dragFrames >= held.length);
      assert.ok(unknown.dragLost >= held.length);
      for (const b of owners) for (const g of gestures(b)) g.whole_object = [g.from[0] - 100, 700, 400, 200];
      const checked = framingCoverage(owners, solved, solved, start).find(r => r.beat === owner.id)!;
      assert.equal(checked.dragLost, 0);
      const clipped = solved.map(f => f.t + start >= tail ? { ...f, x: 0, y: 0, w: 1920, h: 1080 } : f);
      assert.ok(framingCoverage(owners, solved, clipped, start).find(r => r.beat === owner.id)!.dragLost >= held.length);
      for (const b of owners) for (const g of gestures(b)) delete g.whole_object;
    }
    const implicit = solveCamera(owners, owners.map(b => decision(b)), { width: 3840, height: 2160 }, DEFAULTS);
    assert.ok(Math.abs(implicit.at(-1)!.t - end) < 1 / DEFAULTS.fps);
  }
});

test("planning retains released and unreleased drags crossing the actual trim boundary", async () => {
  const { actionsFromEvents } = await import("../src/perceive/actions.ts");
  const { actionVideoSeconds, actionCameraMilliseconds } = await import("../src/beats/clock.ts");
  const { segmentBeats } = await import("../src/beats/segment.ts");
  const { zonesForBeat } = await import("../src/beats/zones.ts");
  const { idleSqueezes, warp } = await import("../src/render/pace.ts");
  const { gestures, gesturePointer } = await import("../src/camera/gesture.ts");
  const { framingCoverage, contains } = await import("../scripts/check-framing.ts");
  const stream = { w: 3840, h: 2160 };
  const rect: [number, number, number, number] = [0, 0, 1920, 1080];
  const events: Event[] = [
    { k: "win" as const, t: 0, cls: "board", title: "Tidewater", rect },
    { k: "ptr" as const, t: 8000, x: 1100, y: 800 },
    { k: "btn" as const, t: 8000, b: "left", down: true },
    { k: "ptr" as const, t: 10000, x: 3300, y: 800 },
    { k: "ptr" as const, t: 12000, x: 500, y: 800 },
    { k: "btn" as const, t: 12000, b: "right", down: true },
    { k: "btn" as const, t: 12100, b: "right", down: false },
    { k: "ptr" as const, t: 14000, x: 3300, y: 800 },
  ];
  for (const released of [false, true]) for (const endMs of [25000, 30000]) {
    const history: Event[] = released ? [...events, { k: "btn" as const, t: 28000, b: "left", down: false }] : events;
    const bounds = { stream, startMs: 9000, endMs };
    const actions = actionsFromEvents(history, [], { ...bounds, pointer: "mapped" });
    const drag = actions.find(a => a.k === "drag")!;
    assert.equal(drag.t0, 8000);
    const planned = segmentBeats(actions, [], { ...bounds, takeMs: 30000 });
    const owner = planned.find(b => b.actions.some(a => a.k === "drag"))!;
    assert.ok(owner);
    assert.equal(owner.t0, 9000);
    assert.equal(owner.t1, Math.min(endMs, drag.t1));
    assert.ok(planned.every(b => b.t0 >= 9000 && b.t1 <= endMs));
    const retained = owner.actions.find(a => a.k === "drag") as typeof drag;
    assert.equal(retained.t0, 9000);
    assert.equal(retained.t1, Math.min(endMs, drag.t1));
    assert.deepEqual(retained.from, [2200, 800]);
    assert.deepEqual(retained.path![0], { t: 9000, x: 2200, y: 800 });
    assert.equal(drag.t0, 8000);
    const beats: Beat[] = JSON.parse(JSON.stringify(planned.map(b => ({
      ...b, t0: b.t0 / 1000, t1: b.t1 / 1000, anchor_t: b.anchor_t / 1000, window_rect: rect,
      actions: b.actions.map(a => actionVideoSeconds(a, 0)),
      zones: zonesForBeat(b, { stream, scale: 1, winRect: rect, frames: [] })
        .map(z => ({ name: z.name, type: z.kind, bbox: z.bbox })),
    }))));
    for (const b of beats) b.actions = b.actions.map(actionCameraMilliseconds);
    const start = 9;
    const end = endMs / 1000;
    const squeezes = idleSqueezes(beats, start, end, DEFAULTS);
    const duration = warp(end - start, squeezes, DEFAULTS.idle_speed);
    const warped = warpBeats(beats, start, squeezes, DEFAULTS.idle_speed);
    const take = { width: stream.w, height: stream.h, trim_start: start, trim_end: start + duration };
    const decisions = warped.map(b => decision(b));
    const solved = solveCamera(warped, decisions, take, DEFAULTS);
    const heldBeat = warped.find(b => gestures(b).length)!;
    const g = gestures(heldBeat)[0]!;
    const held = solved.filter(f => f.t + start >= g.t0 / 1000 && f.t + start <= g.t1 / 1000);
    assert.ok(held.length > 900);
    for (const f of held) {
      const [x, y] = gesturePointer(g, f.t + start);
      assert.ok(contains(f, [0, 0, 3840, 2160]), JSON.stringify(f));
      assert.ok(contains(f, [x - 8, y - 8, 32, 40]), JSON.stringify(f));
    }
    const unknown = framingCoverage(warped, solved, solved, start).find(r => r.beat === heldBeat.id)!;
    assert.equal(unknown.dragFrames, held.length);
    assert.equal(unknown.dragLost, held.length);
    g.whole_object = [2100, 700, 400, 200];
    const established = solveCamera(warped, decisions, take, DEFAULTS);
    const baseline = solveCamera(warped.map(b => ({ ...b, actions: [] })), decisions, take, DEFAULTS);
    const rows = framingCoverage(warped, baseline, established, start);
    assert.ok(rows.every(r => r.lost === 0));
    assert.equal(rows.find(r => r.beat === heldBeat.id)!.dragLost, 0);
    const clipped = established.map(f => f.t + start >= 16 ? { ...f, x: 0, y: 0, w: 1920, h: 1080 } : f);
    assert.ok(framingCoverage(warped, baseline, clipped, start).find(r => r.beat === heldBeat.id)!.dragLost > 0);
  }
});

test("make and render clocks retain a drag crossing the first video frame without negative history", async () => {
  const { actionsFromEvents } = await import("../src/perceive/actions.ts");
  const { segmentBeats } = await import("../src/beats/segment.ts");
  const { actionVideoSeconds, actionCameraMilliseconds } = await import("../src/beats/clock.ts");
  const { gestures, gesturePointer } = await import("../src/camera/gesture.ts");
  const { framingCoverage, contains } = await import("../scripts/check-framing.ts");
  const rect: [number, number, number, number] = [0, 0, 1920, 1080];
  for (const released of [false, true]) {
    const events: Event[] = [
      { k: "win" as const, t: 0, cls: "board", title: "Tidewater", rect },
      { k: "ptr" as const, t: 900, x: 1100, y: 800 },
      { k: "btn" as const, t: 900, b: "left", down: true },
      { k: "ptr" as const, t: 1100, x: 1500, y: 1000 },
      { k: "ptr" as const, t: 2000, x: 3300, y: 1000 },
      ...(released ? [{ k: "btn" as const, t: 3000, b: "left" as const, down: false }] : []),
    ];
    const stream = { w: 3840, h: 2160 };
    const bounds = { stream, startMs: 1000, endMs: 3000 };
    const raw = actionsFromEvents(events, [], { ...bounds, pointer: "mapped" });
    const rawDrag = raw.find(a => a.k === "drag")!;
    assert.equal(rawDrag.t0, 900);
    const planned = segmentBeats(raw, [], { ...bounds, takeMs: 3000 });
    const clipped = planned.flatMap(b => b.actions).find(a => a.k === "drag")!;
    assert.deepEqual(clipped.from, [1300, 900]);
    assert.deepEqual(clipped.path![0], { t: 1000, x: 1300, y: 900 });
    assert.equal(rawDrag.t0, 900);
    const seconds = (ms: number) => (ms - 1000) / 1000;
    const serialized = JSON.stringify(planned.map(b => ({ ...b,
      t0: seconds(b.t0), t1: seconds(b.t1), anchor_t: seconds(b.anchor_t), window_rect: rect,
      actions: b.actions.map(a => actionVideoSeconds(a, 1000)),
      zones: [zone("card", [1000, 700, 400, 200])],
    })));
    const beats = JSON.parse(serialized) as Beat[];
    for (const b of beats) b.actions = b.actions.map(actionCameraMilliseconds);
    const g = gestures(beats.find(b => gestures(b).length)!)[0]!;
    assert.equal(g.t0, 0);
    assert.equal(g.t1, 2000);
    assert.ok(g.path!.every(p => p.t >= 0));
    assert.deepEqual(g.path!.map(p => p.t), [0, 100, 1000, 2000]);
    const decisions = beats.map(b => decision(b));
    const take = { width: 3840, height: 2160, trim_start: 0, trim_end: 2 };
    const frames = solveCamera(beats, decisions, take, DEFAULTS);
    for (const f of frames) {
      const [x, y] = gesturePointer(g, f.t);
      assert.ok(contains(f, [0, 0, 3840, 2160]));
      assert.ok(contains(f, [x - 8, y - 8, 32, 40]));
    }
    g.whole_object = [1200, 800, 400, 200];
    const established = solveCamera(beats, decisions, take, DEFAULTS);
    assert.ok(framingCoverage(beats, frames, established).every(r => r.passed));
  }
});

test("held portrait and square edges respect whole context regions", () => {
  // Generic supplied geometry, deliberately different from the proof board.
  const subject: Zone = {name: "subject", type: "res", bbox: [350, 150, 500, 1200], t_change: 2};
  const regions: Zone[] = [
    {name: "navigation", type: "win", bbox: [0, 90, 290, 1350]},
    {name: "left", type: "win", bbox: [350, 150, 500, 1200]},
    {name: "middle", type: "win", bbox: [890, 150, 500, 1200]},
    {name: "right", type: "win", bbox: [1430, 150, 500, 1200]},
  ];
  const b: Beat = {id: "whole", kind: "click", t0: 2, t1: 10, anchor_t: 2, zones: [subject, ...regions], actions: []};
  for (const [out_w, out_h] of [[1080, 1920], [1920, 1920]]) {
    const d = {...noBookends, out_w: out_w!, out_h: out_h!};
    const frames = solveCamera([b], [{...decision(b), L: 1}], {width: 2560, height: 1440, trim_end: 10}, d);
    const held = at(frames, 9);
    assert.ok(held.x <= 350 && held.x + held.w >= 850);
    for (const r of regions) for (const edge of [held.x, held.x + held.w]) {
      assert.ok(edge <= r.bbox[0] || edge >= r.bbox[0] + r.bbox[2], `held edge ${edge} slices ${r.name}`);
    }
    const control: Zone = {name:"control",type:"act",bbox:[500,600,100,80]};
    const focused = {...b,zones:[control,...regions]};
    const safe = at(solveCamera([focused],[decision(focused)],{width:2560,height:1440,trim_end:10},d),9);
    for (const r of regions) for (const edge of [safe.x,safe.x+safe.w]) {
      assert.ok(edge<=r.bbox[0] || edge>=r.bbox[0]+r.bbox[2]);
    }
    const raw = at(solveCamera([{...focused,zones:[control]}],[decision(focused)],
      {width:2560,height:1440,trim_end:10},d),9);
    assert.ok(regions.some(r=>[raw.x,raw.x+raw.w].some(e=>e>r.bbox[0]&&e<r.bbox[0]+r.bbox[2])));
  }
});
