import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DEFAULTS, type CameraDefaults } from "../camera/defaults.ts";
import { solveCamera } from "../camera/solver.ts";
import type { Beat, CameraFrame, Decision, TakeMeta } from "../camera/types.ts";

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

/** Run ffmpeg and include its final 20 stderr lines on failure. */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    process.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-10_000);
    });
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const lastLines = stderr.split("\n").slice(-20).join("\n");
      reject(new Error(`ffmpeg exited ${code}\n${lastLines}`));
    });
  });
}

/** Read the take's durable inputs, write its camera path and render the silent MP4. */
export async function renderTake(dir: string, d: CameraDefaults = DEFAULTS): Promise<string> {
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
  const frames = solveCamera(beats, decisions, { ...meta, trim_end: trimEnd }, d);
  await writeFile(join(dir, "camera.json"), JSON.stringify(frames));
  const commandFile = join(dir, "camera.cmd");
  const aspect = d.out_w / d.out_h;
  const canvasW = Math.ceil(Math.max(meta.width, meta.height * aspect) / 2) * 2;
  const canvasH = Math.ceil(Math.max(meta.height, meta.width / aspect) / 2) * 2;
  const offsetX = Math.round((canvasW - meta.width) / 2);
  const offsetY = Math.round((canvasH - meta.height) / 2);
  await writeFile(commandFile, sendcmd(frames, offsetX, offsetY));

  const outputDir = join(dir, "out");
  await mkdir(outputDir, { recursive: true });
  const id = meta.id ?? basename(dir);
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || id === "..") {
    throw new Error(`invalid take id: ${id}`);
  }
  const output = join(outputDir, `${id}.mp4`);
  const trimStart = meta.trim_start ?? 0;
  const escapedOption = commandFile.replace(/[\\:']/g, "\\$&");
  const escapedPath = escapedOption.replace(/[\\',;\[\]]/g, "\\$&");
  const filter = `pad=${canvasW}:${canvasH}:${offsetX}:${offsetY}:color=${d.background},sendcmd=f=${escapedPath},crop@a=w=iw:h=ih:x=0:y=0:exact=1,scale=${d.out_w}:${d.out_h}:flags=lanczos,format=yuv420p`;

  // Keep camera.cmd on failure for straightforward diagnosis and re-rendering.
  await runFfmpeg([
    "-y", "-ss", String(trimStart), "-to", String(trimEnd),
    "-i", join(dir, "screen.webm"),
    "-vf", filter,
    "-r", String(d.fps), "-an", "-c:v", "libx264", "-crf", "18",
    "-preset", d.preset, "-movflags", "+faststart", output,
  ]);
  return output;
}
