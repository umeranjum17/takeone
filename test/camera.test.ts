import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { applyOverrides } from "../src/camera/defaults.ts";
import { frame, moveDuration, solveCamera, zMax } from "../src/camera/solver.ts";
import type { Beat, Decision, Zone } from "../src/camera/types.ts";
import { renderTake, sendcmd } from "../src/render/render.ts";

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
    A: b.zones[0].name,
    L: 3,
    p: 0,
    K: importance,
    conf: 1,
    decided_by: "test",
  };
}

function camera(beats: Beat[], decisions: Decision[], end = 8) {
  return solveCamera(beats, decisions, {
    width: 3840,
    height: 2160,
    trim_start: 0,
    trim_end: end,
  });
}

function at(frames: ReturnType<typeof camera>, seconds: number) {
  return frames[Math.round(seconds * 30)];
}

test("framing expands to 16:9 and respects source and upscale clamps", () => {
  assert.equal(zMax(3840), 2.5);
  for (let level = 0; level <= 3; level++) {
    const result = frame(zone("edge", [3600, 1900, 100, 100]), level, 3840, 2160);
    assert.ok(result.z >= 1 && result.z <= 2.5);
    assert.ok(result.cx >= 0 && result.cx <= 3840);
    assert.ok(result.cy >= 0 && result.cy <= 2160);
  }
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
  b.zones[0].bbox = [200, 500, 3200, 1100];
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
  drag.zones[0] = zone("drag", [1700, 900, 400, 200]);
  drag.actions = [{ t: 1000, x: 0, y: 1080 }, { t: 5000, x: 3840, y: 1080 }];
  const moving = camera([drag], [decision(drag)], 5);
  const stationary = camera([{ ...drag, actions: [{ t: 1000, x: 0, y: 1080 }, { t: 5000, x: 0, y: 1080 }] }], [decision(drag)], 5);
  assert.deepEqual(at(moving, 1), at(stationary, 1));
  assert.ok(at(moving, 4).x > at(stationary, 4).x + 100);
});

test("ultrawide crops fit both source dimensions", () => {
  const frames = solveCamera([], [], { width: 3440, height: 1440, trim_end: 1 });
  for (const f of frames) {
    assert.ok(f.w <= 3440 && f.h <= 1440);
    assert.ok(f.x >= 0 && f.y >= 0 && f.x + f.w <= 3440 && f.y + f.h <= 1440);
  }
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
    b.zones[0].t_change = 2;
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
    (item: Beat) => { item.zones[0].bbox = [300, 900, 0, 120]; },
    (item: Beat) => { item.zones[0].bbox = [3800, 900, 180, 120]; },
    (item: Beat) => { item.window_rect = [0, 0, 4000, 2160]; },
    (item: Beat) => { item.zones[0].t_change = NaN; },
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
  assert.throws(() => camera([{ ...b, zones: [{ ...b.zones[0], t_change: 20 }] }], [d], 4), /invalid/);
  assert.throws(() => camera([b, { ...b }], [d], 4), /invalid/);
  assert.throws(() => camera([{ ...b, zones: [b.zones[0], { ...b.zones[0] }] }], [d], 4), /invalid/);
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
  const withoutIdleTarget = { ...idle, kind: "click" as const };
  assert.deepEqual(solveCamera([idle], [decision(idle)], { ...take, trim_end: 11 }),
    solveCamera([withoutIdleTarget], [decision(idle)], { ...take, trim_end: 11 }));
});

test("frame samples have smooth log zoom and fixed aspect", () => {
  const first = beat("first", 1, 2800);
  const second = beat("second", 3, 500, "type");
  second.actions = [{ x: 700, y: 900 }];
  const result = camera([first, second], [decision(first), decision(second)], 5);
  assert.equal(result.length, 151);
  for (let index = 1; index < result.length; index++) {
    const current = result[index];
    const previous = result[index - 1];
    assert.ok(Math.abs(current.w / current.h - 16 / 9) < 1e-9);
    assert.ok(Math.abs(Math.log(current.w / previous.w)) < 0.5);
  }
});

test("--set overrides validate values", () => {
  assert.equal(applyOverrides({ fps: 24 }).fps, 24);
  assert.throws(() => applyOverrides({ unknown: 1 }));
  for (const overrides of [
    { fps: 0 }, { out_w: 0 }, { out_h: -2 }, { max_upscale: 0 },
    { rate_max: 0 }, { rate_window: 0 }, { move_t_min: -1 },
    { move_t_min: 2, move_t_max: 1 }, { hop_t_scale: 0 },
    { follow_omega: 0 }, { deadzone_margin: 0.5 }, { follow_inner: 2 },
  ]) assert.throws(() => applyOverrides(overrides), /invalid|must be at least/);
});

test("render without trim_end uses the latest beat end", { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(process.cwd(), "takeone:duration-"));
  try {
    await mkdir(join(dir, "analysis"));
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=2",
      "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8",
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
    const output = await renderTake(dir);
    const frames = JSON.parse(await readFile(join(dir, "camera.json"), "utf8"));
    assert.equal(frames.at(-1).t, 1.8);
    const count = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=nb_frames", "-of", "default=noprint_wrappers=1:nokey=1", output],
    { encoding: "utf8" });
    assert.equal(Number(count.trim()), 54);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("synthetic 4K source renders silent H.264 at 1920x1080 and 30fps", {
  timeout: 120_000,
}, async () => {
  const dir = await mkdtemp(join(process.cwd(), "takeone:render-"));
  try {
    await mkdir(join(dir, "analysis"));
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=3840x2160:r=30:d=2",
      "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8",
      "-y", join(dir, "screen.webm"),
    ]);
    await writeFile(join(dir, "take.json"), JSON.stringify({
      id: "fixture", width: 3840, height: 2160, trim_start: 0, trim_end: 2,
    }));
    const fixtureBeat = beat("fixture", 0.6, 2600);
    await writeFile(join(dir, "analysis/beats.json"), JSON.stringify([fixtureBeat]));
    await writeFile(join(dir, "analysis/decisions.jsonl"), `${JSON.stringify(decision(fixtureBeat))}\n`);

    await writeFile(join(dir, "take.json"), JSON.stringify({
      id: "../../other", width: 3840, height: 2160, trim_start: 0, trim_end: 2,
    }));
    await assert.rejects(renderTake(dir), /invalid take id/);
    await writeFile(join(dir, "take.json"), JSON.stringify({
      id: "fixture", width: 3840, height: 2160, trim_start: 0, trim_end: 2,
    }));
    const output = await renderTake(dir);
    const probe = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries",
      "stream=width,height,nb_frames,codec_name", "-of", "csv=p=0", output,
    ], { encoding: "utf8" });
    assert.match(probe, /h264/);
    assert.match(probe, /1920,1080,60/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
