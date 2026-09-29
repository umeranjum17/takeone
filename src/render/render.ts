import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DEFAULTS, type CameraDefaults } from "../camera/defaults.ts";
import { solveCamera } from "../camera/solver.ts";
import type { Beat, CameraFrame, Decision, TakeMeta } from "../camera/types.ts";
import { idleSqueezes, setptsExpr, warp, warpBeats } from "./pace.ts";
import {
  beatClicks, captionAss, cardFilter, clickAss, measureAss, stageFrames, stageGeometry, stageImageFilter, takeCaptions,
  type Caption,
} from "./stage.ts";

/** Encode one crop command per sampled camera frame for FFmpeg's crop filter. */
export function sendcmd(frames: CameraFrame[], offsetX = 0, offsetY = 0): string {
  return frames.map((frame) => {
    const t = frame.t.toFixed(6);
    const w = Math.round(frame.w);
    const h = Math.round(frame.h);
    const x = Math.round(frame.x + offsetX);
    const y = Math.round(frame.y + offsetY);
    return `${t} [enter] crop@a w ${w}, crop@a h ${h}, crop@a x ${x}, crop@a y ${y};`;
  }).join("\n") + "\n";
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
  await writeFile(commandFile, sendcmd(stageFrames(frames, meta.width, stage, d)));

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
  await writeFile(clicksFile, clickAss(beatClicks(outBeats), meta.width, meta.height, trimStart, stage, d));
  const captions = takeCaptions(meta, outTime, duration);
  const captionsFile = join(dir, "captions.ass");
  await writeFile(captionsFile, captionAss(captions, await measureCaptions(dir, captions, d), d));

  const fade = Math.min(d.fade_s, duration / 4);
  const background = `0x${d.background_to.slice(1)}`;
  // Planar YUV throughout; the stills are decoded once and looped in-graph.
  const still = `loop=-1:1:0,trim=end=${duration}`;
  const filter = [
    `[0:v]setpts='${setptsExpr(squeezes, d.idle_speed)}',ass=${filterPath(clicksFile)},format=yuv420p[screen]`,
    cardFilter(meta.width, meta.height, stage, d, still),
    `[c4]sendcmd=f=${filterPath(commandFile)},crop@a=w=iw:h=ih:x=0:y=0:exact=1,`
      + `setsar=1,scale=${d.out_w}:${d.out_h}:flags=lanczos,setsar=1,ass=${filterPath(captionsFile)}`
      + (fade > 0 ? `,fade=t=in:st=0:d=${fade}:color=${background},fade=t=out:st=${duration - fade}:d=${fade}:color=${background}` : "")
      + `,format=yuv420p`,
  ].join(";");

  // Keep camera.cmd on failure for straightforward diagnosis and re-rendering.
  await runFfmpeg([
    "-y", "-ss", String(trimStart), "-to", String(trimEnd),
    "-i", join(dir, "screen.webm"),
    "-framerate", String(d.fps), "-i", stageFile,
    "-framerate", String(d.fps), "-i", holesFile,
    // Slice threads keep the stage filters from starving the encoder.
    "-filter_complex_threads", "4", "-filter_complex", filter,
    "-r", String(d.fps), "-an", "-c:v", "libx264", "-crf", "18",
    "-preset", d.preset, "-movflags", "+faststart", output,
  ]);
  return { out: output, seconds: duration };
}

/** Escape a path for an option value inside an ffmpeg filter graph. */
function filterPath(path: string): string {
  const escapedOption = path.replace(/[\\:']/g, "\\$&");
  return escapedOption.replace(/[\\',;\[\]]/g, "\\$&");
}

/** Ink width of each caption, measured by rendering it with libass and cropdetect. */
async function measureCaptions(dir: string, captions: Caption[], d: CameraDefaults): Promise<number[]> {
  if (captions.length === 0) return [];
  const file = join(dir, "measure.ass");
  await writeFile(file, measureAss(captions, d));
  const log = await runFfmpeg(["-hide_banner", "-f", "lavfi", "-i", `color=black:s=${d.out_w}x200:r=1:d=${captions.length}`,
    "-vf", `ass=${filterPath(file)},format=gray,cropdetect=limit=0:round=2:reset=1:skip=0`, "-f", "null", "-"]);
  const widths = captions.map(() => 0);
  for (const match of log.matchAll(/x1:(-?\d+) x2:(-?\d+).*? t:(\d+(?:\.\d+)?)/g)) {
    const index = Math.round(Number(match[3]));
    if (index < widths.length) widths[index] = Math.max(0, Number(match[2]) - Number(match[1]) + 1);
  }
  return widths;
}
