import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveTheme } from "../themes.ts";
import { basename, join, resolve } from "node:path";
import type { CameraDefaults } from "../camera/defaults.ts";
import { actionCameraMilliseconds } from "../beats/clock.ts";
import { solveCamera } from "../camera/solver.ts";
import type { Beat, Decision, TakeMeta } from "../camera/types.ts";
import { blurGraph, keycapAss, keycapBackdropGraph, keycapMaskAss, keycapObstacles, overlayRegions, spotlightAss, spotlightGraph } from "./overlays.ts";
import { motionBlurGraph, shutterPlan } from "./motion-blur.ts";
import { idleSqueezes, setptsExpr, warp, warpBeats } from "./pace.ts";
import { phoneTapShots } from "./phone.ts";
import {
  bandEligible, bandFrames, bandLayout, bandText, beatClicks, captionAss, cardFilter, clickAss, measureAss, stageFrames, stageGeometry, stageImageFilter,
  takeCaptions, type Caption, type CaptionInk,
} from "./stage.ts";

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
  if ("stream" in meta) for (const beat of beats) beat.actions = beat.actions.map(actionCameraMilliseconds);
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
  const captions = takeCaptions(meta, outTime, duration);
  const banded = captions.length > 0 && bandEligible(meta.width, meta.height, d);
  let text = banded ? bandText(captions, [], d) : d;
  let captionInk = await measureCaptions(dir, captions, text, banded);
  const fitted = banded ? bandText(captions, captionInk, text) : text;
  if (fitted !== text) captionInk = await measureCaptions(dir, captions, fitted, banded);
  text = fitted;
  const band = banded ? bandLayout(meta.width, meta.height, text, captions, captionInk) : null;
  const stage = band?.stage ?? stageGeometry(meta.width, meta.height, d);
  const commandFile = join(dir, "camera.cmd");
  // With a band the camera frames the screen alone, into the fixed card.
  const stageCamera = band ? bandFrames(frames, band, d) : stageFrames(frames, meta.width, meta.height, stage, d);
  const view = band ? { ...d, out_w: stage.baseW, out_h: stage.baseH } : d;
  const [cameraFrames, cameraW, cameraH] = band ? [frames, meta.width, meta.height] : [stageCamera, stage.w, stage.h];
  const shutter = shutterPlan(cameraFrames, cameraW, cameraH, view);
  await writeFile(join(dir, "motion-blur.json"), JSON.stringify(shutter.metrics, null, 2));
  const camera = motionBlurGraph(cameraFrames, shutter, cameraW, cameraH, view);

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
  await runFfmpeg(["-y", "-v", "error", ...(d.bg_style === "image" ? ["-i", resolveBackgroundImage(dir, d.background_image)] : []), "-filter_complex", stageImageFilter(band ? stage.baseW : meta.width, band ? stage.baseH : meta.height, stage, d, phone),
    "-map", "[stage]", "-frames:v", "1", "-update", "1", stageFile,
    "-map", "[holes]", "-frames:v", "1", "-update", "1", holesFile]);
  const clicksFile = join(dir, "clicks.ass");
  const clicksAss = clickAss(beatClicks(outBeats), meta.width, meta.height, trimStart,
    band ? { ...stage, restScale: stage.baseW / meta.width } : stage, d);
  await writeFile(clicksFile, clicksAss);
  const captionsFile = join(dir, "captions.ass");
  const widePhone = phone && d.out_w > d.out_h;
  const captionsAss = captionAss(captions, captionInk, text, widePhone, band);
  await writeFile(captionsFile, captionsAss);

  const keysFile = join(dir, "keycaps.ass");
  const keyObstacles = keycapObstacles(outBeats, decisions, stageCamera,
    band ? { ...stage, screenX: 0, screenY: 0 } : stage,
    trimStart, captions, captionInk, text, widePhone, band, [...spotlights, ...blurs]);
  const keys = keycapAss(outBeats, trimStart, duration, d, keyObstacles);
  const keyMaskFile = join(dir, "keycaps-mask.ass");
  await writeFile(keyMaskFile, keycapMaskAss(outBeats, trimStart, duration, d, keyObstacles));
  await writeFile(keysFile, keys);
  const spotlightFile = join(dir, "spotlight.ass");
  const spotlight = spotlightAss(spotlights, meta.width, meta.height, d, { frames: stageCamera, stage: band ? { ...stage, screenX: 0, screenY: 0 } : stage });
  await writeFile(spotlightFile, spotlight);
  const keysOverlay = hasDialogue(keys) ? `,ass=${filterPath(keysFile)}:fontsdir=${filterPath(FONTS_DIR)}` : "";

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
    ...(blurs.length ? [blurGraph(blurs, pixelFormat)] : []),
    ...(spotlights.length ? [
      `[region${blurs.length}]null[spotlightInput]`,
      spotlightGraph(spotlights, meta.width, meta.height, duration, d, filterPath(spotlightFile))
        .replace(/\[screen\]$/, band ? "[raw]" : "[screen]"),
    ] : [`[region${blurs.length}]null${band ? "[raw]" : "[screen]"}`]),
    ...(band ? [
      `${camera.replace(/^\[c4\]/, "[raw]")};[camera]null[screen]`,
      cardFilter(stage.baseW, stage.baseH, stage, d, still),
      `[c4]trim=end=${duration}[composed]`,
    ] : [
      cardFilter(meta.width, meta.height, stage, d, still),
      `${camera};[camera]trim=end=${duration}[composed]`,
    ]),
    ...(hasDialogue(keys) ? [
      `[composed]null[keycapInput]`,
      keycapBackdropGraph(duration, d, filterPath(keyMaskFile)),
    ] : []),
    `${hasDialogue(keys) ? "[keycapOutput]" : "[composed]"}null${captionsOverlay}${keysOverlay}`
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

/** Libass ink bounds: band captions use complete single lines; titles and legacy overlays use wrapping. */
export async function measureCaptions(dir: string, captions: Caption[], d: CameraDefaults, band: boolean): Promise<CaptionInk[]> {
  if (captions.length === 0) return [];
  const file = join(dir, "measure.ass");
  const widths = captions.map(() => ({ w: 0, h: 0 }));
  const wrapped = captions.flatMap((c, i) => band && !c.title ? [] : [i]);
  const groups = [wrapped, ...captions.flatMap((c, i) => band && !c.title ? [[i]] : [])].filter(g => g.length);
  for (const indices of groups) {
    const first = captions[indices[0]!]!;
    const fullWidth = Array.from(first.text).length * d.caption_size * 4;
    const scale = band && !first.title ? Math.max(0.01, Math.min(1, Math.floor(32000 / Math.max(1, fullWidth) * 100) / 100)) : 1;
    const measurement = band && !first.title ? { ...d,
      out_w: Math.ceil((d.out_w + fullWidth * scale) / 2) * 2,
      out_h: Math.ceil(d.caption_size * 4 / 2) * 2,
    } : d;
    await writeFile(file, measureAss(indices.map(i => captions[i]!), measurement, band, scale * 100));
    const log = await runFfmpeg(["-hide_banner", "-f", "lavfi", "-i", `color=black:s=${measurement.out_w}x${measurement.out_h}:r=1:d=${indices.length}`,
      "-vf", `ass=${filterPath(file)}:fontsdir=${filterPath(FONTS_DIR)},format=gray,cropdetect=limit=0:round=2:reset=1:skip=0`, "-f", "null", "-"]);
    for (const match of log.matchAll(/x1:(-?\d+) x2:(-?\d+) y1:(-?\d+) y2:(-?\d+).*? t:(\d+(?:\.\d+)?)/g)) {
      const index = indices[Math.round(Number(match[5]))];
      if (index !== undefined) widths[index] = { w: Math.max(0, Number(match[2]) - Number(match[1]) + 1 + (scale < 1 ? 2 : 0)) / scale,
        h: Math.max(0, Number(match[4]) - Number(match[3]) + 1) };
    }
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
