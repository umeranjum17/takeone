#!/usr/bin/env node
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { makeTake, PreflightRefusal, TakeInputError } from "./make.ts";
import { renderTake } from "./render/render.ts";
import { applyOverrides, type CameraDefaults, type Overrides } from "./camera/defaults.ts";

async function recorderCommand(command: string, args: string[]): Promise<number> {
  return runRecorderCommand(command, args);
}

export function takesDir(): string {
  return process.env["TAKEONE_DIR"] ?? join(homedir(), "Videos", "takeone");
}

interface Args {
  id?: string;
  noJev: boolean;
  about?: string;
  screenText: boolean;
  maxTokens?: number;
  set: string[];
  camera?: CameraDefaults;
}

/** Parse `--set key=value` pairs; numeric values stay numbers so that
 * string-valued keys like preset and background pass through intact. */
function parseSet(pairs: string[]): Overrides {
  const overrides: Record<string, number | string> = {};
  for (const pair of pairs) {
    const match = /^([^=]+)=([^=]+)$/.exec(pair ?? "");
    if (!match) throw Error(`invalid --set ${pair}`);
    const [, k, v] = match;
    const n = Number(v);
    overrides[k!] = k === "background" || !Number.isFinite(n) ? v! : n;
  }
  return overrides as Overrides;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { noJev: false, screenText: false, set: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i]!;
    if (s === "--no-jev") a.noJev = true;
    else if (s === "--about") a.about = argv[++i];
    else if (s === "--screen-text") a.screenText = true;
    else if (s === "--max-tokens") a.maxTokens = Number(argv[++i]);
    else if (s === "--set") {
      const v = argv[++i];
      if (v === undefined) {
        console.error("takeone: --set needs key=value");
        usage(2);
      }
      a.set.push(v);
    }
    else if (!s.startsWith("--") && a.id === undefined) a.id = s;
    else if (s === "--help" || s === "-h") usage(0);
    else {
      console.error(`unknown option: ${s}`);
      usage(2);
    }
  }
  return a;
}

function usage(code: number): never {
  console.error(`takeone make <id> [--no-jev] [--about "<topic>"] [--screen-text] [--max-tokens N] [--set key=value]
takeone render <take-dir> [--set key=value]
takeone [list|record|stop|doctor]

  make plans beats and camera decisions, then renders an MP4.
  render creates a camera path and MP4 from a planned take.

  --no-jev        decide every beat with the local heuristic; zero network calls
  --about         optional demo topic; adds the key_moment question
  --screen-text   opt-in: send up to 12 redacted OCR words per zone plus the window title
  --max-tokens    refuse above this many planned input tokens (default 40k x take minutes)`);
  process.exit(code);
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "list" || cmd === "record" || cmd === "stop" || cmd === "doctor") {
    return recorderCommand(cmd ?? "list", rest);
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") usage(0);
  if (cmd === "render") {
    const [dir, ...args] = rest;
    if (!dir) { console.error("usage: takeone render <take-dir>"); return 2; }
    try {
      const pairs: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== "--set") throw Error(`unknown option ${args[i]}`);
        pairs.push(args[++i]!);
      }
      console.log(await renderTake(dir, applyOverrides(parseSet(pairs))));
      return 0;
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      return 1;
    }
  }
  if (cmd !== "make") {
    console.error(`takeone: unknown command "${cmd}". Use "make", "render", "record", "stop", "doctor" or "list".`);
    return 2;
  }
  const a = parseArgs(rest);
  if (a.maxTokens !== undefined && (!Number.isSafeInteger(a.maxTokens) || a.maxTokens <= 0)) {
    console.error("takeone make: --max-tokens must be a positive integer");
    return 2;
  }
  if (!a.id) {
    console.error("takeone make: missing take id");
    usage(2);
  }
  if (a.set.length) {
    try {
      a.camera = applyOverrides(parseSet(a.set));
    } catch (e) {
      console.error(`takeone make: ${e instanceof Error ? e.message : e}`);
      return 2;
    }
  }
  const dir = /^\//.test(a.id) ? a.id : join(takesDir(), a.id);
  if (!existsSync(join(dir, "take.json"))) {
    console.error(`takeone make: no take at ${dir} (take.json missing)`);
    return 2;
  }
  try {
    await makeTake(dir, a);
    return 0;
  } catch (e) {
    if (e instanceof PreflightRefusal || e instanceof TakeInputError) {
      console.error(`takeone make: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

if (process.argv[1] && (import.meta.url === pathToFileURL(process.argv[1]).href || process.argv[1].endsWith("/bin/takeone.mjs"))) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; },
  );
}


interface Flags {
  fps?: number;
  bitrateKbps?: number;
  root?: string;
  state?: string;
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  const take = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index === -1) return undefined;
    const value = args[index + 1];
    return typeof value === "string" ? value : undefined;
  };
  const fps = take("--fps");
  if (fps !== undefined) flags.fps = Number(fps);
  const bitrate = take("--bitrate");
  if (bitrate !== undefined) flags.bitrateKbps = Number(bitrate);
  const root = take("--root");
  if (root !== undefined) flags.root = root;
  const state = take("--state-dir");
  if (state !== undefined) flags.state = state;
  return flags;
}

function fail(error: { code: string; message: string; hint: string }): never {
  console.error(JSON.stringify({ error }));
  process.exit(1);
}

function internal(error: unknown): never {
  fail({
    code: "internal",
    message: error instanceof Error ? error.message : String(error),
    hint: "this is a takeone bug; report the command and this message",
  });
}

async function list(): Promise<void> {
  const [{ defaultStateDir, defaultTakesRoot }, { listTakes }, { toonTable }] = await Promise.all([
    import("./record.js"), import("./takes.js"), import("./toon.js"),
  ]);
  const recording = await readRecording(defaultStateDir());
  const takes = await listTakes(defaultTakesRoot(), recording);
  console.log(
    toonTable(
      "takes",
      ["id", "status", "duration_s", "frames", "pointer"],
      takes.map((t) => [
        t.id,
        t.status,
        t.durationMs === null ? null : (t.durationMs / 1000).toFixed(1),
        t.frames,
        t.pointer,
      ]),
    ),
  );
}

async function readRecording(stateDirPath: string) {
  const { readFile } = await import("node:fs/promises");
  const { parsePidFile } = await import("./takes.js");
  try {
    return parsePidFile(await readFile(join(stateDirPath, "recording.pid"), "utf8"));
  } catch {
    return null;
  }
}

async function record(args: string[]): Promise<void> {
  const { runRecord } = await import("./record.js");
  const { toonTable } = await import("./toon.js");
  const flags = parseFlags(args);
  try {
    const result = await runRecord({
      ...(flags.fps === undefined ? {} : { fps: flags.fps }),
      ...(flags.bitrateKbps === undefined ? {} : { bitrateKbps: flags.bitrateKbps }),
      ...(flags.root === undefined ? {} : { takesRoot: flags.root }),
      ...(flags.state === undefined ? {} : { stateDirPath: flags.state }),
    });
    const { takeJson } = result;
    console.log(`take ${takeJson.id} written: ${result.takeDir}`);
    console.log(toonTable("stop", ["frames", "offset_ms", "spread_ms", "trim_ms"], [
      [
        takeJson.clock?.frames ?? 0,
        takeJson.clock === null ? null : takeJson.clock.offsetMs.toFixed(1),
        takeJson.clock === null ? null : takeJson.clock.spreadMs.toFixed(1),
        `${takeJson.trim.start_ms}-${takeJson.trim.end_ms}`,
      ],
    ]));
  } catch (error) {
    const rec = error as { code?: unknown; message?: unknown; hint?: unknown };
    if (typeof rec.code === "string" && typeof rec.message === "string" && typeof rec.hint === "string") {
      fail({ code: rec.code, message: rec.message, hint: rec.hint });
    }
    internal(error);
  }
}

async function stop(): Promise<void> {
  const { defaultStateDir } = await import("./record.js");
  const { toonTable } = await import("./toon.js");
  const { rm } = await import("node:fs/promises");
  const stateDirPath = defaultStateDir();
  const recording = await readRecording(stateDirPath);
  if (recording === null) {
    await rm(join(stateDirPath, "recording.pid"), { force: true }).catch(() => undefined);
    fail({
      code: "not-recording",
      message: "no recording is active",
      hint: "start one with `takeone record`",
    });
  }
  try {
    process.kill(recording.pid, "SIGINT");
  } catch (error) {
    fail({
      code: "signal-failed",
      message: error instanceof Error ? error.message : String(error),
      hint: "the recorder may have exited; run `takeone` to see takes",
    });
  }
  console.log(toonTable("stopping", ["pid", "take"], [[recording.pid, recording.take]]));
}

async function doctor(): Promise<number> {
  const { runDoctor, formatDoctor } = await import("./doctor.js");
  const checks = await runDoctor();
  console.log(formatDoctor(checks));
  return checks.every((c) => c.ok) ? 0 : 1;
}

async function runRecorderCommand(command: string, args: string[]): Promise<number> {
  if (command === "list") { await list(); return 0; }
  if (command === "record") { await record(args); return 0; }
  if (command === "stop") { await stop(); return 0; }
  if (command === "doctor") return doctor();
  if (command === "help" || command === "--help") {
    console.log(`takeone

USAGE:
  takeone                 list takes
  takeone record [--fps 30] [--bitrate 40000]   record the desktop (asks screen-share consent)
  takeone stop            stop the active recording
  takeone doctor          check what the recorder needs on this machine`);
    return 0;
  }
  fail({
    code: "unknown-command",
    message: `unknown command: ${command}`,
    hint: "run `takeone` to list takes, or `takeone --help`",
  });
}
