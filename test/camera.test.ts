import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

test("four-moves-per-ten-seconds limit discards lowest-importance excess", () => {
  const beats = [1, 2, 3, 4, 5].map((time, index) => beat(`b${index}`, time, 300 + index * 700));
  const decisions = beats.map((b, index) => decision(b, index === 0 ? 0 : 2));
  const result = camera(beats, decisions, 7);
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
  const result = camera([activity, idle], [decision(activity)], 8);
  assert.ok(at(result, 2).w < 3000);
  assert.ok(at(result, 5).w > 3700);
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
});

test("synthetic 4K source renders silent H.264 at 1920x1080 and 30fps", {
  timeout: 120_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "takeone-render-"));
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
