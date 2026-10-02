import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveTheme } from "../themes.ts";
import { basename, dirname, join, resolve } from "node:path";
import type { CameraDefaults } from "../camera/defaults.ts";
import { manualZoomLimitWarning, solveCamera } from "../camera/solver.ts";
import type { Beat, CameraFrame, Decision, TakeMeta } from "../camera/types.ts";
import { idleSqueezes, setptsExpr, warp, warpBeats } from "./pace.ts";
import { editBeats, editTimeline, editZooms, validateEdits } from "./edits.ts";
import {
  beatClicks, captionAss, cardFilter, clickAss, measureAss, stageFrames, stageGeometry, stageImageFilter, takeCaptions,
  type Caption, type CaptionInk,
} from "./stage.ts";

/**
 * ffmpeg reparses perspective expressions every frame. Keep a compact piecewise
 * linear path, with at most 0.001 working-pixel error at any sampled corner.
 * Balanced lookup also keeps parser depth logarithmic on long takes.
 */
function frameExpr(values: number[]): string {
  if (values.length === 1) return values[0]!.toFixed(9);
  const knots = [0];
  const simplify = (lo: number, hi: number): void => {
    const slope = (values[hi]! - values[lo]!) / (hi - lo);
    let worst = 0.001;
    let split = -1;
    for (let i = lo + 1; i < hi; i++) {
      const error = Math.abs(values[i]! - values[lo]! - (i - lo) * slope);
      if (error > worst) { worst = error; split = i; }
    }
    if (split < 0) { knots.push(hi); return; }
    simplify(lo, split);
    simplify(split, hi);
  };
  simplify(0, values.length - 1);
  const lookup = (lo: number, hi: number): string => {
    if (hi - lo === 1) {
      const a = knots[lo]!;
      const b = knots[hi]!;
      const slope = (values[b]! - values[a]!) / (b - a);
      // perspective's input frame counter starts at one.
      return `${values[a]!.toFixed(9)}+clip(in-1-${a},0,${b - a})*${slope.toFixed(9)}`;
    }
    const mid = Math.floor((lo + hi) / 2);
    return `if(lt(in-1,${knots[mid]}),${lookup(lo, mid)},${lookup(mid, hi)})`;
  };
  return lookup(0, knots.length - 1);
}

/** Subpixel source warp; master supersamples at 2x before Lanczos downsampling. */
export function cameraFilter(frames: CameraFrame[], width: number, height: number, d: CameraDefaults): string {
  const factor = d.quality === "master" ? 2 : 1;
  const w = d.out_w * factor;
  const h = d.out_h * factor;
  const interpolation = d.quality === "draft" ? "linear" : "cubic";
  const x0 = frameExpr(frames.map((f) => f.x * w / width));
  const y0 = frameExpr(frames.map((f) => f.y * h / height));
  const x1 = frameExpr(frames.map((f) => (f.x + f.w) * w / width));
  const y1 = frameExpr(frames.map((f) => (f.y + f.h) * h / height));
  return `scale=${w}:${h}:flags=lanczos,perspective=x0='${x0}':y0='${y0}'`
    + `:x1='${x1}':y1='${y0}':x2='${x0}':y2='${y1}':x3='${x1}':y3='${y1}'`
    + `:sense=source:eval=frame:interpolation=${interpolation},scale=${d.out_w}:${d.out_h}:flags=lanczos,setsar=1`;
}

/** Run ffmpeg, resolve with its stderr, and include its final 20 stderr lines on failure. */
function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn("ffmpeg", ["-nostdin", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    process.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-100_000);
    });
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) {
        resolve(stderr);
        return;
      }
      const lastLines = stderr.split("\n").slice(-20).join("\n");
      reject(new Error(`ffmpeg exited ${code}\n${lastLines}`));
    });
  });
}

/** Read the take's durable inputs, write its camera path and render the silent MP4. */
export async function renderTake(
  dir: string,
  d?: CameraDefaults,
  options: { output?: string; lossless?: boolean } = {},
): Promise<{ out: string; seconds: number }> {
  const meta = JSON.parse(await readFile(join(dir, "take.json"), "utf8")) as TakeMeta;
  d ??= resolveTheme(meta.theme);
  validateEdits(meta);
  const beats = JSON.parse(await readFile(join(dir, "analysis/beats.json"), "utf8")) as Beat[];
  // The planner stores seconds; the existing FOLLOW solver consumes action timestamps in ms.
  if ("stream" in meta) for (const beat of beats) beat.actions = beat.actions.map((action) => {
    const a = action as { t?: number; t0?: number; t1?: number };
    return { ...a, ...(a.t === undefined ? {} : { t: a.t * 1000 }),
      ...(a.t0 === undefined ? {} : { t0: a.t0 * 1000 }),
      ...(a.t1 === undefined ? {} : { t1: a.t1 * 1000 }) };
  });
  const decisionLines = await readFile(join(dir, "analysis/decisions.jsonl"), "utf8");
  const decisions = decisionLines.split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line) as Decision);

  const trimEnd = meta.trim_end ?? Math.max(0, ...beats.map((beat) => beat.t1));
  const trimStart = meta.trim_start ?? 0;
  const cameraWarning = manualZoomLimitWarning(meta, d);
  if (cameraWarning) console.warn(cameraWarning);
  // Everything after this point runs on the output clock, with idle gaps squeezed.
  const squeezes = idleSqueezes(beats, trimStart, trimEnd, d);
  const edited = Boolean(meta.cuts?.length || meta.speed?.length);
  const clock = edited ? editTimeline(meta, beats, trimStart, trimEnd, d) : undefined;
  const outTime = clock?.at ?? ((t: number) => warp(t - trimStart, squeezes, d.idle_speed));
  const duration = outTime(trimEnd);
  const outBeats = clock ? editBeats(beats, clock, trimStart) : warpBeats(beats, trimStart, squeezes, d.idle_speed);
  const byId = new Map(outBeats.map(b => [b.id, b]));
  const sourceBeats = new Map(beats.map(b => [b.id, b]));
  const outDecisions = clock ? decisions.flatMap(decision => {
    const beat = byId.get(decision.beat);
    if (!beat) return [];
    const source = sourceBeats.get(decision.beat)!;
    const kept = (name: string | undefined) => source.zones.some(z => z.name === name
      && (z.t_change === undefined || clock.contains(z.t_change)));
    const A = kept(decision.A) ? decision.A : source.zones.find(z => kept(z.name))?.name ?? decision.A;
    const B = kept(decision.B) ? decision.B : A;
    return [{ ...decision, A, B }];
  }) : decisions;
  const zooms = clock ? editZooms(meta.zooms, clock, trimStart)
    : meta.zooms?.map(z => ({ ...z, t0: trimStart + outTime(z.t0), t1: trimStart + outTime(z.t1) }));
  const timing = { cuts: (meta.cuts ?? []).map(c => trimStart + outTime(c.t1)), arrivals: [] as import("../camera/solver.ts").CameraArrival[] };
  const frames = solveCamera(outBeats, outDecisions,
    { ...meta, zooms, trim_end: trimStart + duration },
    edited ? d : { ...d, min_shot: d.min_shot * d.pace, dwell: d.dwell * d.pace, dwell_k2: d.dwell_k2 * d.pace }, timing);
  await writeFile(join(dir, "camera-arrivals.json"), JSON.stringify(timing.arrivals, null, 2));
  for (const arrival of timing.arrivals) if (arrival.lateness > 1e-9) {
    console.warn(`Manual zoom requested at ${arrival.requested.toFixed(6)}s arrives at ${arrival.actualArrival.toFixed(6)}s (${arrival.lateness.toFixed(6)}s late): required lead ${arrival.requiredLead.toFixed(6)}s, boundary ${arrival.boundary.toFixed(6)}s; motion limits retained.`);
  }
  await writeFile(join(dir, "camera.json"), JSON.stringify(frames));
  const stage = stageGeometry(meta.width, meta.height, d);
  const commandFile = join(dir, "camera.cmd");
  const camera = cameraFilter(stageFrames(frames, meta.width, meta.height, stage, d), stage.w, stage.h, d);

  const outputDir = join(dir, "out");
  await mkdir(outputDir, { recursive: true });
  const id = meta.id ?? basename(dir);
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || id === "..") {
    throw new Error(`invalid take id: ${id}`);
  }
  const output = options.output ?? join(outputDir, `${id}.mp4`);
  await mkdir(dirname(output), { recursive: true });

  // Render intermediates live next to camera.cmd so a failed render can be rerun by hand.
  const stageFile = join(dir, "stage.png");
  const holesFile = join(dir, "stage-holes.png");
  await runFfmpeg(["-y", "-v", "error", ...(d.bg_style === "image" ? ["-i", resolveBackgroundImage(dir, d.background_image)] : []), "-filter_complex", stageImageFilter(meta.width, meta.height, stage, d),
    "-map", "[stage]", "-frames:v", "1", "-update", "1", stageFile,
    "-map", "[holes]", "-frames:v", "1", "-update", "1", holesFile]);
  const clicksFile = join(dir, "clicks.ass");
  const clicksAss = clickAss(beatClicks(outBeats), meta.width, meta.height, trimStart, stage, d);
  await writeFile(clicksFile, clicksAss);
  const captions = takeCaptions(clock ? { ...meta, captions: meta.captions?.filter(c => clock.contains(c.t)) } : meta, outTime, duration);
  const captionsFile = join(dir, "captions.ass");
  const captionsAss = captionAss(captions, await measureCaptions(dir, captions, d), d);
  await writeFile(captionsFile, captionsAss);

  const fade = Math.min(d.fade_s, duration / 4);
  const background = `0x${d.background_to.slice(1)}`;
  // Planar YUV throughout; the stills are decoded once and looped in-graph.
  const still = `loop=-1:1:0,trim=end=${duration}`;
  // An .ass with no Dialogue lines renders nothing, so skip its overlay:
  // stock ffmpeg builds without libass (e.g. Homebrew) have no ass filter.
  const clicksOverlay = hasDialogue(clicksAss) ? `,ass=${filterPath(clicksFile)}:fontsdir=${filterPath(FONTS_DIR)}` : "";
  const captionsOverlay = hasDialogue(captionsAss) ? `,ass=${filterPath(captionsFile)}:fontsdir=${filterPath(FONTS_DIR)}` : "";
  const filter = [
    `[0:v]${clock?.filter ?? `setpts='${setptsExpr(squeezes, d.idle_speed)}'`},fps=${d.fps}${clicksOverlay},scale=in_color_matrix=auto:out_color_matrix=bt601,format=yuv420p[screen]`,
    cardFilter(meta.width, meta.height, stage, d, still),
    `[c4]${camera}${captionsOverlay}`
      + (fade > 0 ? `,fade=t=in:st=0:d=${fade}:color=${background},fade=t=out:st=${duration - fade}:d=${fade}:color=${background}` : "")
      + `,scale=in_color_matrix=bt601:out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`,
  ].join(";");

  await writeFile(commandFile, filter);
  const crf = { draft: 23, standard: 18, master: 14 }[d.quality];

  const threads = String(Math.min(32, availableParallelism()));
  const ffmpegMajor = Number(execFileSync("ffmpeg", ["-version"], { encoding: "utf8" })
    .match(/ffmpeg version (?:n)?(\d+)/)?.[1] ?? 0);
  // ffmpeg 7 introduced file-valued options; older releases use the script flag.
  const graphOption = ffmpegMajor >= 7 ? "-/filter_complex" : "-filter_complex_script";

  // Keep camera.cmd on failure for straightforward diagnosis and re-rendering.
  const renderLog = await runFfmpeg([
    "-y", "-ss", String(trimStart), "-to", String(trimEnd),
    "-i", join(dir, "screen.webm"),
    "-framerate", String(d.fps), "-i", stageFile,
    "-framerate", String(d.fps), "-i", holesFile,
    // Slice threads keep the stage filters from starving the encoder.
    "-filter_threads", threads, "-filter_complex_threads", threads,
    graphOption, commandFile,
    ...(clock ? ["-t", String(duration)] : []),
    "-r", String(d.fps), "-an", "-c:v", "libx264",
    ...(options.lossless ? ["-qp", "0", "-preset", "ultrafast"] : ["-crf", String(crf), "-preset", d.preset]),
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
    "-movflags", "+faststart", output,
  ]);
  await writeFile(join(dir, "render.log"), renderLog);
  return { out: output, seconds: duration };
}

/** True when rendered .ass text carries at least one Dialogue event. */
function hasDialogue(assText: string): boolean {
  return assText.split("\n").some((line) => line.startsWith("Dialogue:"));
}

/** Escape a path for an option value inside an ffmpeg filter graph. */
function filterPath(path: string): string {
  const escapedOption = path.replace(/[\\:']/g, "\\$&");
  return escapedOption.replace(/[\\',;\[\]]/g, "\\$&");
}

/** Wrapped ink bounds of each caption, measured by rendering it with libass and cropdetect. */
async function measureCaptions(dir: string, captions: Caption[], d: CameraDefaults): Promise<CaptionInk[]> {
  if (captions.length === 0) return [];
  const file = join(dir, "measure.ass");
  await writeFile(file, measureAss(captions, d));
  const log = await runFfmpeg(["-hide_banner", "-f", "lavfi", "-i", `color=black:s=${d.out_w}x${d.out_h}:r=1:d=${captions.length}`,
    "-vf", `ass=${filterPath(file)}:fontsdir=${filterPath(FONTS_DIR)},format=gray,cropdetect=limit=0:round=2:reset=1:skip=0`, "-f", "null", "-"]);
  const widths = captions.map(() => ({ w: 0, h: 0 }));
  for (const match of log.matchAll(/x1:(-?\d+) x2:(-?\d+) y1:(-?\d+) y2:(-?\d+).*? t:(\d+(?:\.\d+)?)/g)) {
    const index = Math.round(Number(match[5]));
    if (index < widths.length) widths[index] = { w: Math.max(0, Number(match[2]) - Number(match[1]) + 1),
      h: Math.max(0, Number(match[4]) - Number(match[3]) + 1) };
  }
  return widths;
}

/** Bundled static OFL fonts; same directory in source and compiled builds. */
export const FONTS_DIR = fileURLToPath(new URL("../../resources/fonts/", import.meta.url));

function resolveBackgroundImage(dir: string, path: string): string {
  if (!path) throw new Error("bg_style=image requires background_image");
  // ffmpeg input protocol parsing must not turn a local path into a URL.
  return resolve(dir, path);
}
