import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DEFAULTS } from "../src/camera/defaults.ts";
import type { CameraFrame } from "../src/camera/types.ts";
import { motionBlurGraph, shutterPlan } from "../src/render/motion-blur.ts";
import { hasFfmpeg } from "./helpers.ts";

// The camera warp (v360) is the most expensive filter in the render: it
// resamples every shutter sample of every frame. The render profile claimed it
// ran on six times the source frames, which is the fps filter's duplication
// factor, not the work the warp does: the warp receives the sum of the shutter
// tier counts (1.28x the source frames on take A). These tests count the frames
// that really reach the warp, so the claim cannot drift back to 6x.
//
// New tests cannot declare the needsFfmpeg skip (the floor guard blocks new
// skips), so the prerequisite fails loudly here instead of with ENOENT.
if (!hasFfmpeg()) throw new Error("requires system ffmpeg and ffprobe on PATH");

const WIDTH = 320;
const HEIGHT = 180;
const FPS = 30;
const FRAMES = 60;
const d = { ...DEFAULTS, out_w: WIDTH, out_h: HEIGHT, fps: FPS, motion_blur: 1, quality: "draft" as const };

/** A camera path shaped like a real take: mostly held frames, with three
 * short moves whose frames move far enough that the shutter needs more than
 * one sample, so the tier counts differ. */
function panningPath(): CameraFrame[] {
  const window = { w: 200, h: 113 };
  const bursts: [number, number][] = [[10, 15], [30, 35], [50, 55]];
  let x = 0;
  return Array.from({ length: FRAMES }, (_, i) => {
    if (bursts.some(([start, end]) => i >= start && i < end)) x += 6;
    return { t: i / FPS, x: Math.min(WIDTH - window.w, x), y: 0, ...window };
  });
}

/** The number of frames that really reach the warp: the graph is run with a
 * frame counter in front of the v360 filter. */
function warpInputFrames(graph: string, start = 0): number {
  const counted = graph.replace(",v360=input=flat", ",showinfo,v360=input=flat");
  assert.notEqual(counted, graph, "the graph must still have a v360 warp to count");
  const result = spawnSync("ffmpeg", ["-nostats", "-v", "info", "-f", "lavfi",
    "-i", `color=c=gray:s=${WIDTH}x${HEIGHT}:r=${FPS}`,
    "-filter_complex", `[0:v]trim=end_frame=${FRAMES},setpts=N/(${FPS}*TB),format=yuv420p[c4];${counted}`,
    "-map", "[camera]", "-f", "null", "-"], { encoding: "utf8" });
  assert.equal(result.status, 0, `the camera graph must run: ${result.stderr}`);
  return (result.stderr.match(/n:\s*\d+\s+pts:/g) ?? []).length;
}

test("the camera warp receives exactly the sum of the shutter tier counts", { timeout: 120_000 }, () => {
  const frames = panningPath();
  const plan = shutterPlan(frames, WIDTH, HEIGHT, d);
  const tiers = plan.metrics.tiers;
  assert.ok(tiers.length > 1, "the path needs more than one tier");
  assert.ok(plan.counts.some(count => count > 1), "the shutter needs more than one sample");
  const expected = plan.counts.reduce((sum, count) => sum + count, 0);
  const graph = motionBlurGraph(frames, plan, WIDTH, HEIGHT, d);
  assert.equal(warpInputFrames(graph), expected, "the warp must see one frame per shutter sample");
  // The plan's own metric and the measured work agree, and the warp is not fed
  // the fps filter's duplicates: that ratio is the profile's 6x claim.
  assert.equal(plan.metrics.warpWorkRatio, expected / frames.length);
  assert.ok(expected < frames.length * plan.samples,
    `the warp saw ${expected} frames for ${frames.length} source frames`);
});

test("a render segment warps only the frames after its start", { timeout: 120_000 }, () => {
  const frames = panningPath();
  const plan = shutterPlan(frames, WIDTH, HEIGHT, d);
  const start = 20;
  const expected = plan.counts.slice(start).reduce((sum, count) => sum + count, 0);
  const graph = motionBlurGraph(frames, plan, WIDTH, HEIGHT, d, start);
  assert.equal(warpInputFrames(graph), expected, "a segment must not warp the frames before its start");
});
