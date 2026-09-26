/**
 * Integration test: session.ts against the fake engine (a real werift VP9
 * sender speaking desklink's protocol on loopback). No portal, no real
 * network — localhost UDP only.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { startCapture } from "../session.js";

const here = dirname(fileURLToPath(import.meta.url));

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

  const capture = await startCapture({
    engine: engine as unknown as Parameters<typeof startCapture>[0]["engine"],
    takeDir,
    stateDir,
    fps: 30,
    bitrateKbps: 40_000,
    savedToken: null,
  });
  assert.equal(capture.engineVersion, "desklink-host/fake");
  assert.equal(capture.geometry.source.width, 64);
  await capture.ready;

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

test("frames.tsv write failure cannot finish a take successfully", { timeout: 30_000 }, async () => {
  const { takeDir, stateDir } = await tempDirs();
  await mkdir(join(takeDir, "frames.tsv"));
  try {
    const capture = await startCapture({
      engine: { command: process.execPath, args: [join(here, "fake-engine.js")], origin: "test" } as Parameters<typeof startCapture>[0]["engine"],
      takeDir, stateDir, fps: 30, bitrateKbps: 40_000, savedToken: null,
    });
    await assert.rejects(capture.stop(), (error: unknown) =>
      error instanceof Error && /frames-write-failed/.test(String((error as { code?: string }).code)));
  } finally {
    await rm(dirname(takeDir), { recursive: true, force: true });
  }
});
