/**
 * Full CLI dry-run: `takeone record` against the fake engine (no portal, no
 * real capture), stopped with SIGINT like `takeone stop` sends. The fake
 * geometry (64x64) matches no real monitor, so the record runs in
 * pointer:"unmapped" mode -- the self-check fallback exercised for real.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));

test("record writes a complete take (pid file, events, take.json) and stops on SIGINT", { timeout: 60_000 }, async () => {
  const base = join(tmpdir(), `takeone-record-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const root = join(base, "takes");
  const stateDir = join(base, "state");
  await mkdir(root, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  // An executable wrapper the engine resolver accepts, running the fake engine.
  const wrapper = join(stateDir, "fake-engine-wrapper.sh");
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${join(here, "fake-engine.js")}" serve\n`);
  await chmod(wrapper, 0o755);

  const child = spawn(process.execPath, [join(here, "../cli.js"), "record", "--root", root, "--state-dir", stateDir], {
    env: { ...process.env, MUXR_DESKLINK_ENGINE: wrapper },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

  // Wait for the 20 frames the fake engine sends.
  const takeDir = await (async (): Promise<string> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const entries = (await readdir(root)).filter((n) => /^\d{8}-\d{6}$/.test(n));
        if (entries.length > 0) return join(root, entries[0]!);
      } catch {
        // root not populated yet
      }
      await new Promise((resolveP) => setTimeout(resolveP, 50));
    }
    throw new Error("record never created a take dir");
  })();

  const framesPath = join(takeDir, "frames.tsv");
  const deadline = Date.now() + 20_000;
  let lines = 0;
  while (Date.now() < deadline) {
    try {
      const content = await readFile(framesPath, "utf8");
      lines = content.trim() === "" ? 0 : content.trim().split("\n").length;
      if (lines >= 20) break;
    } catch {
      // frames.tsv not written yet
    }
    await new Promise((resolveP) => setTimeout(resolveP, 50));
  }
  assert.ok(lines >= 20, `expected 20 frames, saw ${lines}`);

  // The pid file is live while recording, naming this take.
  const pidFile = join(stateDir, "recording.pid");
  const pidJson = JSON.parse(await readFile(pidFile, "utf8")) as { pid: number; take: string };
  assert.equal(pidJson.take, takeDir);

  // Stop the way `takeone stop` does.
  child.kill("SIGINT");
  const code = await new Promise<number | null>((resolveP) => child.on("exit", (exitCode) => resolveP(exitCode)));
  assert.equal(code, 0, `record exited ${code}; stderr: ${stderr.join("")}`);

  // The pid file is gone after a clean stop.
  await assert.rejects(stat(pidFile), undefined as unknown as never, "pid file should be removed");

  const takeJson = JSON.parse(await readFile(join(takeDir, "take.json"), "utf8")) as {
    pointer: string;
    events: string;
    clock: { frames: number; offset_ms: number } | null;
    trim: { start_ms: number; end_ms: number };
    versions: { engine: string; takeone: string };
    metrics: { encoded_frames: number } | null;
    geometry: { source: { width: number; height: number } };
  };
  assert.equal(takeJson.versions.engine, "desklink-host/fake");
  assert.equal(takeJson.geometry.source.width, 64);
  assert.equal(takeJson.pointer, "unmapped", "64x64 stream matches no monitor: no-pointer mode");
  assert.equal(takeJson.events, "on");
  assert.ok(takeJson.clock !== null && takeJson.clock.frames === 20, "clock aligned over 20 frames");
  assert.ok(takeJson.metrics !== null && takeJson.metrics.encoded_frames === 20);

  // events.jsonl exists (empty is fine on a headless runner with no input).
  await stat(join(takeDir, "events.jsonl"));
  const webm = await stat(join(takeDir, "screen.webm"));
  assert.ok(webm.size > 0);

  await rm(base, { recursive: true, force: true });
});
