// `takeone capture ...`: recorder protocol v1 surface: hello, record, stop, make.
import { readFileSync, writeFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { keyStatus, type KeyOptions } from "./secrets.ts";
import { makeTake, PreflightRefusal, TakeInputError } from "./make.ts";
import { resolveCamera } from "./cli.ts";

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

interface MakeArgs {
  take?: string;
  planOnly: boolean;
  noPlanner: boolean;
  plannerKeyFd?: number;
  maxTokens?: number;
  title?: string;
  captionsFile?: string;
  set: string[];
}

function parseMakeArgs(argv: string[]): MakeArgs {
  const a: MakeArgs = { planOnly: false, noPlanner: false, set: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i]!;
    if (s === "--plan-only") a.planOnly = true;
    else if (s === "--no-planner") a.noPlanner = true;
    else if (s === "--planner-key-fd") {
      const v = argv[++i];
      const fd = v === undefined ? NaN : Number(v);
      if (!Number.isSafeInteger(fd) || fd < 0) {
        captureFail({
          code: "invalid-arguments",
          message: "--planner-key-fd needs a file descriptor number",
          hint: "run `takeone capture make <take> --planner-key-fd 3`",
        });
      }
      a.plannerKeyFd = fd;
    } else if (s === "--max-tokens") {
      const n = Number(argv[++i]);
      if (!Number.isSafeInteger(n) || n <= 0) {
        captureFail({
          code: "invalid-arguments",
          message: "--max-tokens must be a positive integer",
          hint: "run `takeone capture make <take> --max-tokens 40000`",
        });
      }
      a.maxTokens = n;
    } else if (s === "--title") {
      const v = argv[++i];
      if (v === undefined) {
        captureFail({
          code: "invalid-arguments",
          message: "--title needs a value",
          hint: "run `takeone capture make <take> --title \"Demo\"`",
        });
      }
      a.title = v;
    } else if (s === "--captions") {
      const v = argv[++i];
      if (v === undefined) {
        captureFail({
          code: "invalid-arguments",
          message: "--captions needs a JSON file",
          hint: "run `takeone capture make <take> --captions captions.json`",
        });
      }
      a.captionsFile = v;
    } else if (s === "--set") {
      const v = argv[++i];
      if (v === undefined) {
        captureFail({
          code: "invalid-arguments",
          message: "--set needs key=value",
          hint: "run `takeone capture make <take> --set out_w=1080`",
        });
      }
      a.set.push(v);
    } else if (!s.startsWith("--") && a.take === undefined) a.take = s;
    else {
      captureFail({
        code: "invalid-arguments",
        message: `unknown capture make option: ${s}`,
        hint: "run `takeone capture make <take> [--plan-only] [--no-planner] [--max-tokens N]`",
      });
    }
  }
  return a;
}

/** Planner key from the given fd only; never env, argv or config files. */
function readPlannerKey(fd: number): string {
  let key: string;
  try {
    key = readFileSync(fd, "utf8").trim();
  } catch {
    captureFail({
      code: "invalid-arguments",
      message: `cannot read planner key from fd ${fd}`,
      hint: "pass an open readable fd with --planner-key-fd N",
    });
  }
  if (!key!) {
    captureFail({
      code: "invalid-arguments",
      message: `planner key on fd ${fd} is empty`,
      hint: "write the key to the fd before calling capture make",
    });
  }
  return key!;
}

/** Captions file entries, normalised to the take.json shape the renderer reads. */
function readCaptionsFile(path: string): { t: number; d?: number; text: string }[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    captureFail({
      code: "invalid-arguments",
      message: `captions file is not valid JSON: ${path}`,
      hint: "pass a JSON array of {t, text, d?}",
    });
  }
  if (!Array.isArray(raw)) {
    captureFail({
      code: "invalid-arguments",
      message: `captions file must hold a JSON array: ${path}`,
      hint: "pass a JSON array of {t, text, d?}",
    });
  }
  return (raw as unknown[]).map((entry, i) => {
    const e = entry as { t?: unknown; d?: unknown; text?: unknown };
    if (!e || typeof e !== "object" || !Number.isFinite(e.t as number) || typeof e.text !== "string") {
      captureFail({
        code: "invalid-arguments",
        message: `captions[${i}] needs a numeric t and a string text`,
        hint: "pass a JSON array of {t, text, d?}",
      });
    }
    const out: { t: number; d?: number; text: string } = { t: e.t as number, text: e.text as string };
    if (Number.isFinite(e.d as number) && (e.d as number) > 0) out.d = e.d as number;
    return out;
  });
}

async function runCaptureMake(argv: string[]): Promise<number> {
  const a = parseMakeArgs(argv);
  if (a.take === undefined) {
    captureFail({
      code: "invalid-arguments",
      message: "capture make needs a take directory",
      hint: "run `takeone capture make <take> [--plan-only] [--no-planner]`",
    });
  }
  if (a.noPlanner && a.plannerKeyFd !== undefined) {
    captureFail({
      code: "invalid-arguments",
      message: "--no-planner and --planner-key-fd conflict",
      hint: "pass one or the other, not both",
    });
  }
  const dir = resolve(a.take!);
  const key = a.plannerKeyFd !== undefined ? readPlannerKey(a.plannerKeyFd) : null;

  let take: Record<string, unknown>;
  try {
    take = JSON.parse(readFileSync(`${dir}/take.json`, "utf8")) as Record<string, unknown>;
  } catch {
    captureFail({
      code: "take-input",
      message: "take.json: missing or invalid",
      hint: `check ${dir}/take.json exists and parses`,
    });
  }
  if (a.title !== undefined) take!.title = a.title;
  if (a.captionsFile !== undefined) take!.captions = readCaptionsFile(a.captionsFile);
  if (a.title !== undefined || a.captionsFile !== undefined) {
    try {
      writeFileSync(`${dir}/take.json`, JSON.stringify(take!, null, 1) + "\n");
    } catch (e) {
      captureFail({
        code: "take-input",
        message: `take.json: ${e instanceof Error ? e.message : e}`,
        hint: `check ${dir}/take.json is writable`,
      });
    }
  }

  let camera;
  try {
    camera = resolveCamera(dir, a.set);
  } catch (e) {
    captureFail({
      code: "invalid-arguments",
      message: e instanceof Error ? e.message : String(e),
      hint: "pass --set key=value pairs",
    });
  }

  // Stdout carries exactly one JSON object; the pipeline logs to stderr.
  const warnings: string[] = [];
  if (key === null) warnings.push("no planner key; using heuristic policy for all beats");
  try {
    const r = await makeTake(dir, {
      capture: true,
      ...(key === null ? { noJev: true } : { apiKey: key }),
      ...(a.maxTokens === undefined ? {} : { maxTokens: a.maxTokens }),
      ...(camera === undefined ? {} : { camera }),
      ...(a.planOnly ? { planOnly: true } : {}),
      log: (line: string) => console.error(line),
      warn: (line: string) => {
        warnings.push(line);
        console.error(line);
      },
    });
    console.log(
      JSON.stringify(
        a.planOnly
          ? {
              out: null,
              seconds: 0,
              beats: r.beats.length,
              planner: {
                planned_tokens: r.planned.planned_tokens,
                input_tokens: 0,
                usd: r.planned.usd,
                failed: r.jev.failed > 0,
              },
              warnings,
            }
          : {
              out: r.out,
              seconds: r.seconds,
              beats: r.beats.length,
              planner: {
                planned_tokens: r.planned.planned_tokens,
                input_tokens: r.jev.input_tokens,
                usd: r.jev.usd,
                failed: r.jev.failed > 0,
              },
              warnings,
            },
      ),
    );
    return 0;
  } catch (e) {
    if (e instanceof PreflightRefusal) {
      // 6.7: extra fields sit inside `error` so the kit's parser finds them.
      const error: CaptureError & { planned?: number; cap?: number } = {
        code: "preflight-refused",
        message: e.message,
        hint: "raise --max-tokens or pass --no-planner",
        ...(e.plannedTokens === undefined ? {} : { planned: e.plannedTokens, cap: e.cap }),
      };
      writeSync(1, JSON.stringify({ error }) + "\n");
      process.exit(1);
    }
    if (e instanceof TakeInputError) {
      captureFail({
        code: "take-input",
        message: e.message,
        hint: "check the take directory inputs (take.json, screen.webm, frames.tsv, events.jsonl)",
      });
    }
    captureFail({
      code: "render-failed",
      message: e instanceof Error ? e.message : String(e),
      hint: "re-run capture make with the same take directory",
    });
  }
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

export async function runCapture(argv: string[], keys: KeyOptions = {}): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === "hello" && rest.length === 0) {
    console.log(
      JSON.stringify({
        protocol: 1,
        recorder: { name: "takeone", version: recorderVersion() },
        sources: ["screen", "x11"],
        android: false,
        events: ["own", "none"],
        // presence only; the key itself is never printed
        planner: { available: (await keyStatus(keys)).available, needsKey: true },
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
  if (verb === "make") return runCaptureMake(rest);
  if (verb === "record") return runCaptureRecord(rest);
  if (verb === "stop") return runCaptureStop(rest);
  captureFail({
    code: "invalid-arguments",
    message: verb === undefined ? "capture needs a verb" : `unknown capture verb: ${verb}`,
    hint: "run `takeone capture hello`",
  });
}
