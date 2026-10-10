/**
 * `takeone capture record|stop` (protocol v1, T2+T3): argument envelope,
 * JSON-line event sequence, --max-seconds hard stop, --events none
 * isolation, and `stop` -> {"stopping":true}. Recording runs against the
 * fake engine (no portal, no real screen); one x11 case runs against a
 * throwaway Xvfb display with the real engine, never the owner's display,
 * and skips where that engine reports no x11 backend (e.g. CI runners
 * with Xvfb but without the engine's native libraries).
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";
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
  // Own-events control runs must not read the machine's real input devices.
  // Log the discovery read so none/own prove both sides of the boundary.
  await writeFile(`${wrapper}.mjs`, `
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const readFile = fs.readFile.bind(fs);
fs.readFile = async (path, ...args) => {
  if (String(path) === "/proc/bus/input/devices") {
    await fs.appendFile(${JSON.stringify(join(dir, "input-reads.log"))}, "evdev\\n");
    return "";
  }
  return readFile(path, ...args);
};
syncBuiltinESMExports();
`);
  return wrapper;
}

interface Spawned {
  child: ReturnType<typeof spawn>;
  lines: () => string[];
  stderr: () => string;
}

function spawnRecord(args: string[], extraEnv: NodeJS.ProcessEnv): Spawned {
  const preload = extraEnv.MUXR_DESKLINK_ENGINE === undefined ? [] : ["--import", `${extraEnv.MUXR_DESKLINK_ENGINE}.mjs`];
  const child = spawn(process.execPath, [...preload, cli, ...args], {
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
  return new Promise((resolveP) => child.once("close", resolveP));
}

async function expectSuccess(rec: Spawned): Promise<void> {
  assert.equal(await exitOf(rec.child), 0, [...rec.lines(), rec.stderr()].join("\n"));
}

async function stopWhenRecording(rec: Spawned): Promise<void> {
  await waitFor(rec.lines, (l) => l.includes('"recording"'), "recording");
  rec.child.kill("SIGINT");
  await expectSuccess(rec);
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
    await expectSuccess(rec);
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
    // The limit includes setup. Leave negotiation headroom on loaded runners
    // and deliberately delay video beyond the old two-second assumption.
    ["capture", "record", "--source", "screen", "--root", root, "--state-dir", state, "--events", "none", "--max-seconds", "10"],
    { MUXR_DESKLINK_ENGINE: wrapper, HYPRLAND_INSTANCE_SIGNATURE: "unreachable", XDG_RUNTIME_DIR: base, FAKE_DELAY_FRAMES_MS: "2500" },
  );
  try {
    await expectSuccess(rec);
    const lines = rec.lines().map(parseLine);
    assert.deepEqual(lines.map((l) => l.event), ["consent-pending", "recording", "done"]);
    const done = lines[2]!;
    assert.ok(done.seconds >= 9.5 && done.seconds <= 12, `seconds=${done.seconds}`);
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
    await expectSuccess(rec);
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
    ["capture", "record", "--source", "x11::99", "--root", root, "--state-dir", state, "--events", "none"],
    { MUXR_DESKLINK_ENGINE: wrapper, HYPRLAND_INSTANCE_SIGNATURE: "unreachable", XDG_RUNTIME_DIR: base },
  );
  try {
    await stopWhenRecording(rec);
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
    ["capture", "record", "--source", "screen", "--root", root, "--state-dir", state, "--events", "none"],
    env,
  );
  let own: Spawned | undefined;
  try {
    await stopWhenRecording(none);
    const noneTake = (JSON.parse(none.lines().at(-1)!) as { take: string }).take;
    const noneWarnings = await readWarnings(noneTake);
    assert.ok(
      noneWarnings.every((w) => !/evdev|hyprland|monitor/i.test(w)),
      `events:none must not mention taps at all: ${JSON.stringify(noneWarnings)}`,
    );
    await assert.rejects(stat(join(state, "input-reads.log")), "none never discovers evdev devices");

    own = spawnRecord(
      ["capture", "record", "--source", "screen", "--root", root, "--state-dir", state, "--events", "own"],
      env,
    );
    await stopWhenRecording(own);
    const ownTake = (JSON.parse(own.lines().at(-1)!) as { take: string }).take;
    const ownWarnings = await readWarnings(ownTake);
    assert.ok(
      ownWarnings.some((w) => /evdev|hyprland|monitor/i.test(w)),
      `control run should show tap warnings here, proving the seam: ${JSON.stringify(ownWarnings)}`,
    );
    assert.equal(await readFile(join(state, "input-reads.log"), "utf8"), "evdev\n");
  } finally {
    none.child.kill("SIGKILL");
    own?.child.kill("SIGKILL");
    await rm(base, { recursive: true, force: true });
  }
});

test("x11 acceptance: real engine records a throwaway Xvfb display", { timeout: 120_000 }, async (t) => {
  if (spawnSync("which", ["Xvfb"], { encoding: "utf8" }).status !== 0) {
    t.skip("Xvfb is not installed");
    return;
  }
  const base = await mkdtemp(join(tmpdir(), "takeone-cap-xvfb-"));
  const root = join(base, "takes");
  const state = join(base, "state");
  await mkdir(root, { recursive: true });
  await mkdir(state, { recursive: true });
  // Let Xvfb reserve a free display, including its abstract socket. A fixed
  // display can collide even when another fixture has a separate /tmp.
  // This fixture needs only an ordinary framebuffer. Disable GLX so an
  // installed GPU driver cannot try to initialize the owner's hardware.
  const server = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "800x600x24", "-nolisten", "tcp", "-extension", "GLX"], {
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  let serverError = "";
  server.stderr!.on("data", (chunk: Buffer) => { serverError += chunk.toString(); });
  try {
    const display = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Xvfb did not report a display: ${serverError}`)), 20_000);
      let output = "";
      (server.stdio[3] as Readable).on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (!output.includes("\n")) return;
        clearTimeout(timer);
        const number = output.trim();
        if (!/^\d+$/.test(number)) reject(new Error(`invalid Xvfb display: ${output}`));
        else resolve(`:${number}`);
      });
      server.once("error", (error) => { clearTimeout(timer); reject(error); });
      server.once("exit", () => { clearTimeout(timer); reject(new Error(`Xvfb exited: ${serverError}`)); });
    });
    // The real engine needs its native capture backends, which a machine
    // with Xvfb does not necessarily have; skip where x11 is unavailable
    // instead of failing on the environment's absence.
    const { EngineClient, EngineRefused, resolveEngine } = await import("@desklink/host");
    const engine = resolveEngine();
    if (engine === null) {
      t.skip("the desklink engine binary is not installed");
      return;
    }
    let x11 = false;
    let diagnostics = "";
    const probe = await EngineClient.start(engine.command, engine.args, {
      onDiagnostic: (line) => { diagnostics += `${line}\n`; },
    }, {
      ...process.env,
      DISPLAY: display,
      XDG_RUNTIME_DIR: base,
    }).catch((error: unknown) => {
      if ((error instanceof EngineRefused && error.code === "missing-system-library") ||
          /error while loading shared libraries:/.test(diagnostics)) {
        t.skip("the desklink engine is missing native shared libraries");
        return null;
      }
      throw error;
    });
    if (probe === null) return;
    try {
      x11 = (await probe.capabilities()).x11.available;
    } finally {
      await probe.stop().catch(() => undefined);
    }
    if (!x11) {
      t.skip("the engine reports its native x11 backend is unavailable");
      return;
    }
    const rec = spawnRecord(
      ["capture", "record", "--source", `x11:${display}`, "--root", root, "--state-dir", state, "--events", "none"],
      { DISPLAY: display, HYPRLAND_INSTANCE_SIGNATURE: "unreachable", XDG_RUNTIME_DIR: base },
    );
    try {
      await stopWhenRecording(rec);
      const done = JSON.parse(rec.lines().at(-1)!) as { event: string; take: string; seconds: number };
      assert.equal(done.event, "done");
      const meta = JSON.parse(await readFile(join(done.take, "take.json"), "utf8")) as {
        stream: { w: number; h: number };
        cursor_free?: boolean;
      };
      assert.ok(meta.stream.w > 0 && meta.stream.h > 0);
      // An X11 source's root pixels never carry the server cursor, so the take
      // is cursor-free and the renderer draws its own vector cursor.
      assert.equal(meta.cursor_free, true);
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
