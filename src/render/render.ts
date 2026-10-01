import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveTheme } from "../themes.ts";
import { basename, join, resolve } from "node:path";
import type { CameraDefaults } from "../camera/defaults.ts";
import { solveCamera } from "../camera/solver.ts";
import type { Beat, CameraFrame, Decision, TakeMeta } from "../camera/types.ts";
import { blurGraph, keycapAss, keycapObstacles, overlayRegions, spotlightAss } from "./overlays.ts";
import { frameExpr } from "./camera-filter.ts";
import { shutterFrame, shutterPlan } from "./motion-blur.ts";
import { idleSqueezes, setptsExpr, warp, warpBeats } from "./pace.ts";
import { phoneTapShots } from "./phone.ts";
import {
  beatClicks, captionAss, cardFilter, clickAss, measureAss, stageFrames, stageGeometry, stageImageFilter, takeCaptions,
  type Caption, type CaptionInk,
} from "./stage.ts";

/** A flat-to-flat transform is an affine crop: no rotation or lens distortion.
 * v360 samples the native stage directly into export pixels with Lanczos.
 * RGB16 preserves fractional colour/edge precision until the final conversion.
 * Its normalized coordinates use (input size - 1) and output pixel centres.
 */
export function cameraFilter(frames: CameraFrame[], width: number, height: number, d: CameraDefaults): string {
  const degrees = (range: number) => 2 * Math.atan(range) * 180 / Math.PI;
  const parameters = (f: CameraFrame) => ({
    h_fov: degrees(f.w / (width - 1)),
    v_fov: degrees(f.h / (height - 1)),
    h_offset: 2 * (f.x + f.w / 2 - 0.5) / (width - 1) - 1,
    v_offset: 2 * (f.y + f.h / 2 - 0.5) / (height - 1) - 1,
  });
  const first = frames[0];
  if (!first || width < 2 || height < 2) throw new Error("invalid camera surface");
  const initial = parameters(first);
  let previous = first;
  const commands: string[] = [];
  for (const f of frames.slice(1)) {
    // Ignore only sub-millipixel spring tails; no whole-pixel camera quantization.
    const error = Math.max(Math.abs(f.x - previous.x), Math.abs(f.y - previous.y),
      Math.abs(f.w - previous.w), Math.abs(f.h - previous.h)) * d.out_w / f.w;
    if (error < 0.001) continue;
    const values = parameters(f);
    const updates = Object.entries(values).map(([key, value]) => `v360 ${key} ${value.toFixed(10)}`).join(",");
    // Put updates between frame timestamps so decimal rounding cannot delay a move by one frame.
    commands.push(`${Math.max(0, f.t - 0.5 / d.fps).toFixed(9)} ${updates}`);
    previous = f;
  }
  const control = commands.length ? `sendcmd=commands='${commands.join(";")};',` : "";
  const settings = Object.entries(initial).map(([key, value]) => `${key}=${value.toFixed(10)}`).join(":");
  // Lanczos normalizes its kernel coefficients, preserving flat card colours.
  return `format=gbrp16le,${control}v360=input=flat:output=flat:w=${d.out_w}:h=${d.out_h}:ih_fov=90:iv_fov=90:${settings}`
    + `:interp=${d.quality === "draft" ? "linear" : "lanczos"},setsar=1`;
}

/** Duplicate source images by reference, discard unneeded samples before the
 * warp, and average only each exposure's samples. One chronological stream
 * avoids buffering whole shots across parallel velocity branches.
 */
function motionBlurGraph(frames: CameraFrame[], plan: ReturnType<typeof shutterPlan>, width: number, height: number, d: CameraDefaults): string {
  if (!plan.metrics.blurredFrames) return `[c4]${cameraFilter(frames, width, height, d)}[camera]`;
  const counts = frames.map(() => 1);
  for (const [count, indices] of plan.groups) for (const i of indices) counts[i] = count;
  const sampled: CameraFrame[] = [];
  const ends: number[] = [];
  const commands: string[] = [];
  let previous = 0;
  for (let i = 0; i < frames.length; i++) {
    const count = counts[i]!;
    if (count !== previous) {
      // tmix stores oldest first. Keep one extra zero-weight slot so its
      // equal-weight running-sum shortcut cannot reuse skipped-frame sums.
      // Zero every sample from earlier exposures.
      const weights = Array.from({ length: plan.samples + 1 }, (_, j) => j < plan.samples + 1 - count ? 0 : 1).join("|");
      commands.push(`${(Math.max(0, sampled.length - 0.5) / (d.fps * plan.samples)).toFixed(9)} tmix@shutter weights ${weights}`);
      previous = count;
    }
    for (let j = 0; j < count; j++) {
      sampled.push(count === 1 ? frames[i]! : shutterFrame(frames, i - plan.half + 2 * plan.half * j / (count - 1)));
      ends.push(j === count - 1 ? 1 : 0);
    }
  }
  const countExpr = frameExpr(counts).replaceAll("in-1", `floor(n/${plan.samples})`);
  const endExpr = `eq(round(${frameExpr(ends).replaceAll("in-1", "n")}),1)`;
  return `[c4]fps=${d.fps * plan.samples}:round=up:start_time=0,tpad=stop_mode=clone:stop=${plan.samples},`
    + `trim=end_frame=${frames.length * plan.samples},select='lt(mod(n,${plan.samples}),round(${countExpr}))',`
    + `setpts=N/(${d.fps * plan.samples}*TB),${cameraFilter(sampled.map((f, i) => ({ ...f, t: i / (d.fps * plan.samples) })), width, height, { ...d, fps: d.fps * plan.samples })},`
    + `sendcmd=c='${commands.join(";")}',tmix@shutter=frames=${plan.samples + 1}:enable='${endExpr}',`
    + `select='${endExpr}',settb=AVTB,setpts=N/(${d.fps}*TB)[camera]`;
}

/** Text-friendly production encoder settings, also exercised by the output gate. */
export function encodingOptions(d: CameraDefaults): string[] {
  return ["-c:v", "libx264", "-crf", String({ draft: 23, standard: 12, master: 12 }[d.quality]),
    "-preset", d.preset, "-pix_fmt", d.quality === "master" ? "yuv444p" : "yuv420p",
    ...(d.quality === "draft" ? [] : ["-tune", "animation"])];
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
export async function renderTake(dir: string, d?: CameraDefaults): Promise<{ out: string; seconds: number }> {
  const meta = JSON.parse(await readFile(join(dir, "take.json"), "utf8")) as TakeMeta;
  d ??= resolveTheme(meta.theme);
  const phone = meta.device !== undefined && meta.height > meta.width;
  if (phone) d = { ...d, corner_radius: 36, stage_margin: Math.max(0.16, d.stage_margin) };
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
  const blurs = overlayRegions(meta, "blur", outTime, trimStart, trimEnd);
  const spotlights = overlayRegions(meta, "spotlight", outTime, trimStart, trimEnd);
  const outBeats = warpBeats(beats, trimStart, squeezes, d.idle_speed);
  const tapShots = meta.device === "android" ? phoneTapShots(outBeats, meta.width, meta.height) : null;
  const solved = solveCamera(tapShots?.beats ?? outBeats, tapShots?.decisions ?? decisions, { ...meta, trim_end: trimStart + duration },
    { ...d, min_shot: d.min_shot * d.pace, dwell: d.dwell * d.pace, dwell_k2: d.dwell_k2 * d.pace });
  // A handset's controls span its narrow screen. Keep that entire width while
  // pushing in and following the tapped row; horizontal pans slice labels.
  const frames = phone ? solved.map(f => {
    const w = Math.max(f.w, meta.width * d.hold_pad);
    const h = w * d.out_h / d.out_w;
    const cy = f.y + f.h / 2;
    const y = h >= meta.height ? (meta.height - h) / 2
      : Math.max(0, Math.min(meta.height - h, cy - h / 2));
    return { t: f.t, x: (meta.width - w) / 2, y, w, h };
  }) : solved;
  await writeFile(join(dir, "camera.json"), JSON.stringify(frames));
  const stage = stageGeometry(meta.width, meta.height, d);
  const commandFile = join(dir, "camera.cmd");
  const stageCamera = stageFrames(frames, meta.width, meta.height, stage, d);
  const shutter = shutterPlan(stageCamera, stage.w, stage.h, d);
  await writeFile(join(dir, "motion-blur.json"), JSON.stringify(shutter.metrics, null, 2));
  const camera = motionBlurGraph(stageCamera, shutter, stage.w, stage.h, d);

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
  await runFfmpeg(["-y", "-v", "error", ...(d.bg_style === "image" ? ["-i", resolveBackgroundImage(dir, d.background_image)] : []), "-filter_complex", stageImageFilter(meta.width, meta.height, stage, d, phone),
    "-map", "[stage]", "-frames:v", "1", "-update", "1", stageFile,
    "-map", "[holes]", "-frames:v", "1", "-update", "1", holesFile]);
  const clicksFile = join(dir, "clicks.ass");
  const clicksAss = clickAss(beatClicks(outBeats), meta.width, meta.height, trimStart, stage, d);
  await writeFile(clicksFile, clicksAss);
  const captions = takeCaptions(meta, outTime, duration);
  const captionsFile = join(dir, "captions.ass");
  const captionInk = await measureCaptions(dir, captions, d);
  const widePhone = phone && d.out_w > d.out_h;
  const captionsAss = captionAss(captions, captionInk, d, widePhone);
  await writeFile(captionsFile, captionsAss);

  const keysFile = join(dir, "keycaps.ass");
  const keys = keycapAss(outBeats, trimStart, duration, d,
    keycapObstacles(outBeats, decisions, stageCamera, stage, trimStart, captions, captionInk, d, widePhone));
  await writeFile(keysFile, keys);
  const spotlightFile = join(dir, "spotlight.ass");
  const spotlight = spotlightAss(spotlights, meta.width, meta.height, d);
  await writeFile(spotlightFile, spotlight);
  const keysOverlay = hasDialogue(keys) ? `,ass=${filterPath(keysFile)}` : "";
  const spotlightOverlay = hasDialogue(spotlight) ? `,ass=${filterPath(spotlightFile)}` : "";

  const fade = Math.min(d.fade_s, duration / 4);
  const background = `0x${d.background_to.slice(1)}`;
  // Planar YUV composition; blur patches briefly use RGB. Stills are decoded once.
  const still = `loop=-1:1:0,trim=end=${duration}`;
  // An .ass with no Dialogue lines renders nothing, so skip its overlay:
  // stock ffmpeg builds without libass (e.g. Homebrew) have no ass filter.
  const pixelFormat = d.quality === "master" ? "yuv444p" : "yuv420p";
  const clicksOverlay = hasDialogue(clicksAss) ? `,ass=${filterPath(clicksFile)}:fontsdir=${filterPath(FONTS_DIR)}` : "";
  const captionsOverlay = hasDialogue(captionsAss) ? `,ass=${filterPath(captionsFile)}:fontsdir=${filterPath(FONTS_DIR)}` : "";
  const filter = [
    `[0:v]setpts='${setptsExpr(squeezes, d.idle_speed)}',fps=${d.fps}${clicksOverlay},scale=in_color_matrix=auto:out_color_matrix=bt601,format=${pixelFormat}[region0]`,
    ...(blurs.length ? [blurGraph(blurs)] : []),
    `[region${blurs.length}]null${spotlightOverlay}[screen]`,
    cardFilter(meta.width, meta.height, stage, d, still),
    `${camera};[camera]trim=end=${duration}${captionsOverlay}${keysOverlay}`
      + (fade > 0 ? `,fade=t=in:st=0:d=${fade}:color=${background},fade=t=out:st=${duration - fade}:d=${fade}:color=${background}` : "")
      + `,scale=in_color_matrix=bt601:out_color_matrix=bt709:out_range=tv,format=${pixelFormat},setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`,
  ].join(";");

  await writeFile(commandFile, filter);

  const threads = String(Math.min(8, availableParallelism()));
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
    "-r", String(d.fps), "-an", ...encodingOptions(d),
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
