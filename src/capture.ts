// `takeone capture ...`: recorder protocol v1 surface.
import { readFileSync, writeSync } from "node:fs";
import { loadApiKey } from "./decide/jev.ts";

export interface CaptureError {
  code: string;
  message: string;
  hint: string;
}

/** Capture-scoped failure: envelope on stdout; usage errors exit 2, rest exit 1. */
export function captureFail(error: CaptureError): never {
  writeSync(1, JSON.stringify({ error }) + "\n");
  process.exit(error.code === "invalid-arguments" ? 2 : 1);
}

/** One JSON line on stdout; recorder logs go to stderr, never here. */
function emit(line: unknown): void {
  writeSync(1, JSON.stringify(line) + "\n");
}

function invalidArguments(message: string, hint: string): never {
  captureFail({ code: "invalid-arguments", message, hint });
}

/** package.json version, resolved from the installed layout (dist/../package.json). */
function recorderVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    if (typeof pkg.version === "string" && pkg.version) return pkg.version;
  } catch {
    // installed without a readable package.json; beat on without a version
  }
  return "0.0.0";
}

export interface CaptureRecordOptions {
  source: { kind: "portal" } | { kind: "x11"; display?: string };
  root: string;
  stateDir: string;
  events: "own" | "none";
  maxSeconds?: number;
}

const RECORD_HINT =
  "run `takeone capture record --source screen|x11:<display> --root <dir> --state-dir <dir> [--events own|none] [--max-seconds N]`";

/** Parse `capture record` flags; usage problems fail with the envelope (exit 2). */
export function parseCaptureRecordArgs(args: string[]): CaptureRecordOptions {
  let source: CaptureRecordOptions["source"] | undefined;
  let root: string | undefined;
  let stateDir: string | undefined;
  let events: "own" | "none" = "own";
  let maxSeconds: number | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!;
    const value = args[i + 1];
    if (
      !["--source", "--root", "--state-dir", "--events", "--max-seconds"].includes(name) ||
      seen.has(name) ||
      value === undefined ||
      value === "" ||
      value.startsWith("--")
    ) {
      invalidArguments(`invalid record option: ${name}`, RECORD_HINT);
    }
    seen.add(name);
    i++;
    if (name === "--source") {
      if (value === "screen") source = { kind: "portal" };
      else if (value === "x11") source = { kind: "x11" };
      else if (value.startsWith("x11:")) {
        const display = value.slice("x11:".length);
        if (display === "") invalidArguments(`invalid --source ${value} (want screen or x11:<display>)`, RECORD_HINT);
        source = { kind: "x11", display };
      } else invalidArguments(`invalid --source ${value} (want screen or x11:<display>)`, RECORD_HINT);
    } else if (name === "--root") root = value;
    else if (name === "--state-dir") stateDir = value;
    else if (name === "--events") {
      if (value !== "own" && value !== "none") invalidArguments(`invalid --events ${value} (want own or none)`, RECORD_HINT);
      events = value;
    } else {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) invalidArguments("--max-seconds must be a positive number of seconds", RECORD_HINT);
      maxSeconds = n;
    }
  }
  if (source === undefined || root === undefined || stateDir === undefined) {
    invalidArguments("capture record needs --source, --root and --state-dir", RECORD_HINT);
  }
  return { source, root, stateDir, events, ...(maxSeconds === undefined ? {} : { maxSeconds }) };
}

async function runCaptureRecord(args: string[]): Promise<number> {
  const opts = parseCaptureRecordArgs(args);
  const { runRecord } = await import("./record.js");
  emit({ event: "consent-pending" });
  try {
    const result = await runRecord({
      takesRoot: opts.root,
      stateDirPath: opts.stateDir,
      source: opts.source,
      events: opts.events,
      ...(opts.maxSeconds === undefined ? {} : { maxSeconds: opts.maxSeconds }),
      onRecording: (take) => emit({ event: "recording", take }),
    });
    emit({
      event: "done",
      take: result.takeDir,
      seconds: Math.round((result.takeJson.trim?.end ?? 0) / 100) / 10,
      warnings: result.takeJson.warnings,
    });
    return 0;
  } catch (error) {
    const rec = error as { code?: unknown; message?: unknown; hint?: unknown };
    if (typeof rec?.code === "string" && typeof rec?.message === "string" && typeof rec?.hint === "string") {
      captureFail({ code: rec.code, message: rec.message, hint: rec.hint });
    }
    captureFail({
      code: "internal",
      message: error instanceof Error ? error.message : String(error),
      hint: "this is a takeone bug; report the command and this message",
    });
  }
}

async function runCaptureStop(args: string[]): Promise<number> {
  const hint = "run `takeone capture stop --state-dir <dir>`";
  const dir = args.length === 2 && args[0] === "--state-dir" ? args[1] : undefined;
  if (dir === undefined || dir === "" || dir.startsWith("--")) {
    invalidArguments(
      args.length === 0 ? "capture stop needs --state-dir <dir>" : `invalid stop option: ${args.join(" ")}`,
      hint,
    );
  }
  const stateDir: string = dir;
  const [{ parsePidFile }, { readFile, unlink }, { join }] = await Promise.all([
    import("./takes.js"),
    import("node:fs/promises"),
    import("node:path"),
  ]);
  const pidPath = join(stateDir, "recording.pid");
  const raw = await readFile(pidPath, "utf8").catch(() => null);
  const recording = raw === null ? null : parsePidFile(raw);
  if (recording === null) {
    // Mirror `takeone stop`: a stale pid file is dropped, not kept.
    if (raw !== null) await unlink(pidPath).catch(() => undefined);
    captureFail({
      code: "not-recording",
      message: "no recording is active",
      hint: "start one with `takeone capture record`",
    });
  }
  try {
    process.kill(recording.pid, "SIGINT");
  } catch (error) {
    captureFail({
      code: "signal-failed",
      message: error instanceof Error ? error.message : String(error),
      hint: "the recorder may have exited; run `takeone` to see takes",
    });
  }
  emit({ stopping: true });
  return 0;
}

export async function runCapture(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === "hello" && rest.length === 0) {
    console.log(
      JSON.stringify({
        protocol: 1,
        recorder: { name: "takeone", version: recorderVersion() },
        sources: ["screen", "x11"],
        android: false,
        // presence only; the key itself is never printed
        planner: { available: loadApiKey() !== null, needsKey: true },
      }),
    );
    return 0;
  }
  if (verb === "hello" && rest.length > 0) {
    captureFail({
      code: "invalid-arguments",
      message: "capture hello takes no arguments",
      hint: "run `takeone capture hello`",
    });
  }
  if (verb === "record") return runCaptureRecord(rest);
  if (verb === "stop") return runCaptureStop(rest);
  captureFail({
    code: "invalid-arguments",
    message: verb === undefined ? "capture needs a verb" : `unknown capture verb: ${verb}`,
    hint: "run `takeone capture hello`",
  });
}
