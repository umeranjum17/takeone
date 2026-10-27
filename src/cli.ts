#!/usr/bin/env node
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setKeyFromStdin } from "./secrets.ts";
import { parseConfig, ConfigError } from "@byokit/decide";
import { savePlannerConfig, describePlanner } from "./decide/planner.ts";
import { runCapture } from "./capture.ts";
import { makeTake, PreflightRefusal, TakeInputError } from "./make.ts";
import { PlannerUnavailable } from "./decide/planner.ts";
import { PlanError } from "./decide/plan.ts";
import { renderTake, renderThreads } from "./render/render.ts";
import { previewSize } from "./render/preview.ts";
import { THEMES, resolveTheme } from "./themes.ts";
import { isMotionTake, MOTION_USAGE, runMotion } from "./motion/cli.ts";
import { renderMotion } from "./motion/motion.ts";
import { applyOverrides, type CameraDefaults, type Overrides } from "./camera/defaults.ts";
import { filmOverrides, type FilmDecision } from "./decide/film.ts";
import { packageVersion } from "./version.ts";
import { JudgeUnavailable } from "./score/judge.ts";
import { makeWithScore } from "./score/run.ts";
import { DEFAULT_MAX_ROUNDS, DEFAULT_TARGET_SCORE } from "./score/loop.ts";

export function takesDir(): string {
  return process.env["TAKEONE_DIR"] ?? join(homedir(), "Videos", "takeone");
}

interface Args {
  id?: string;
  noAi: boolean;
  goal?: string;
  style?: string;
  noScreenText: boolean;
  replan: boolean;
  maxTokens?: number;
  set: string[];
  camera?: CameraDefaults;
  theme?: string;
  targetScore?: number;
  maxRounds?: number;
  scoreRequested: boolean;
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
    overrides[k!] = ["background", "background_to", "accent", "text", "card", "caption_font", "display_font", "bg_style", "bg_stops", "background_image"].includes(k!) || !Number.isFinite(n) ? v! : n;
  }
  return overrides as Overrides;
}

/** Resolve a take look from its saved theme, the film `make` decided, CLI selection and `--set` pairs.
 * Throws on malformed pairs. Portrait takes default to portrait output. `make` passes
 * withFilm false: it applies its own film decision after this. */
export function resolveCamera(dir: string, pairs: string[], theme?: string, withFilm = true): CameraDefaults {
  const raw = parseSet(pairs);
  const meta = JSON.parse(readFileSync(join(dir, "take.json"), "utf8")) as { theme?: unknown; film?: FilmDecision };
  const selected = theme ?? meta.theme;
  if (!("out_w" in raw) && !("out_h" in raw) && isPortraitTake(dir)) {
    raw.out_w = 1080;
    raw.out_h = 1920;
  }
  const film = withFilm && meta.film ? filmOverrides(meta.film, selected === undefined, Object.keys(raw)) : {};
  return resolveTheme(selected, { ...film, ...raw });
}

function sourceAspect(dir: string): "landscape" | "portrait" | "square" {
  try {
    const m = JSON.parse(readFileSync(join(dir, "take.json"), "utf8")) as {
      stream?: { w: number; h: number };
      width?: number; height?: number;
    };
    const w = m.stream ? m.stream.w : m.width;
    const h = m.stream ? m.stream.h : m.height;
    if (w !== undefined && h !== undefined) {
      if (h > w) return "portrait";
      if (w === h) return "square";
    }
    return "landscape";
  } catch {
    return "landscape";
  }
}

function isPortraitTake(dir: string): boolean {
  return sourceAspect(dir) === "portrait";
}

const ASPECTS = ["landscape", "portrait", "square", "4:5"] as const;
type Aspect = (typeof ASPECTS)[number];

/** Normalize the aspect names and the ratio spellings the docs and scorecard use. */
function normalizeAspect(aspect: string): Aspect {
  const aliases: Record<string, Aspect> = {
    landscape: "landscape", "16:9": "landscape",
    portrait: "portrait", "9:16": "portrait",
    square: "square", "1:1": "square",
    "4:5": "4:5",
  };
  const name = aliases[aspect];
  if (!name) throw Error(`unknown aspect ${aspect}; use landscape, portrait, square or 4:5 (or 16:9, 9:16, 1:1)`);
  return name;
}

export function renderDimensions(aspect?: string, resolution?: string, source: "landscape" | "portrait" | "square" = "landscape"): Overrides {
  const dimensions: Overrides = {};
  const name = aspect === undefined ? undefined : normalizeAspect(aspect);
  if (name !== undefined) {
    [dimensions.out_w, dimensions.out_h] = {
      landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080], "4:5": [1080, 1350],
    }[name];
  }
  if (resolution !== undefined) {
    if (resolution !== "4k") throw Error(`unknown resolution ${resolution}; use 4k`);
    // 4K keeps the long edge at 3840 pixels for every orientation.
    [dimensions.out_w, dimensions.out_h] = {
      landscape: [3840, 2160], portrait: [2160, 3840], square: [3840, 3840], "4:5": [3072, 3840],
    }[name ?? source];
  }
  return dimensions;
}

/** A sentence, not an essay: both hints ride along in every beat's request,
 * and anything near the 1,200-token request cap would push whole runs of
 * beats past it. */
const GOAL_STYLE_MAX_CHARS = 500;

function parseArgs(argv: string[]): Args {
  const a: Args = { noAi: false, noScreenText: false, replan: false, set: [], scoreRequested: false };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i]!;
    if (s === "--no-ai") a.noAi = true;
    else if (s === "--theme") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw Error("--theme needs a theme name");
      a.theme = value;
    }
    else if (s === "--goal" || s === "--about") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw Error(`${s} needs a sentence`);
      if (value.length > GOAL_STYLE_MAX_CHARS) throw Error(`${s} must be at most ${GOAL_STYLE_MAX_CHARS} characters`);
      a.goal = value;
    }
    else if (s === "--style") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw Error("--style needs a word or short sentence");
      if (value.length > GOAL_STYLE_MAX_CHARS) throw Error(`--style must be at most ${GOAL_STYLE_MAX_CHARS} characters`);
      a.style = value;
    }
    else if (s === "--no-screen-text") a.noScreenText = true;
    else if (s === "--replan") a.replan = true;
    else if (s === "--max-tokens") a.maxTokens = Number(argv[++i]);
    else if (s === "--target-score" || s === "--max-rounds") {
      a.scoreRequested = true;
      const next = argv[i + 1];
      const value = next === undefined || next.startsWith("--") ? undefined : next;
      if (value !== undefined) i++;
      if (s === "--target-score") {
        if (value !== undefined) a.targetScore = Number(value);
      } else if (value !== undefined) a.maxRounds = Number(value);
    }
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
  const themes = Object.keys(THEMES).join("|");
  console.error(`takeone make <id> [--no-ai] [--goal "<sentence>"] [--style "<word>"] [--no-screen-text] [--replan] [--max-tokens N] [--theme ${themes}] [--set key=value] [--target-score N] [--max-rounds M]
takeone render <take-dir> [--theme ${themes}] [--set key=value] [--aspect landscape|portrait|square|4:5] [--resolution 4k] [--format mp4|gif|webm|prores4444] [--preview]
takeone render <motion-dir> [--aspect landscape|portrait|square|4:5] [--stills <seconds,...>]
${MOTION_USAGE}
takeone key set [--backend <name>] [--model <model>] [--via typesafe|openrouter] < stdin
takeone [list|record|stop|doctor]
takeone --version|-v    print the installed version

  make plans beats and camera decisions, then renders an MP4.
  render creates a camera path and MP4 from a planned take.
  key set --backend <name> stores that provider's key and records the planner choice.

  --no-ai         decide every beat with the local heuristic; zero network calls
  --goal          what the demo is for; sharpens key moments (--about is an alias)
  --style         style hint for the film, e.g. calm, brisk
  --no-screen-text  do not send redacted screen words (sent by default with a planner)
  --replan        ignore saved planner answers and ask again
  --max-tokens    refuse above this many planned input tokens (default 40k x take minutes)
  --target-score  score the film against a 10-point rubric and re-render until it reaches N (default 9)
  --max-rounds    hard cap on score rounds (default 4): one judge call per round, plus one determinism re-render`);
  process.exit(code);
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "capture") return runCapture(rest);
  if (cmd === "key") {
    if (rest.length !== 1 || rest[0] !== "set") {
      // Flag form records the provider choice as well as the key.
      if (rest.includes("set")) return runKeySet(rest);
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
    } catch (e) {
      console.error(`could not store Jev key; check stdin, the OS keyring or TAKEONE_SECRETS_PASSPHRASE_FD for the BYOKit sealed store (${e instanceof Error ? e.message : e})`);
      return 1;
    }
  }
  if (!cmd || cmd === "list" || cmd === "record" || cmd === "stop" || cmd === "doctor") {
    return runRecorderCommand(cmd ?? "list", rest);
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") usage(0);
  if (cmd === "--version" || cmd === "-v") {
    console.log(packageVersion());
    return 0;
  }
  if (cmd === "motion") {
    try {
      return await runMotion(rest, takesDir());
    } catch (e) {
      console.error(e instanceof PlannerUnavailable && e.credentialMissing ? e.message : `takeone motion: ${e instanceof Error ? e.message : e}`);
      return e instanceof PlannerUnavailable ? 3 : 1;
    }
  }
  if (cmd === "render") {
    const [dir, ...args] = rest;
    if (!dir) { console.error("usage: takeone render <take-dir>"); return 2; }
    if (isMotionTake(dir)) {
      try {
        // The film is the storyboard; only the frame size (one timeline, every format), stills and engine are options.
        let size: [number, number] | undefined, stills: number[] | undefined, engine: "hyperframes" | "legacy" | undefined;
        for (let i = 0; i < args.length; i += 2) {
          const [option, value] = [args[i], args[i + 1]];
          if (value === undefined || !["--aspect", "--stills", "--engine"].includes(option!)) throw Error("a motion take rerenders from its storyboard.json; edit it, or pass only --aspect <name>, --stills <t,...> and --engine hyperframes|legacy");
          if (option === "--aspect") { const d = renderDimensions(value); size = [Number(d.out_w), Number(d.out_h)]; }
          else if (option === "--engine") {
            if (value !== "hyperframes" && value !== "legacy") throw Error("--engine expects hyperframes or legacy");
            engine = value;
          } else stills = value.split(",").map(Number);
        }
        if (engine === undefined) {
          try { engine = (JSON.parse(readFileSync(join(dir, "render.json"), "utf8")) as { engine?: "hyperframes" | "legacy" }).engine; } catch { /* first render has no manifest */ }
        }
        if (stills) console.log((await renderMotion(dir, { size, stills })).stills.join("\n"));
        else console.log((await renderMotion(dir, { size, engine })).out);
        return 0;
      } catch (e) {
        console.error(e instanceof Error ? e.message : e);
        return 1;
      }
    }
    try {
      const pairs: string[] = [];
      let theme: string | undefined;
      let aspect: string | undefined;
      let resolution: string | undefined;
      let format = "mp4";
      let preview = false;
      for (let i = 0; i < args.length; i++) {
        const option = args[i];
        if (option === "--preview") { preview = true; continue; }
        if (!["--set", "--theme", "--aspect", "--resolution", "--format"].includes(option!)) {
          throw Error(`unknown option ${option}`);
        }
        const value = args[++i];
        if (value === undefined || value.startsWith("--")) throw Error(`${option} needs a value`);
        if (option === "--set") pairs.push(value);
        else if (option === "--theme") theme = value;
        else if (option === "--aspect") aspect = value;
        else if (option === "--resolution") resolution = value;
        else if (option === "--format") format = value;
      }
      const dimensions = renderDimensions(aspect, resolution, sourceAspect(dir));
      if (!["mp4", "gif", "webm", "prores4444"].includes(format)) {
        throw Error(`unknown format ${format}; use mp4, gif, webm or prores4444`);
      }
      const camera = resolveCamera(dir, pairs, theme);
      const full = applyOverrides(dimensions, camera);
      // A preview is the same film, framed the same way, at a fraction of the render cost.
      const spec = preview ? { ...previewSize(full.out_w, full.out_h), fps: 30 } : undefined;
      const rendered = (await renderTake(dir, full, spec)).out;
      if (format === "mp4") console.log(rendered);
      else {
        const suffix = format === "prores4444" ? "mov" : format;
        const output = rendered.replace(/\.mp4$/, `.${suffix}`);
        const threads = renderThreads();
        if (format === "gif") {
          execFileSync("ffmpeg", ["-nostdin", "-y", "-threads", threads, "-i", rendered, "-filter_threads", threads, "-threads", threads, "-vf", "fps=15,scale='min(1080,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse", output], { stdio: ["ignore", "ignore", "inherit"] });
        } else if (format === "webm") {
          execFileSync("ffmpeg", ["-nostdin", "-y", "-threads", threads, "-i", rendered, "-threads", threads, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", output], { stdio: ["ignore", "ignore", "inherit"] });
        } else {
          execFileSync("ffmpeg", ["-nostdin", "-y", "-threads", threads, "-i", rendered, "-threads", threads, "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le", output], { stdio: ["ignore", "ignore", "inherit"] });
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
    console.error(`takeone: unknown command "${cmd}". Use "make", "render", "motion", "record", "stop", "doctor" or "list".`);
    return 2;
  }
  const a = parseArgs(rest);
  if (a.maxTokens !== undefined && (!Number.isSafeInteger(a.maxTokens) || a.maxTokens <= 0)) {
    console.error("takeone make: --max-tokens must be a positive integer");
    return 2;
  }
  if (a.targetScore !== undefined && (!Number.isFinite(a.targetScore) || a.targetScore < 0 || a.targetScore > 10)) {
    console.error("takeone make: --target-score must be between 0 and 10");
    return 2;
  }
  if (a.maxRounds !== undefined && (!Number.isSafeInteger(a.maxRounds) || a.maxRounds < 1 || a.maxRounds > 20)) {
    console.error("takeone make: --max-rounds must be an integer from 1 to 20");
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
    a.camera = resolveCamera(dir, a.set, a.theme, false);
  } catch (e) {
    console.error(`takeone make: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  try {
    if (a.scoreRequested) {
      const scored = await makeWithScore({
        dir,
        make: a,
        target: a.targetScore ?? DEFAULT_TARGET_SCORE,
        maxRounds: a.maxRounds ?? DEFAULT_MAX_ROUNDS,
        log: (line) => console.log(line),
        warn: (line) => console.error(line),
        resolveFilmCamera: (takeDir, pairs, theme) => resolveCamera(takeDir, pairs, theme, true),
      });
      return scored.judgeUnavailable ? 3 : 0;
    }
    await makeTake(dir, a);
    return 0;
  } catch (e) {
    if (e instanceof PreflightRefusal || e instanceof TakeInputError || e instanceof PlanError || e instanceof ConfigError) {
      console.error(`takeone make: ${e.message}`);
      return 2;
    }
    if (e instanceof PlannerUnavailable || e instanceof JudgeUnavailable) {
      console.error(e instanceof PlannerUnavailable && e.credentialMissing ? e.message : `takeone make: ${e.message}`);
      return 3;
    }
    throw e;
  }
}

/** `takeone key set`: store one backend's key from stdin and record the
 * provider choice. Keys go through BYOKit secrets; the choice is a stored
 * BYOKit decide config (planner.json). */
async function runKeySet(rest: string[]): Promise<number> {
  let sub: string | undefined;
  let backend: string | undefined;
  let model: string | undefined;
  let via: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const s = rest[i]!;
    if (s === "set" && sub === undefined) sub = s;
    else if (s === "--backend") {
      const v = rest[++i];
      if (!v || v.startsWith("--")) { console.error("takeone key set: --backend needs a backend name"); return 2; }
      backend = v;
    } else if (s === "--model") {
      const v = rest[++i];
      if (!v || v.startsWith("--")) { console.error("takeone key set: --model needs a model"); return 2; }
      model = v;
    } else if (s === "--via") {
      const v = rest[++i];
      if (!v || v.startsWith("--")) { console.error("takeone key set: --via needs typesafe or openrouter"); return 2; }
      via = v;
    } else {
      console.error(`takeone key set: unknown option ${s}`);
      return 2;
    }
  }
  if (sub !== "set") {
    console.error("usage: takeone key set [--backend <name>] [--model <model>] [--via typesafe|openrouter] < stdin (no key arguments)");
    return 2;
  }
  if (backend === undefined && (model !== undefined || via !== undefined)) {
    console.error("takeone key set: --model and --via need --backend");
    return 2;
  }
  backend ??= "jev";
  let config;
  try {
    config = parseConfig({ backend, auth: "apiKey", ...(model === undefined ? {} : { model }), ...(via === undefined ? {} : { via }) });
  } catch (e) {
    console.error(`takeone key set: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  if (process.stdin.isTTY) {
    console.error("pipe the key into takeone key set; use a hidden-input prompt or a credential manager");
    return 2;
  }
  try {
    await setKeyFromStdin(process.stdin, backend);
  } catch (e) {
    console.error(`could not store planner key; check stdin, the OS keyring or TAKEONE_SECRETS_PASSPHRASE_FD for the BYOKit sealed store (${e instanceof Error ? e.message : e})`);
    return 1;
  }
  try {
    await savePlannerConfig(config);
  } catch {
    console.error("planner key stored, but the provider choice could not be recorded in planner.json; run key set again to record it");
    return 1;
  }
  console.log(`planner key stored through BYOKit (${describePlanner(config)})`);
  return 0;
}
/** True when this module is the program that was run. `npm install -g`
 * launches the bin through a symlink (prefix/bin/takeone), so the as-invoked
 * argv[1] never matches anything: resolve it through realpath first, then
 * accept either this module's own URL (direct dist run) or the package bin
 * path that imports this module (bin and symlinked entry points). */
function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    const real = realpathSync(invoked);
    if (import.meta.url === pathToFileURL(real).href) return true;
    return real.endsWith("/bin/takeone.mjs");
  } catch {
    return invoked.endsWith("/bin/takeone.mjs");
  }
}

if (isMainModule()) {
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
  iosUdid?: string;
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
    if (!["--fps", "--bitrate", "--root", "--state-dir", "--android", "--touch-offset-ms", "--ios-udid"].includes(name) || value === undefined || value === "" || value.startsWith("--") || seen.has(name)) {
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
    } else if (name === "--ios-udid") flags.iosUdid = value;
    else if (name === "--root") flags.root = value;
    else flags.state = value;
  }
  if (flags.iosUdid !== undefined && !flags.iosSim) {
    fail({ code: "invalid-arguments", message: "--ios-udid needs --ios-sim", hint: "run `takeone --help`" });
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
      onRecording: reportRecordingReady,
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

/** One shared ready line for every record path, printed once capture is really running. */
function reportRecordingReady(takeDir: string): void {
  console.error(`recording: ${takeDir}; Ctrl-C or takeone stop to finish`);
}

async function recordAndroid(flags: Flags): Promise<void> {
  const { runAndroidRecord } = await import("./android/record.js");
  const { toonTable } = await import("./toon.js");
  try {
    const result = await runAndroidRecord({
      serial: flags.android!,
      onReady: reportRecordingReady,
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
      ...(flags.iosUdid === undefined ? {} : { udid: flags.iosUdid }),
      ...(flags.root === undefined ? {} : { takesRoot: flags.root }),
      ...(flags.state === undefined ? {} : { stateDirPath: flags.state }),
      onReady: reportRecordingReady,
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
  const { runDoctor, formatDoctor, doctorExitCode } = await import("./doctor.js");
  const checks = await runDoctor();
  console.log(formatDoctor(checks));
  return doctorExitCode(checks);
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
  takeone record --ios-sim [--ios-udid UUID]   record the booted iOS Simulator into a take (macOS only)
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
