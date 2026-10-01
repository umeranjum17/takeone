import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";
import { DEFAULTS, type CameraDefaults } from "../camera/defaults.ts";
import { solveCamera } from "../camera/solver.ts";
import type { Beat, Decision, TakeMeta } from "../camera/types.ts";
export { cameraFilter } from "./camera-filter.ts";
import { motionBlurGraph, shutterPlan } from "./motion-blur.ts";
import { idleSqueezes, setptsExpr, warp, warpBeats } from "./pace.ts";
import {
  beatClicks, captionAss, cardFilter, clickAss, measureAss, stageFrames, stageGeometry, stageImageFilter, takeCaptions,
  type Caption, type CaptionInk,
} from "./stage.ts";

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
export async function renderTake(dir: string, d: CameraDefaults = DEFAULTS): Promise<{ out: string; seconds: number }> {
  const meta = JSON.parse(await readFile(join(dir, "take.json"), "utf8")) as TakeMeta;
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
  // Everything after this point runs on the output clock, with idle gaps squeezed.
  const squeezes = idleSqueezes(beats, trimStart, trimEnd, d);
  const outTime = (t: number) => warp(t - trimStart, squeezes, d.idle_speed);
  const duration = outTime(trimEnd);
  const outBeats = warpBeats(beats, trimStart, squeezes, d.idle_speed);
  const frames = solveCamera(outBeats, decisions, { ...meta, trim_end: trimStart + duration }, d);
  await writeFile(join(dir, "camera.json"), JSON.stringify(frames));
  const stage = stageGeometry(meta.width, meta.height, d);
  const commandFile = join(dir, "camera.cmd");
  const staged = stageFrames(frames, meta.width, meta.height, stage, d);
  const shutter = shutterPlan(staged, stage.w, stage.h, d);
  await writeFile(join(dir, "motion-blur.json"), JSON.stringify(shutter.metrics, null, 2));
  const camera = motionBlurGraph(staged, shutter, stage.w, stage.h, d);

  const outputDir = join(dir, "out");
  await mkdir(outputDir, { recursive: true });
  const id = meta.id ?? basename(dir);
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || id === "..") {
    throw new Error(`invalid take id: ${id}`);
  }
  const output = join(outputDir, `${id}.mp4`);

  // Render intermediates live next to camera.cmd so a failed render can be rerun by hand.
  const stageFile = join(dir, "stage.png");
  const holesFile = join(dir, "stage-holes.png");
  await runFfmpeg(["-y", "-v", "error", "-filter_complex", stageImageFilter(meta.width, meta.height, stage, d),
    "-map", "[stage]", "-frames:v", "1", "-update", "1", stageFile,
    "-map", "[holes]", "-frames:v", "1", "-update", "1", holesFile]);
  const clicksFile = join(dir, "clicks.ass");
  const clicksAss = clickAss(beatClicks(outBeats), meta.width, meta.height, trimStart, stage, d);
  await writeFile(clicksFile, clicksAss);
  const captions = takeCaptions(meta, outTime, duration);
  const captionsFile = join(dir, "captions.ass");
  const captionsAss = captionAss(captions, await measureCaptions(dir, captions, d), d);
  await writeFile(captionsFile, captionsAss);

  const fade = Math.min(d.fade_s, duration / 4);
  const background = `0x${d.background_to.slice(1)}`;
  // Planar YUV throughout; the stills are decoded once and looped in-graph.
  const still = `loop=-1:1:0,trim=end=${duration}`;
  // An .ass with no Dialogue lines renders nothing, so skip its overlay:
  // stock ffmpeg builds without libass (e.g. Homebrew) have no ass filter.
  const clicksOverlay = hasDialogue(clicksAss) ? `,ass=${filterPath(clicksFile)}` : "";
  const captionsOverlay = hasDialogue(captionsAss) ? `,ass=${filterPath(captionsFile)}` : "";
  const filter = [
    `[0:v]setpts='${setptsExpr(squeezes, d.idle_speed)}',fps=${d.fps}${clicksOverlay},scale=in_color_matrix=auto:out_color_matrix=bt601,format=yuv420p[screen]`,
    cardFilter(meta.width, meta.height, stage, d, still),
    `${camera};[camera]trim=end=${duration}${captionsOverlay}`
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
  await runFfmpeg([
    "-y", "-ss", String(trimStart), "-to", String(trimEnd),
    "-i", join(dir, "screen.webm"),
    "-framerate", String(d.fps), "-i", stageFile,
    "-framerate", String(d.fps), "-i", holesFile,
    // Slice threads keep the stage filters from starving the encoder.
    "-filter_threads", threads, "-filter_complex_threads", threads,
    graphOption, commandFile,
    "-r", String(d.fps), "-an", "-c:v", "libx264", "-crf", String(crf),
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
    "-preset", d.preset, "-movflags", "+faststart", output,
  ]);
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
    "-vf", `ass=${filterPath(file)},format=gray,cropdetect=limit=0:round=2:reset=1:skip=0`, "-f", "null", "-"]);
  const widths = captions.map(() => ({ w: 0, h: 0 }));
  for (const match of log.matchAll(/x1:(-?\d+) x2:(-?\d+) y1:(-?\d+) y2:(-?\d+).*? t:(\d+(?:\.\d+)?)/g)) {
    const index = Math.round(Number(match[5]));
    if (index < widths.length) widths[index] = { w: Math.max(0, Number(match[2]) - Number(match[1]) + 1),
      h: Math.max(0, Number(match[4]) - Number(match[3]) + 1) };
  }
  return widths;
}
