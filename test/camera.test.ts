import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { applyOverrides, DEFAULTS } from "../src/camera/defaults.ts";
import { frame, moveDuration, solveCamera, zMax } from "../src/camera/solver.ts";
import type { Beat, Decision, Zone } from "../src/camera/types.ts";
import { renderTake, sendcmd } from "../src/render/render.ts";
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

const noBookends = { ...DEFAULTS, establish_s: 0, outro_s: 0 };

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
  return frames[Math.round(seconds * 30)]!;
}

test("framing expands to 16:9 and respects source and upscale clamps", () => {
  assert.equal(zMax(3840, 2160), 3);
  for (let level = 0; level <= 3; level++) {
    const result = frame(zone("edge", [3600, 1900, 100, 100]), level, 3840, 2160);
    assert.ok(result.z >= 1 && result.z <= 3);
    assert.ok(result.cx >= 0 && result.cx <= 3840);
    assert.ok(result.cy >= 0 && result.cy <= 2160);
  }
});

test("FIT holds a whole opened panel at a real zoom instead of padding out to the whole screen", () => {
  const panel = zone("panel", [84, 224, 972, 692]);
  for (let level = 2; level <= 3; level++) {
    const s = frame(panel, level, 1920, 1080);
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
  assert.deepEqual(wide, { t: 0, x: 0, y: 0, w: 3840, h: 2160 });
  const zoomBeat = beat("wide-zoom", 2, 2500);
  const zoomed = solveCamera([zoomBeat], [decision(zoomBeat)], {
    width: 3840, height: 2160, trim_start: 0, trim_end: 4,
  }, noBookends);
  assert.deepEqual(zoomed[60]!, {
    t: 2, x: 1917.6833193611185, y: 593.4389427400281,
    w: 1313.3037888436606, h: 738.7333812245591,
  });
});

test("phone footage into 16:9 zooms against the padded canvas and keeps the card centred", () => {
  // 1080x2400 sits on a 4267-wide 16:9 canvas; zoom is measured against it.
  assert.ok(zMax(1080, 2400) > 1);
  assert.ok(Math.abs(zMax(1080, 2400) - 2400 * 16 / 9 / 1280) < 1e-9);
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
  });
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

test("move duration clamps and sendcmd emits one crop update per frame", () => {
  assert.equal(moveDuration(0), 0.6);
  assert.ok(moveDuration(100) <= 1.4);
  assert.match(
    sendcmd([{ t: 0, x: 0, y: 0, w: 3840, h: 2160 }]),
    /^0\.000000 \[enter\] crop@a w 3840, crop@a h 2160, crop@a x 0, crop@a y 0;\n$/,
  );
});

test("deadzone skips framing that already fits with the configured margin", () => {
  const b = beat("wide", 2, 300);
  b.zones[0]!.bbox = [200, 500, 3200, 1100];
  const result = camera([b], [decision(b)], 4);
  assert.equal(at(result, 3).w, 3840);
});

test("minimum dwell delays the next shot and merges its zone with the previous one", () => {
  const first = beat("first", 2, 500);
  const next = beat("next", 2.2, 3000);
  const result = camera([first, next], [decision(first, 2), decision(next, 2)], 5);
  // The merged framing spans both distant subjects rather than jumping to the second alone.
  assert.ok(at(result, 3.7).x < 1000);
  assert.ok(at(result, 3.7).x + at(result, 3.7).w > 2800);
});

test("minimum shot length drops an arrival that is too close to the previous one", () => {
  const first = beat("first", 2, 500);
  const tooSoon = beat("soon", 2.5, 3000);
  const withShortShot = camera([first, tooSoon], [decision(first), decision(tooSoon)], 5);
  const withoutShortShot = camera([first], [decision(first)], 5);
  assert.deepEqual(at(withShortShot, 4), at(withoutShortShot, 4));
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
  assert.equal(at(result, 1.1).w, 3840);
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
  assert.equal(at(result, 2.5).w, 3840);
  assert.ok(at(result, 3.5).w < 3840);
});

test("scroll is never chased", () => {
  const scroll = beat("scroll", 2, 3000, "scroll");
  assert.equal(at(camera([scroll], [decision(scroll, 2)], 4), 3).w, 3840);
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
  assert.deepEqual(result[10], { t: 10 / 30, x: 0, y: 0, w: 3840, h: 2160 });
  assert.ok(result[Math.round(DEFAULTS.establish_s * 30) + 3]!.w < 3000);
  assert.ok(result.at(-1)!.w > 3839);
  const kept = solveCamera([early], [decision(early)],
    { width: 3840, height: 2160, trim_start: 0, trim_end: 8 }, noBookends);
  assert.ok(kept[10]!.w < 3840 && kept.at(-1)!.w < 3000);
});

test("frame samples have smooth log zoom and fixed aspect", () => {
  const first = beat("first", 1, 2800);
  const second = beat("second", 3, 500, "type");
  second.actions = [{ x: 700, y: 900 }];
  const result = camera([first, second], [decision(first), decision(second)], 5);
  assert.equal(result.length, 151);
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
    assert.equal(Number(count.trim()), 54);
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

test("synthetic source renders silent H.264 at the configured size and 30fps", {
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
    const probe = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries",
      "stream=width,height,nb_frames,codec_name", "-of", "csv=p=0", output,
    ], { encoding: "utf8" });
    assert.match(probe, /h264/);
    assert.match(probe, /320,180,60/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("L1 frames a real window, but pads the zone inside a fullscreen window", () => {
  const button = zone("button", [3300, 30, 300, 80]);
  const windowed = frame(button, 1, 3840, 2160, [1920, 0, 1920, 1080]);
  assert.equal(windowed.z, 2);
  const fullscreen = frame(button, 1, 3840, 2160, [0, 0, 3840, 2160]);
  assert.ok(fullscreen.z > 2, `z=${fullscreen.z}`);
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
  assert.ok(holdEnd < 0 || (holdEnd - holdStart) / 30 >= DEFAULTS.dwell, `hold ${(holdEnd - holdStart) / 30}s`);
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
