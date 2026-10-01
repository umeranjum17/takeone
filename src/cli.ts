#!/usr/bin/env node
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setKeyFromStdin } from "./secrets.ts";
import { runCapture } from "./capture.ts";
import { makeTake, PreflightRefusal, TakeInputError } from "./make.ts";
import { renderTake } from "./render/render.ts";
import { applyOverrides, type CameraDefaults, type Overrides } from "./camera/defaults.ts";

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
export function parseSet(pairs: string[]): Overrides {
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

/** Camera overrides for a take dir from `--set` pairs; undefined without pairs.
 * Throws on malformed pairs. Portrait takes default to portrait output. */
export function resolveCamera(dir: string, pairs: string[]): CameraDefaults | undefined {
  if (pairs.length === 0) return undefined;
  const raw = parseSet(pairs);
  if (!("out_w" in raw) && !("out_h" in raw) && isPortraitTake(dir)) {
    raw.out_w = 1080;
    raw.out_h = 1920;
  }
  return applyOverrides(raw);
}

/** True when the take's stream is portrait (taller than wide). */
function isPortraitTake(dir: string): boolean {
  try {
    const m = JSON.parse(readFileSync(join(dir, "take.json"), "utf8")) as {
      stream?: { w: number; h: number };
    };
    return !!m.stream && m.stream.h > m.stream.w;
  } catch {
    return false;
  }
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
takeone key set < stdin
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
  if (cmd === "capture") return runCapture(rest);
  if (cmd === "key") {
    if (rest.length !== 1 || rest[0] !== "set") {
      console.error("usage: takeone key set < stdin (no key arguments)");
      return 2;
    }
    if (process.stdin.isTTY) {
      console.error("pipe the key into takeone key set; use a hidden-input prompt or a credential manager");
      return 2;
    }
    try {
      await setKeyFromStdin(process.stdin);
      console.log("Jev key stored through BYOKit");
      return 0;
    } catch {
      console.error("could not store Jev key; check stdin, the OS keyring or TAKEONE_SECRETS_PASSPHRASE_FD for the BYOKit sealed store");
      return 1;
    }
  }
  if (!cmd || cmd === "list" || cmd === "record" || cmd === "stop" || cmd === "doctor") {
    return runRecorderCommand(cmd ?? "list", rest);
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") usage(0);
  if (cmd === "render") {
    const [dir, ...args] = rest;
    if (!dir) { console.error("usage: takeone render <take-dir>"); return 2; }
    try {
      const pairs: string[] = [];
      let aspect: string | undefined;
      let resolution: string | undefined;
      let format = "mp4";
      for (let i = 0; i < args.length; i++) {
        const option = args[i];
        const value = args[++i];
        if (value === undefined) throw Error(`${option} needs a value`);
        if (option === "--set") pairs.push(value);
        else if (option === "--aspect") aspect = value;
        else if (option === "--resolution") resolution = value;
        else if (option === "--format") format = value;
        else throw Error(`unknown option ${option}`);
      }
      const raw = parseSet(pairs);
      if (aspect !== undefined) {
        const sizes: Record<string, [number, number]> = {
          landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080],
        };
        const size = sizes[aspect];
        if (!size) throw Error(`unknown aspect ${aspect}; use landscape, portrait or square`);
        raw.out_w = size[0]; raw.out_h = size[1];
      }
      if (resolution !== undefined) {
        if (resolution !== "4k") throw Error(`unknown resolution ${resolution}; use 4k`);
        const portrait = aspect === "portrait" || (aspect === undefined && isPortraitTake(dir));
        raw.out_w = portrait ? 2160 : 3840;
        raw.out_h = portrait ? 3840 : 2160;
      }
      if (!["mp4", "gif", "webm", "prores4444"].includes(format)) {
        throw Error(`unknown format ${format}; use mp4, gif, webm or prores4444`);
      }
      if (!("out_w" in raw) && !("out_h" in raw) && isPortraitTake(dir)) {
        raw.out_w = 1080;
        raw.out_h = 1920;
      }
      const rendered = (await renderTake(dir, applyOverrides(raw))).out;
      if (format === "mp4") console.log(rendered);
      else {
        const suffix = format === "prores4444" ? "mov" : format;
        const output = rendered.replace(/\.mp4$/, `.${suffix}`);
        if (format === "gif") {
          execFileSync("ffmpeg", ["-y", "-i", rendered, "-vf", "fps=15,scale='min(1080,iw)':-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse", output], { stdio: "ignore" });
        } else if (format === "webm") {
          execFileSync("ffmpeg", ["-y", "-i", rendered, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", output], { stdio: "ignore" });
        } else {
          execFileSync("ffmpeg", ["-y", "-i", rendered, "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le", output], { stdio: "ignore" });
        }
        console.log(output);
      }
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
  const dir = /^\//.test(a.id) ? a.id : join(takesDir(), a.id);
  if (!existsSync(join(dir, "take.json"))) {
    console.error(`takeone make: no take at ${dir} (take.json missing)`);
    return 2;
  }
  try {
    a.camera = resolveCamera(dir, a.set);
  } catch (e) {
    console.error(`takeone make: ${e instanceof Error ? e.message : e}`);
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
  android?: string;
  iosSim?: boolean;
  touchOffsetMs?: number;
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  const seen = new Set<string>();
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === "--ios-sim") {
      if (seen.has(arg)) fail({ code: "invalid-arguments", message: "invalid record option: --ios-sim", hint: "run `takeone --help`" });
      seen.add(arg);
      flags.iosSim = true;
    } else rest.push(arg);
  }
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]!;
    const value = rest[i + 1];
    if (!["--fps", "--bitrate", "--root", "--state-dir", "--android", "--touch-offset-ms"].includes(name) || value === undefined || value === "" || value.startsWith("--") || seen.has(name)) {
      fail({ code: "invalid-arguments", message: `invalid record option: ${name}`, hint: "run `takeone --help`" });
    }
    seen.add(name);
    if (name === "--fps" || name === "--bitrate") {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number <= 0) fail({ code: "invalid-arguments", message: `${name} must be a positive integer`, hint: "run `takeone --help`" });
      if (name === "--fps") flags.fps = number;
      else flags.bitrateKbps = number;
    } else if (name === "--android") flags.android = value;
    else if (name === "--touch-offset-ms") {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) fail({ code: "invalid-arguments", message: `${name} must be an integer`, hint: "run `takeone --help`" });
      flags.touchOffsetMs = number;
    } else if (name === "--root") flags.root = value;
    else flags.state = value;
  }
  if (flags.android === undefined && flags.touchOffsetMs !== undefined) {
    fail({ code: "invalid-arguments", message: "--touch-offset-ms needs --android", hint: "run `takeone --help`" });
  }
  if (flags.android !== undefined && (flags.fps !== undefined || flags.bitrateKbps !== undefined)) {
    fail({ code: "invalid-arguments", message: "--fps and --bitrate are desktop-only", hint: "run `takeone --help`" });
  }
  if (flags.iosSim && flags.android !== undefined) {
    fail({ code: "invalid-arguments", message: "--ios-sim and --android cannot be combined", hint: "run `takeone --help`" });
  }
  if (flags.iosSim && (flags.fps !== undefined || flags.bitrateKbps !== undefined || flags.touchOffsetMs !== undefined)) {
    fail({ code: "invalid-arguments", message: "--fps, --bitrate and --touch-offset-ms are not iOS Simulator options", hint: "run `takeone --help`" });
  }
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
  const { toonTable } = await import("./toon.js");
  const flags = parseFlags(args);
  if (flags.android !== undefined) {
    await recordAndroid(flags);
    return;
  }
  if (flags.iosSim) {
    await recordIosSim(flags);
    return;
  }
  const { runRecord } = await import("./record.js");
  try {
    const result = await runRecord({
      ...(flags.fps === undefined ? {} : { fps: flags.fps }),
      ...(flags.bitrateKbps === undefined ? {} : { bitrateKbps: flags.bitrateKbps }),
      ...(flags.root === undefined ? {} : { takesRoot: flags.root }),
      ...(flags.state === undefined ? {} : { stateDirPath: flags.state }),
    });
    const { takeJson } = result;
    console.log(toonTable("record", ["id", "take_path", "frames", "offset_ms", "spread_ms", "trim_ms"], [
      [
        takeJson.id,
        result.takeDir,
        takeJson.clock?.frames ?? 0,
        takeJson.clock === null ? null : takeJson.clock.offsetMs.toFixed(1),
        takeJson.clock === null ? null : takeJson.clock.spreadMs.toFixed(1),
        `${takeJson.trim!.start}-${takeJson.trim!.end}`,
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

async function recordAndroid(flags: Flags): Promise<void> {
  const { runAndroidRecord } = await import("./android/record.js");
  const { toonTable } = await import("./toon.js");
  try {
    const result = await runAndroidRecord({
      serial: flags.android!,
      ...(flags.touchOffsetMs === undefined ? {} : { touchOffsetMs: flags.touchOffsetMs }),
      ...(flags.root === undefined ? {} : { takesRoot: flags.root }),
      ...(flags.state === undefined ? {} : { stateDirPath: flags.state }),
    });
    const { takeJson } = result;
    console.log(toonTable("record", ["id", "take_path", "frames", "events", "offset_ms", "scale"], [
      [
        takeJson.id,
        result.takeDir,
        result.frames,
        result.events,
        takeJson.offset_ms,
        takeJson.scale,
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

async function recordIosSim(flags: Flags): Promise<void> {
  const { runIosSimRecord } = await import("./ios/record.js");
  const { toonTable } = await import("./toon.js");
  try {
    const result = await runIosSimRecord({
      ...(flags.root === undefined ? {} : { takesRoot: flags.root }),
      ...(flags.state === undefined ? {} : { stateDirPath: flags.state }),
    });
    const { takeJson } = result;
    console.log(toonTable("record", ["id", "take_path", "frames", "offset_ms", "scale"], [
      [
        takeJson.id,
        result.takeDir,
        result.frames,
        takeJson.offset_ms,
        takeJson.scale,
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
  const { parsePidFile } = await import("./takes.js");
  const stateDirPath = defaultStateDir();
  const recording = await readRecording(stateDirPath);
  if (recording === null) {
    try {
      const pidPath = join(stateDirPath, "recording.pid");
      if (parsePidFile(readFileSync(pidPath, "utf8")) === null) unlinkSync(pidPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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
  if (command !== "record" && args.length > 0) fail({ code: "invalid-arguments", message: `${command} takes no arguments`, hint: "run `takeone --help`" });
  if (command === "list") { await list(); return 0; }
  if (command === "record") { await record(args); return 0; }
  if (command === "stop") { await stop(); return 0; }
  if (command === "doctor") return doctor();
  if (command === "help" || command === "--help") {
    console.log(`takeone

USAGE:
  takeone                 list takes
  takeone record [--fps 30] [--bitrate 40000]   record the desktop (asks screen-share consent)
  takeone record --android <serial> [--touch-offset-ms 0]   record a phone or emulator into a take
  takeone record --ios-sim   record the booted iOS Simulator into a take (macOS only)
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
