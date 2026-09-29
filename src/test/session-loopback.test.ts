/**
 * Integration test: session.ts against the fake engine (a real werift VP9
 * sender speaking desklink's protocol on loopback). No portal, no real
 * network — localhost UDP only.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { installChildProcessCleanup } from "./child-process-cleanup.js";
import { startCapture } from "../session.js";
import { MediaRecorder } from "werift/nonstandard";

const here = dirname(fileURLToPath(import.meta.url));

installChildProcessCleanup();

async function tempDirs(): Promise<{ takeDir: string; stateDir: string }> {
  const base = join(tmpdir(), `takeone-loopback-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const takeDir = join(base, "take");
  const stateDir = join(base, "state");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(takeDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  return { takeDir, stateDir };
}

test("session answers a VP9 offer, records frames.tsv and screen.webm, saves the restore token", { timeout: 30_000 }, async () => {
  const { takeDir, stateDir } = await tempDirs();
  const enginePath = join(here, "fake-engine.js");
  const engine = {
    command: process.execPath,
    args: [enginePath],
    origin: "test",
  } as const;

  let geometryBeforeVideo = false;
  const capture = await startCapture({
    engine: engine as unknown as Parameters<typeof startCapture>[0]["engine"],
    takeDir,
    stateDir,
    fps: 30,
    bitrateKbps: 40_000,
    savedToken: null,
    onGeometry: async (geometry) => {
      assert.equal(geometry.source.width, 64);
      await assert.rejects(stat(join(takeDir, "frames.tsv")));
      geometryBeforeVideo = true;
    },
  });
  assert.equal(geometryBeforeVideo, true);
  assert.equal(capture.engineVersion, "desklink-host/fake");
  assert.equal(capture.geometry.source.width, 64);

  // Wait for the fake engine's 20 frames to arrive over loopback.
  const deadline = Date.now() + 10_000;
  while (capture.frames().length < 20 && Date.now() < deadline) {
    await new Promise((resolveP) => setTimeout(resolveP, 50));
  }

  const metrics = await capture.stop();

  assert.equal(capture.frames().length, 20, "all 20 marker-bit frames received");
  assert.ok(metrics !== null && metrics.encoded_frames === 20, "engine metrics reported");

  const tsv = await readFile(join(takeDir, "frames.tsv"), "utf8");
  const lines = tsv.trim().split("\n");
  assert.equal(lines.length, 20, "one frames.tsv line per frame");
  const first = lines[0]!.split("\t");
  assert.equal(first.length, 2, "rtp_ts<TAB>recv_mono_ns");
  assert.ok(/^\d+$/.test(first[1]!), "recv column is integral nanoseconds");
  const rtpTs = Number(first[0]);
  assert.equal(rtpTs, 0, "first frame at rtp timestamp 0");

  const webm = await stat(join(takeDir, "screen.webm"));
  assert.ok(webm.size > 0, "screen.webm written");

  // The fake engine's restore token was persisted atomically.
  const token = await readFile(join(stateDir, "portal-token"), "utf8");
  assert.equal(token, "fake-restore-token");
  const mode = (await stat(join(stateDir, "portal-token"))).mode & 0o777;
  assert.equal(mode, 0o600);

  await rm(dirname(takeDir), { recursive: true, force: true });
});

test("no-track watchdog starts after answer acceptance", { timeout: 30_000 }, async () => {
  const { takeDir, stateDir } = await tempDirs();
  const previous = process.env.FAKE_DELAY_ANSWER_MS;
  process.env.FAKE_DELAY_ANSWER_MS = "10500";
  try {
    const capture = await startCapture({
      engine: { command: process.execPath, args: [join(here, "fake-engine.js")], origin: "configured" },
      takeDir, stateDir, fps: 30, bitrateKbps: 40_000, savedToken: null,
    });
    assert.ok(capture.frames().length > 0);
    await capture.stop();
  } finally {
    if (previous === undefined) delete process.env.FAKE_DELAY_ANSWER_MS;
    else process.env.FAKE_DELAY_ANSWER_MS = previous;
    await rm(dirname(takeDir), { recursive: true, force: true });
  }
});

test("a failed replacement-token write fails capture completion", { timeout: 30_000 }, async () => {
  const { takeDir, stateDir } = await tempDirs();
  const invalidStateDir = join(stateDir, "not-a-directory");
  await writeFile(invalidStateDir, "");
  try {
    const capture = await startCapture({
      engine: { command: process.execPath, args: [join(here, "fake-engine.js")], origin: "configured" },
      takeDir, stateDir: invalidStateDir, fps: 30, bitrateKbps: 40_000, savedToken: null,
    });
    await assert.rejects(capture.stop(), (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "token-write-failed");
  } finally {
    await rm(dirname(takeDir), { recursive: true, force: true });
  }
});

test("stop before first packet aborts negotiation without a completed capture", { timeout: 15_000 }, async () => {
  const { takeDir, stateDir } = await tempDirs();
  const prior = process.env.FAKE_DELAY_FRAMES_MS;
  process.env.FAKE_DELAY_FRAMES_MS = "3000";
  let stop!: () => void;
  const interrupted = new Promise<void>((resolve) => { stop = resolve; });
  try {
    const capture = startCapture({
      engine: { command: process.execPath, args: [join(here, "fake-engine.js")], origin: "configured" },
      takeDir, stateDir, fps: 30, bitrateKbps: 40_000, savedToken: null, interrupted,
    });
    setTimeout(stop, 1000);
    await assert.rejects(capture, (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "capture-stopped");
  } finally {
    if (prior === undefined) delete process.env.FAKE_DELAY_FRAMES_MS;
    else process.env.FAKE_DELAY_FRAMES_MS = prior;
    await rm(dirname(takeDir), { recursive: true, force: true });
  }
});

test("unfinished WebM cannot finish a take successfully", { timeout: 30_000 }, async () => {
  const { takeDir, stateDir } = await tempDirs();
  const originalStop = MediaRecorder.prototype.stop;
  MediaRecorder.prototype.stop = async function () {
    await originalStop.call(this);
    (this.writer as { ended?: boolean }).ended = false;
  };
  try {
    const capture = await startCapture({
      engine: { command: process.execPath, args: [join(here, "fake-engine.js")], origin: "configured" },
      takeDir, stateDir, fps: 30, bitrateKbps: 40_000, savedToken: null,
    });
    await assert.rejects(capture.stop(), (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "recorder-failed");
  } finally {
    MediaRecorder.prototype.stop = originalStop;
    await rm(dirname(takeDir), { recursive: true, force: true });
  }
});

test("frames.tsv write failure cannot finish a take successfully", { timeout: 30_000 }, async () => {
  const { takeDir, stateDir } = await tempDirs();
  await mkdir(join(takeDir, "frames.tsv"));
  try {
    const capture = await startCapture({
      engine: { command: process.execPath, args: [join(here, "fake-engine.js")], origin: "configured" },
      takeDir, stateDir, fps: 30, bitrateKbps: 40_000, savedToken: null,
    });
    await assert.rejects(capture.stop(), (error: unknown) =>
      error instanceof Error && /frames-write-failed/.test(String((error as { code?: string }).code)));
  } finally {
    await rm(dirname(takeDir), { recursive: true, force: true });
  }
});
