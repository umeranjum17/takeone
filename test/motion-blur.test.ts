import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { applyOverrides, DEFAULTS } from "../src/camera/defaults.ts";
import { cameraFilter } from "../src/render/camera-filter.ts";
import { motionBlurGraph, shutterFrame, shutterPlan } from "../src/render/motion-blur.ts";
import { hasFfmpeg } from "./helpers.ts";

const d = { ...DEFAULTS, out_w: 160, out_h: 90, fps: 60 };
const frames = Array.from({ length: 12 }, (_, i) => ({ t: i / 60, x: i < 3 ? 0 : Math.min(6, i - 3) * 20,
  y: 0, w: 160, h: 90 }));

test("shutter is centred, clamps bookends, and samples fast pans within two pixels", () => {
  const plan = shutterPlan(frames, 320, 90, d);
  assert.equal(plan.half, 0.25);
  assert.ok(plan.metrics.maxSpacingPx <= 2);
  assert.ok(plan.samples >= 6);
  assert.ok(plan.groups.get(1)!.includes(0));
  assert.equal(shutterFrame(frames, -0.25).x, 0);
  assert.equal(shutterFrame(frames, 100).x, 120);
  for (const motion_blur of [0, 0.25, 0.5, 1]) {
    const p = shutterPlan(frames, 320, 90, { ...d, motion_blur });
    assert.ok(p.metrics.maxSpacingPx <= 2);
    assert.equal(p.half, motion_blur / 4);
  }
  const off = shutterPlan(frames, 320, 90, { ...d, motion_blur: 0 });
  assert.equal(off.samples, 1);
  assert.equal(off.metrics.blurredFrames, 0);
  for (const motion_blur of [-1, 1.01, NaN]) assert.throws(() => applyOverrides({ motion_blur }));
});

test("zoom and diagonal motion keep actual corner spacing within two pixels", () => {
  const path = frames.map((f, i) => ({ ...f, y: i * 3, w: 320 - i * 10, h: 180 - i * 5.625 }));
  assert.ok(shutterPlan(path, 320, 180, d).metrics.maxSpacingPx <= 2);
});

test("a shutter spanning a camera reversal still samples the full path", () => {
  const reversal = [0, 10, 0].map((x, i) => ({ t: i / 60, x, y: 0, w: 160, h: 90 }));
  const plan = shutterPlan(reversal, 160, 90, d);
  assert.ok([...plan.groups].some(([count, indices]) => count > 1 && indices.includes(1)));
  assert.ok(plan.metrics.maxSpacingPx <= 2);
});

test("real blur preserves every frame and never mixes adjacent source images", { skip: hasFfmpeg() ? false : "ffmpeg unavailable" }, () => {
  const plan = shutterPlan(frames, 320, 90, d);
  const graph = motionBlurGraph(frames, plan, 320, 90, d).replaceAll("[c4]", "[0:v]");
  const raw = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
    "nullsrc=s=320x90:r=60:d=0.2,geq=lum='40+160*mod(N,2)':cb=128:cr=128",
    "-filter_complex_threads", "1", "-filter_complex", graph, "-map", "[camera]", "-fps_mode", "passthrough",
    "-pix_fmt", "gray", "-f", "rawvideo", "-"], { maxBuffer: 1000000 });
  assert.equal(raw.length, 12 * 160 * 90);
  for (let i = 0; i < 12; i++) {
    const value = raw[i * 160 * 90 + 45 * 160 + 80]!;
    // Limited YUV to full-range gray: values are ~28 and ~214.
    assert.ok(i % 2 ? value > 200 : value < 40, `source frame ${i}: luma ${value}`);
  }
});

test("a fast-camera thin line becomes a continuous centred streak, with sharp holds", { skip: hasFfmpeg() ? false : "ffmpeg unavailable" }, () => {
  const graph = motionBlurGraph(frames, shutterPlan(frames, 320, 90, d), 320, 90, d).replaceAll("[c4]", "[0:v]");
  const args = ["-v", "error", "-f", "lavfi", "-i",
    "nullsrc=s=320x90:r=60:d=0.2,geq=lum='if(eq(X,150),235,16)':cb=128:cr=128",
    "-filter_complex_threads", "1", "-filter_complex", graph, "-map", "[camera]", "-fps_mode", "passthrough",
    "-pix_fmt", "gray", "-f", "rawvideo", "-"];
  const raw = execFileSync("ffmpeg", args, { maxBuffer: 1000000 });
  assert.deepEqual(execFileSync("ffmpeg", args, { maxBuffer: 1000000 }), raw, "deterministic decoded frames");
  const row = raw.subarray(6 * 160 * 90 + 45 * 160, 6 * 160 * 90 + 46 * 160);
  const lit = [...row].flatMap((v, x) => v > 10 ? [x] : []);
  assert.ok(lit.length >= 9, `streak too short: ${lit}`);
  assert.equal(lit.at(-1)! - lit[0]! + 1, lit.length, "no gaps between ghost images");
  const centroid = [...row].reduce((s, v, x) => s + x * v, 0) / [...row].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(centroid - 90) < 0.75, `shutter centroid ${centroid}`);
  const off = motionBlurGraph(frames, shutterPlan(frames, 320, 90, { ...d, motion_blur: 0 }), 320, 90, d).replaceAll("[c4]", "[0:v]");
  const sharpArgs = args.map((arg) => arg === graph ? off : arg);
  const sharp = execFileSync("ffmpeg", sharpArgs, { maxBuffer: 1000000 });
  assert.deepEqual(raw.subarray(0, 160 * 90), sharp.subarray(0, 160 * 90), "hold matches original single warp");
});


test("fractional camera positions move decoded edges on both axes", { skip: !hasFfmpeg() }, () => {
  const decode = (x: number, y: number) => execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
    "nullsrc=s=320x180,geq=lum='if(gte(X,100)*gte(Y,50),235,16)':cb=128:cr=128",
    "-filter_threads", "1", "-vf", cameraFilter([{ t: 0, x, y, w: 160, h: 90 }], 320, 180, d),
    "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-"], { maxBuffer: 100000 });
  const base = decode(0, 0);
  const horizontal = decode(0.25, 0);
  const vertical = decode(0, 0.25);
  const at = (pixels: Buffer, x: number, y: number) => pixels[y * 160 + x]!;
  assert.ok(at(horizontal, 99, 70) > at(base, 99, 70) + 10);
  assert.ok(at(vertical, 120, 49) > at(base, 120, 49) + 10);
});
