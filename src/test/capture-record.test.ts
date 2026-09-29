/**
 * `takeone capture record|stop` (protocol v1, T2+T3): argument envelope,
 * JSON-line event sequence, --max-seconds hard stop, --events none
 * isolation, and `stop` -> {"stopping":true}. Recording runs against the
 * fake engine (no portal, no real screen); one x11 case runs against a
 * throwaway Xvfb display with the real engine, never the owner's display.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { installChildProcessCleanup } from "./child-process-cleanup.js";

installChildProcessCleanup();

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../cli.js");

function usageError(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, ...extraEnv },
  });
}

async function writeFakeWrapper(dir: string): Promise<string> {
  const wrapper = join(dir, "fake-engine-wrapper.sh");
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${join(here, "fake-engine.js")}" serve\n`);
  await chmod(wrapper, 0o755);
  return wrapper;
}

interface Spawned {
  child: ReturnType<typeof spawn>;
  lines: () => string[];
  stderr: () => string;
}

function spawnRecord(args: string[], extraEnv: NodeJS.ProcessEnv): Spawned {
  const child = spawn(process.execPath, [cli, ...args], {
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
  return {
    child,
    lines: () => out.split("\n").filter((l) => l.trim() !== ""),
    stderr: () => err,
  };
}

async function waitFor(lines: () => string[], pred: (l: string) => boolean, what: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const found = lines().find(pred);
    if (found !== undefined) return found;
    await new Promise((resolveP) => setTimeout(resolveP, 50));
  }
  throw new Error(`timed out waiting for ${what}; saw: ${JSON.stringify(lines())}`);
}

interface CapLine {
  event: string;
  take: string;
  seconds: number;
  warnings: string[];
}

function parseLine(line: string): CapLine {
  return JSON.parse(line) as CapLine;
}

function exitOf(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolveP) => child.on("exit", resolveP));
}

test("capture record rejects bad flags on stdout with exit 2, before recording", async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-cap-record-args-"));
  try {
    const root = join(base, "takes");
    const state = join(base, "state");
    const good = ["capture", "record", "--source", "screen", "--root", root, "--state-dir", state];
    const cases: string[][] = [
      ["capture", "record"],
      [...good, "--source", "screen", "--root", root], // missing --state-dir
      [...good, "--bogus", "1"],
      [...good, "extra-positional"],
      ["capture", "record", "--source", "bogus", "--root", root, "--state-dir", state],
      ["capture", "record", "--source", "x11:", "--root", root, "--state-dir", state],
      ["capture", "record", "--source", "screen", "--root", root, "--state-dir", state, "--events", "sometimes"],
      ["capture", "record", "--source", "screen", "--root", root, "--state-dir", state, "--max-seconds", "0"],
      ["capture", "record", "--source", "screen", "--root", root, "--state-dir", state, "--max-seconds", "-5"],
      ["capture", "record", "--source", "screen", "--root", root, "--state-dir", state, "--max-seconds", "soon"],
      ["capture", "record", "--source", "screen", "--source", "screen", "--root", root, "--state-dir", state],
      ["capture", "record", "--source", "--root", root, "--state-dir", state],
    ];
    for (const args of cases) {
      const r = usageError(args);
      assert.equal(r.status, 2, `${args.join(" ")} exited ${r.status}: ${r.stderr}`);
      const out = JSON.parse(r.stdout) as { error: { code: string; message: string; hint: string } };
      assert.equal(out.error.code, "invalid-arguments", args.join(" "));
      assert.equal(typeof out.error.message, "string");
      assert.equal(typeof out.error.hint, "string");
    }
    await assert.rejects(stat(root), "no take dir may be created by a usage error");
    await assert.rejects(stat(state), "no state dir may be created by a usage error");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("capture stop rejects bad flags (exit 2) and reports not-recording (exit 1)", async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-cap-stop-args-"));
  try {
    const state = join(base, "state");
    await mkdir(state, { recursive: true });
    for (const args of [["capture", "stop"], ["capture", "stop", "--state-dir"], ["capture", "stop", "--state-dir", state, "extra"]]) {
      const r = usageError(args);
      assert.equal(r.status, 2, args.join(" "));
      assert.equal((JSON.parse(r.stdout) as { error: { code: string } }).error.code, "invalid-arguments");
    }
    const idle = usageError(["capture", "stop", "--state-dir", state]);
    assert.equal(idle.status, 1);
    assert.equal((JSON.parse(idle.stdout) as { error: { code: string } }).error.code, "not-recording");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("capture record emits consent-pending/recording/done and stops on SIGINT", { timeout: 60_000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-cap-seq-"));
  const root = join(base, "takes");
  const state = join(base, "state");
  await mkdir(root, { recursive: true });
  await mkdir(state, { recursive: true });
  const wrapper = await writeFakeWrapper(state);
  const rec = spawnRecord(
    ["capture", "record", "--source", "screen", "--root", root, "--state-dir", state, "--events", "none"],
    { MUXR_DESKLINK_ENGINE: wrapper, HYPRLAND_INSTANCE_SIGNATURE: "unreachable", XDG_RUNTIME_DIR: base },
  );
  try {
    const first = await waitFor(rec.lines, () => true, "first line");
    assert.deepEqual(JSON.parse(first), { event: "consent-pending" });
    const recording = JSON.parse(await waitFor(rec.lines, (l) => l.includes('"recording"'), "recording")) as {
      event: string;
      take: string;
    };
    assert.equal(recording.event, "recording");
    assert.ok(recording.take.startsWith(root), recording.take);
    assert.ok(!rec.stderr().includes('"event"'), "event lines belong on stdout, not stderr");
    rec.child.kill("SIGINT");
    assert.equal(await exitOf(rec.child), 0, rec.stderr());
    const lines = rec.lines().map(parseLine);
    assert.deepEqual(lines.map((l) => l.event), ["consent-pending", "recording", "done"]);
    const done = lines[2]!;
    assert.equal(done.take, recording.take);
    assert.equal(typeof done.seconds, "number");
    assert.ok(Array.isArray(done.warnings));
    const takeJson = JSON.parse(await readFile(join(recording.take, "take.json"), "utf8")) as {
      events: string;
      pointer: string;
    };
    assert.equal(takeJson.events, "none");
    assert.equal(takeJson.pointer, "none");
    assert.equal(await readFile(join(recording.take, "events.jsonl"), "utf8"), "");
  } finally {
    rec.child.kill("SIGKILL");
    await rm(base, { recursive: true, force: true });
  }
});

test("capture record --max-seconds stops the take by itself", { timeout: 60_000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-cap-max-"));
  const root = join(base, "takes");
  const state = join(base, "state");
  await mkdir(root, { recursive: true });
  await mkdir(state, { recursive: true });
  const wrapper = await writeFakeWrapper(state);
  const rec = spawnRecord(
    ["capture", "record", "--source", "screen", "--root", root, "--state-dir", state, "--events", "none", "--max-seconds", "2"],
    { MUXR_DESKLINK_ENGINE: wrapper, HYPRLAND_INSTANCE_SIGNATURE: "unreachable", XDG_RUNTIME_DIR: base },
  );
  try {
    assert.equal(await exitOf(rec.child), 0, rec.stderr());
    const lines = rec.lines().map(parseLine);
    assert.deepEqual(lines.map((l) => l.event), ["consent-pending", "recording", "done"]);
    const done = lines[2]!;
    assert.ok(done.seconds >= 1.5 && done.seconds <= 4, `seconds=${done.seconds}`);
    await stat(join(done.take, "take.json"));
    await assert.rejects(stat(join(state, "recording.pid")), "pid file is gone after a clean stop");
  } finally {
    rec.child.kill("SIGKILL");
    await rm(base, { recursive: true, force: true });
  }
});

test("capture stop prints {\"stopping\":true} and ends the take", { timeout: 60_000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-cap-stop-"));
  const root = join(base, "takes");
  const state = join(base, "state");
  await mkdir(root, { recursive: true });
  await mkdir(state, { recursive: true });
  const wrapper = await writeFakeWrapper(state);
  const rec = spawnRecord(
    ["capture", "record", "--source", "screen", "--root", root, "--state-dir", state, "--events", "none"],
    { MUXR_DESKLINK_ENGINE: wrapper, HYPRLAND_INSTANCE_SIGNATURE: "unreachable", XDG_RUNTIME_DIR: base },
  );
  try {
    await waitFor(rec.lines, (l) => l.includes('"recording"'), "recording");
    const stop = spawnSync(process.execPath, [cli, "capture", "stop", "--state-dir", state], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, MUXR_DESKLINK_ENGINE: wrapper },
    });
    assert.equal(stop.status, 0, stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), { stopping: true });
    assert.equal(await exitOf(rec.child), 0, rec.stderr());
    assert.deepEqual(rec.lines().map((l) => parseLine(l).event), [
      "consent-pending",
      "recording",
      "done",
    ]);
  } finally {
    rec.child.kill("SIGKILL");
    await rm(base, { recursive: true, force: true });
  }
});

test("capture record --source x11:<display> reaches the engine", { timeout: 60_000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-cap-x11-"));
  const root = join(base, "takes");
  const state = join(base, "state");
  await mkdir(root, { recursive: true });
  await mkdir(state, { recursive: true });
  const wrapper = await writeFakeWrapper(state);
  const rec = spawnRecord(
    ["capture", "record", "--source", "x11::99", "--root", root, "--state-dir", state, "--events", "none", "--max-seconds", "2"],
    { MUXR_DESKLINK_ENGINE: wrapper, HYPRLAND_INSTANCE_SIGNATURE: "unreachable", XDG_RUNTIME_DIR: base },
  );
  try {
    assert.equal(await exitOf(rec.child), 0, rec.stderr());
    const done = JSON.parse(rec.lines().at(-1)!) as { event: string; take: string };
    assert.equal(done.event, "done");
    await stat(join(done.take, "take.json"));
  } finally {
    rec.child.kill("SIGKILL");
    await rm(base, { recursive: true, force: true });
  }
});

test("--events none never opens evdev or Hyprland", { timeout: 60_000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-cap-ev-"));
  const root = join(base, "takes");
  const state = join(base, "state");
  await mkdir(root, { recursive: true });
  await mkdir(state, { recursive: true });
  const wrapper = await writeFakeWrapper(state);
  const env = {
    MUXR_DESKLINK_ENGINE: wrapper,
    HYPRLAND_INSTANCE_SIGNATURE: "unreachable",
    XDG_RUNTIME_DIR: base,
  };
  const readWarnings = async (take: string): Promise<string[]> =>
    (JSON.parse(await readFile(join(take, "take.json"), "utf8")) as { warnings: string[] }).warnings;
  const none = spawnRecord(
    ["capture", "record", "--source", "screen", "--root", root, "--state-dir", state, "--events", "none", "--max-seconds", "2"],
    env,
  );
  assert.equal(await exitOf(none.child), 0, none.stderr());
  const noneTake = (JSON.parse(none.lines().at(-1)!) as { take: string }).take;
  const noneWarnings = await readWarnings(noneTake);
  assert.ok(
    noneWarnings.every((w) => !/evdev|hyprland|monitor/i.test(w)),
    `events:none must not mention taps at all: ${JSON.stringify(noneWarnings)}`,
  );
  none.child.kill("SIGKILL");

  const own = spawnRecord(
    ["capture", "record", "--source", "screen", "--root", root, "--state-dir", state, "--events", "own", "--max-seconds", "2"],
    env,
  );
  try {
    assert.equal(await exitOf(own.child), 0, own.stderr());
    const ownTake = (JSON.parse(own.lines().at(-1)!) as { take: string }).take;
    const ownWarnings = await readWarnings(ownTake);
    assert.ok(
      ownWarnings.some((w) => /evdev|hyprland|monitor/i.test(w)),
      `control run should show tap warnings here, proving the seam: ${JSON.stringify(ownWarnings)}`,
    );
  } finally {
    own.child.kill("SIGKILL");
    await rm(base, { recursive: true, force: true });
  }
});

test("x11 acceptance: real engine records a throwaway Xvfb display", { timeout: 120_000 }, async () => {
  if (spawnSync("which", ["Xvfb"], { encoding: "utf8" }).status !== 0) return; // no X server harness here
  const display = ":97";
  if (existsSync(`/tmp/.X11-unix/X${display.slice(1)}`)) return; // never steal a live display
  const base = await mkdtemp(join(tmpdir(), "takeone-cap-xvfb-"));
  const root = join(base, "takes");
  const state = join(base, "state");
  await mkdir(root, { recursive: true });
  await mkdir(state, { recursive: true });
  const server = spawn("Xvfb", [display, "-screen", "0", "800x600x24"], { stdio: "ignore" });
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !existsSync(`/tmp/.X11-unix/X${display.slice(1)}`)) {
      await new Promise((resolveP) => setTimeout(resolveP, 100));
    }
    assert.ok(existsSync(`/tmp/.X11-unix/X${display.slice(1)}`), "Xvfb did not publish its socket");
    const rec = spawnRecord(
      ["capture", "record", "--source", `x11:${display}`, "--root", root, "--state-dir", state, "--events", "none", "--max-seconds", "3"],
      { DISPLAY: display, HYPRLAND_INSTANCE_SIGNATURE: "unreachable", XDG_RUNTIME_DIR: base },
    );
    try {
      assert.equal(await exitOf(rec.child), 0, rec.stderr());
      const done = JSON.parse(rec.lines().at(-1)!) as { event: string; take: string; seconds: number };
      assert.equal(done.event, "done");
      const meta = JSON.parse(await readFile(join(done.take, "take.json"), "utf8")) as {
        stream: { w: number; h: number };
      };
      assert.ok(meta.stream.w > 0 && meta.stream.h > 0);
      assert.ok((await stat(join(done.take, "screen.webm"))).size > 0);
    } finally {
      rec.child.kill("SIGKILL");
    }
  } finally {
    server.kill("SIGTERM");
    await new Promise((resolveP) => setTimeout(resolveP, 500));
    server.kill("SIGKILL");
    await rm(base, { recursive: true, force: true });
  }
});
