/**
 * Full CLI dry-run: `takeone record` against the fake engine (no portal, no
 * real capture), stopped with SIGINT like `takeone stop` sends. The fake
 * geometry (64x64) matches no real monitor, so the record runs in
 * pointer:"none" mode -- the self-check fallback exercised for real.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));

test("recorder commands reject unknown, missing and extraneous arguments before acting", async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-flags-"));
  try {
    for (const args of [
      ["record", "--bitrte", "8000"], ["record", "--bitrate"], ["record", "--fps", "30", "extra"],
      ["list", "extra"], ["stop", "extra"], ["doctor", "extra"],
    ]) {
      const result = spawnSync(process.execPath, [join(here, "../cli.js"), ...args], {
        encoding: "utf8", timeout: 3000,
        env: { ...process.env, TAKEONE_DIR: join(base, "takes"), TAKEONE_STATE_DIR: join(base, "state") },
      });
      assert.equal(result.status, 1, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, /invalid-arguments/);
    }
    await assert.rejects(stat(join(base, "takes")));
    await assert.rejects(stat(join(base, "state")));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

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
    env: { ...process.env, MUXR_DESKLINK_ENGINE: wrapper, HYPRLAND_INSTANCE_SIGNATURE: "unreachable", XDG_RUNTIME_DIR: base },
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
  const pidJson = JSON.parse(await readFile(pidFile, "utf8")) as { pid: number; take: string; start_ticks: string };
  assert.equal(pidJson.take, takeDir);
  assert.ok(/^\d+$/.test(pidJson.start_ticks));
  const rival = spawn(process.execPath, [join(here, "../cli.js"), "record", "--root", root, "--state-dir", stateDir], {
    env: { ...process.env, MUXR_DESKLINK_ENGINE: wrapper }, stdio: ["ignore", "pipe", "pipe"],
  });
  let rivalError = "";
  rival.stderr.on("data", (chunk: Buffer) => { rivalError += chunk.toString(); });
  const rivalExit = await new Promise<number | null>((resolveP) => rival.on("exit", resolveP));
  assert.equal(rivalExit, 1);
  assert.match(rivalError, /already-recording/);
  assert.equal(JSON.parse(await readFile(pidFile, "utf8")).pid, child.pid);

  // Stop the way `takeone stop` does.
  child.kill("SIGINT");
  const code = await new Promise<number | null>((resolveP) => child.on("exit", (exitCode) => resolveP(exitCode)));
  assert.equal(code, 0, `record exited ${code}; stderr: ${stderr.join("")}`);

  // The pid file is gone after a clean stop.
  await assert.rejects(stat(pidFile), undefined as unknown as never, "pid file should be removed");

  const takeJson = JSON.parse(await readFile(join(takeDir, "take.json"), "utf8")) as {
    id: string;
    pointer: string;
    events: string;
    clock: { frames: number; offsetMs: number } | null;
    trim: { start: number; end: number };
    versions: { engine: string; takeone: string };
    metrics: { encoded_frames: number } | null;
    geometry: { source: { width: number; height: number } };
  };
  assert.equal(takeJson.versions.engine, "desklink-host/fake");
  assert.equal(takeJson.geometry.source.width, 64);
  const { readTakeMeta } = await import(new URL("../../src/make.ts", import.meta.url).href);
  const plannerTake = readTakeMeta(takeDir);
  assert.deepEqual(plannerTake.stream, { w: 64, h: 64 });
  assert.equal(plannerTake.offset_ms, takeJson.clock?.offsetMs);
  assert.deepEqual(plannerTake.trim, takeJson.trim);
  assert.equal(takeJson.pointer, "none", "unreachable IPC must not abort recording");
  const firstRtp = Number((await readFile(framesPath, "utf8")).trim().split("\n")[0]!.split("\t")[0]);
  assert.ok(firstRtp / 90 + plannerTake.offset_ms >= 0);
  assert.ok(firstRtp / 90 + plannerTake.offset_ms <= takeJson.trim.end);
  assert.ok(takeJson.clock !== null && takeJson.clock.frames === 20, "clock aligned over 20 frames");
  assert.ok(takeJson.metrics !== null && takeJson.metrics.encoded_frames === 20);

  const events = await readFile(join(takeDir, "events.jsonl"), "utf8");
  if (takeJson.events === "none") assert.equal(events, "");
  const webm = await stat(join(takeDir, "screen.webm"));
  assert.ok(webm.size > 0);
  assert.equal((await stat(takeDir)).mode & 0o777, 0o700);
  for (const name of await readdir(takeDir)) {
    assert.equal((await stat(join(takeDir, name))).mode & 0o777, 0o600, name);
  }
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "json", join(takeDir, "screen.webm")], { encoding: "utf8" }));
  assert.deepEqual(probe.streams[0], { codec_name: "vp9", width: 64, height: 64 });
  const listing = spawn(process.execPath, [join(here, "../cli.js"), "list"], {
    env: { ...process.env, TAKEONE_DIR: root }, stdio: ["ignore", "pipe", "pipe"],
  });
  let listed = "";
  listing.stdout.on("data", (chunk: Buffer) => { listed += chunk.toString(); });
  assert.equal(await new Promise<number | null>((resolveP) => listing.on("exit", resolveP)), 0);
  assert.ok(listed.includes(takeJson.id));

  await writeFile(pidFile, JSON.stringify({ pid: 2147470000, take: takeDir }));
  const stale = spawn(process.execPath, [join(here, "../cli.js"), "record", "--root", root, "--state-dir", stateDir], {
    env: { ...process.env, MUXR_DESKLINK_ENGINE: wrapper }, stdio: ["ignore", "pipe", "pipe"],
  });
  let staleError = "";
  stale.stderr.on("data", (chunk: Buffer) => { staleError += chunk.toString(); });
  assert.equal(await new Promise<number | null>((resolveP) => stale.on("exit", resolveP)), 1);
  assert.match(staleError, /already-recording/);
  assert.equal(JSON.parse(await readFile(pidFile, "utf8")).pid, 2147470000);
  const stopper = spawn(process.execPath, [join(here, "../cli.js"), "stop"], {
    env: { ...process.env, TAKEONE_STATE_DIR: stateDir }, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(await new Promise<number | null>((resolveP) => stopper.on("exit", resolveP)), 1);
  await assert.rejects(stat(pidFile));

  await rm(base, { recursive: true, force: true });
});

test("cancelled consent leaves neither input events nor an incomplete take", { timeout: 20_000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-consent-record-"));
  const root = join(base, "takes");
  const stateDir = join(base, "state");
  await mkdir(root);
  await mkdir(stateDir);
  const wrapper = join(base, "engine.sh");
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${join(here, "fake-engine.js")}" serve\n`);
  await chmod(wrapper, 0o755);
  const child = spawn(process.execPath, [join(here, "../cli.js"), "record", "--root", root, "--state-dir", stateDir], {
    env: { ...process.env, MUXR_DESKLINK_ENGINE: wrapper, FAKE_HANG_OPEN: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    let takeDir = "";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const entries = await readdir(root);
      if (entries.length > 0) { takeDir = join(root, entries[0]!); break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(takeDir);
    const pidPath = join(stateDir, "recording.pid");
    while (Date.now() < deadline) {
      try { await stat(pidPath); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    await stat(pidPath);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await assert.rejects(stat(join(takeDir, "events.jsonl")));
    child.kill("SIGINT");
    assert.equal(await new Promise<number | null>((resolve) => child.on("exit", resolve)), 1);
    assert.match(stderr, /consent-cancelled/);
    await assert.rejects(stat(takeDir));
    await assert.rejects(stat(join(stateDir, "recording.pid")));
  } finally {
    child.kill("SIGKILL");
    await rm(base, { recursive: true, force: true });
  }
});

test("stop during monitor setup does not publish an unusable take", { timeout: 20_000 }, async () => {
  const base = join(tmpdir(), `takeone-setup-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const root = join(base, "takes");
  const stateDir = join(base, "state");
  const socketDir = join(base, "hypr", "test");
  await mkdir(socketDir, { recursive: true });
  await mkdir(root);
  await mkdir(stateDir);
  const wrapper = join(stateDir, "engine.sh");
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${join(here, "fake-engine.js")}" serve\n`);
  await chmod(wrapper, 0o755);
  let monitorRequest!: () => void;
  const requested = new Promise<void>((resolve) => { monitorRequest = resolve; });
  const server = createServer((conn) => {
    conn.on("error", () => undefined);
    conn.on("data", () => {
      monitorRequest();
      setTimeout(() => conn.end("[]"), 100);
    });
  });
  await new Promise<void>((resolve) => server.listen(join(socketDir, ".socket.sock"), resolve));
  const child = spawn(process.execPath, [join(here, "../cli.js"), "record", "--root", root, "--state-dir", stateDir], {
    env: { ...process.env, MUXR_DESKLINK_ENGINE: wrapper, XDG_RUNTIME_DIR: base, HYPRLAND_INSTANCE_SIGNATURE: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    await Promise.race([requested, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("monitor request not reached")), 10_000))]);
    child.kill("SIGINT");
    assert.equal(await new Promise<number | null>((resolve) => child.on("exit", resolve)), 1);
    assert.match(stderr, /capture-stopped/);
    for (const id of await readdir(root)) {
      await assert.rejects(stat(join(root, id, "take.json")));
    }
  } finally {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(base, { recursive: true, force: true });
  }
});
