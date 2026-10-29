import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULTS, applyOverrides } from "../src/camera/defaults.ts";
import type { CameraFrame, TakeMeta } from "../src/camera/types.ts";
import { bubbleBox, bubbleGraph, bubbleScales, breakpoints, scaleExpr, webcamClip } from "../src/render/webcam.ts";
import { pickWebcam, startWebcam } from "../src/webcam.ts";
import { hasFfmpeg } from "./helpers.ts";

const frames = (zooms: number[]): CameraFrame[] => zooms.map((z, i) => ({ t: i / 30, x: 0, y: 0, w: 1920 / z, h: 1080 / z }));

test("the bubble is full size at rest and shrinks to webcam_shrink at deep zoom", () => {
  const [rest, mid, deep, beyond] = bubbleScales(frames([1, 1.75, 2.5, 6]), 1920, DEFAULTS);
  assert.equal(rest!.s, 1);
  assert.ok(mid!.s < 1 && mid!.s > DEFAULTS.webcam_shrink);
  assert.ok(Math.abs(deep!.s - DEFAULTS.webcam_shrink) < 1e-9);
  assert.equal(beyond!.s, deep!.s);
  assert.ok(bubbleScales(frames([1, 3]), 1920, { ...DEFAULTS, webcam_shrink: 1 }).every(p => p.s === 1));
});

test("breakpoints keep a long hold and a push-in down to a few pieces", () => {
  const zooms = [...Array(90).fill(1), ...Array.from({ length: 30 }, (_, i) => 1 + i / 10), ...Array(120).fill(4)];
  const points = bubbleScales(frames(zooms), 1920, DEFAULTS);
  const kept = breakpoints(points, 0.002);
  assert.ok(kept.length < 20, `${kept.length} breakpoints`);
  assert.equal(kept[0]!.t, points[0]!.t);
  assert.equal(kept.at(-1)!.t, points.at(-1)!.t);
  assert.equal(scaleExpr([{ t: 0, s: 1 }, { t: 2, s: 1 }]), "if(lt(t,2.00000),1.00000+0.00000*(t-0.00000),1.00000)");
});

test("webcam settings validate", () => {
  assert.equal(applyOverrides({ webcam_corner: "tl", webcam_shape: "rounded", webcam_size: 0.3, webcam_shrink: 1, webcam: "face.mp4" }).webcam_corner, "tl");
  for (const bad of [{ webcam_corner: "centre" }, { webcam_shape: "star" }, { webcam_size: 0.6 }, { webcam_size: 0.01 }, { webcam_shrink: 0.1 }, { webcam_shrink: 1.5 }, { webcam: "bad\nname" }]) {
    assert.throws(() => applyOverrides(bad), /invalid --set/);
  }
});

test("webcamClip prefers an explicit file, honours off, and offsets by the screen's first frame", () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-webcam-clip-"));
  try {
    writeFileSync(join(dir, "webcam.mkv"), "");
    writeFileSync(join(dir, "other.mp4"), "");
    const meta = { webcam: { file: "webcam.mkv", start_ms: 1500 } } as TakeMeta;
    assert.deepEqual(webcamClip(dir, meta, DEFAULTS, 1000), { file: join(dir, "webcam.mkv"), offset: 0.5 });
    assert.deepEqual(webcamClip(dir, meta, { ...DEFAULTS, webcam: "other.mp4" }, 1000), { file: join(dir, "other.mp4"), offset: 0 });
    assert.equal(webcamClip(dir, meta, { ...DEFAULTS, webcam: "off" }, 1000), null);
    assert.equal(webcamClip(dir, {} as TakeMeta, DEFAULTS, 0), null);
    assert.throws(() => webcamClip(dir, meta, { ...DEFAULTS, webcam: "missing.mp4" }, 0), /does not exist/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pickWebcam names the camera or fails before any screen prompt", () => {
  assert.equal(pickWebcam(undefined, ["/dev/video0", "/dev/video1"]), "/dev/video0");
  assert.throws(() => pickWebcam(undefined, []), { code: "webcam-missing" });
  assert.throws(() => pickWebcam("/dev/video-nope"), { code: "webcam-missing" });
});

const ffmpegOk = hasFfmpeg();
const skip = ffmpegOk ? undefined : "ffmpeg is not installed";

test("startWebcam records a clip, stamps its first frame and finishes the file", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-webcam-capture-"));
  try {
    const t0 = performance.now();
    const cam = await startWebcam({ takeDir: dir, device: "lavfi", clockMs: () => performance.now() - t0,
      input: [["-re", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30"]] });
    await new Promise((r) => setTimeout(r, 1200));
    const clip = await cam.stop();
    assert.equal(clip.file, "webcam.mkv");
    assert.ok(clip.start_ms >= 0 && clip.start_ms < 5000);
    const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name:format=duration", "-of", "default=nw=1", join(dir, "webcam.mkv")], { encoding: "utf8" });
    assert.match(probe.stdout, /codec_name=h264/);
    assert.ok(Number(/duration=([\d.]+)/.exec(probe.stdout)![1]) > 0.8);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("startWebcam reports a camera that gives no frames", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-webcam-capture-"));
  try {
    await assert.rejects(startWebcam({ takeDir: dir, device: "/dev/video-nope", clockMs: () => 0, input: [["-f", "v4l2", "-i", "/dev/video-nope"]] }), { code: "webcam-failed" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bubbleGraph draws a ringed circle in its corner and leaves the rest of the frame alone", { skip }, () => {
  const d = { ...DEFAULTS, out_w: 640, out_h: 360 };
  const { w, margin } = bubbleBox(d);
  const graph = bubbleGraph({ input: "1:v", offset: 0, trimStart: 0, trimEnd: 10, clock: "setpts=PTS-STARTPTS", from: "",
    frames: frames([1, 1, 1]), restW: 1920, fps: 30 }, d);
  const run = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0x203040:s=640x360:r=30:d=1", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=30:d=1",
    "-filter_complex", `[0:v]format=yuv420p[footage];${graph.lines.join(";")};[footage][bubble]${graph.overlay}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { maxBuffer: 640 * 360 * 4 });
  assert.equal(run.status, 0, String(run.stderr));
  const px = (x: number, y: number) => [...run.stdout.subarray((y * 640 + x) * 3, (y * 640 + x) * 3 + 3)];
  const left = 640 - margin - w, top = 360 - margin - w;
  const centre = px(left + w / 2, top + w / 2);
  assert.ok(centre[0]! > 200 && centre[1]! < 60, `centre ${centre}`);
  const corner = px(left + 1, top + 1);
  assert.ok(Math.abs(corner[0]! - 0x20) < 6 && Math.abs(corner[2]! - 0x40) < 6, `box corner ${corner}`);
  assert.ok(px(10, 10)[0]! < 60);
  const rim = px(left + w / 2, top + 1);
  assert.ok(rim[1]! > 150 && rim[2]! > 150, `ring ${rim}`);
});

test("bubbleGraph draws the rounded shape in the top-left corner", { skip }, () => {
  const d = { ...DEFAULTS, out_w: 640, out_h: 360, webcam_shape: "rounded" as const, webcam_corner: "tl" as const };
  const { w, h, margin } = bubbleBox(d);
  assert.ok(w > h);
  const graph = bubbleGraph({ input: "1:v", offset: 0, trimStart: 0, trimEnd: 10, clock: "setpts=PTS-STARTPTS", from: "",
    frames: frames([1, 1, 1]), restW: 1920, fps: 30 }, d);
  const run = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0x203040:s=640x360:r=30:d=1", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=30:d=1",
    "-filter_complex", `[0:v]format=yuv420p[footage];${graph.lines.join(";")};[footage][bubble]${graph.overlay}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { maxBuffer: 640 * 360 * 4 });
  assert.equal(run.status, 0, String(run.stderr));
  const px = (x: number, y: number) => [...run.stdout.subarray((y * 640 + x) * 3, (y * 640 + x) * 3 + 3)];
  assert.ok(px(margin + w / 2, margin + h / 2)[0]! > 200);
  const corner = px(margin + 1, margin + 1);
  assert.ok(Math.abs(corner[0]! - 0x20) < 6, `rounded corner ${corner}`);
  const edge = px(margin + w - 1, margin + h / 2);
  assert.ok(edge[1]! > 150, `right edge ring ${edge}`);
});
