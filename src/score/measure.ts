import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CameraDefaults } from "../camera/defaults.ts";
import type { CameraFrame, TakeMeta } from "../camera/types.ts";
import { baseWidth } from "../camera/solver.ts";
import { actionCameraMilliseconds } from "../beats/clock.ts";
import { idleSqueezes, purposefulEnd, warp } from "../render/pace.ts";
import { runFfmpeg } from "../render/ffmpeg.ts";
import { stageGeometry } from "../render/stage.ts";
import { DETERMINISM_TOLERANCE, type BaselineFacts, type MeasuredFacts } from "./rubric.ts";
import type { BaselineMeasure, Determinism } from "./loop.ts";

interface SavedAction { k?: string; t?: number; t0?: number; t1?: number }
interface SavedBeat { id: string; t0: number; t1: number; actions?: SavedAction[]; zones?: { type: string; bbox: [number, number, number, number] }[] }

/** Beats on the pacing clock: a recorded take saves action times in seconds, and the pacing reads them in ms as render does. */
export function pacedBeats(meta: TakeMeta, beats: unknown[]): never[] {
  if (!("stream" in meta)) return beats as never[];
  return (beats as SavedBeat[]).map((b) => ({ ...b, actions: b.actions?.map(actionCameraMilliseconds) })) as never[];
}

function overlap([x, y, w, h]: [number, number, number, number], f: CameraFrame): number {
  return Math.max(0, Math.min(x + w, f.x + f.w) - Math.max(x, f.x)) * Math.max(0, Math.min(y + h, f.y + f.h) - Math.max(y, f.y));
}

export function frameHashes(file: string): string[] {
  const out = execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-i", file, "-map", "0:v:0", "-f", "framemd5", "-"], {
    maxBuffer: 128 * 1024 * 1024,
  }).toString();
  return out.split("\n").filter((line) => line && !line.startsWith("#")).map((line) => line.split(",").at(-1)!.trim());
}

export function compareFrames(a: string[], b: string[]): Determinism {
  const n = Math.max(a.length, b.length);
  let identical = 0;
  for (let i = 0; i < n; i++) if (a[i] !== undefined && a[i] === b[i]) identical++;
  return { frames: n, identical, tolerance: DETERMINISM_TOLERANCE };
}

export function probeDuration(file: string): number {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { encoding: "utf8" }).trim();
  const n = Number(out);
  if (!Number.isFinite(n)) throw new Error(`${file}: ffprobe returned no duration`);
  return n;
}

export function pointerCount(dir: string): number {
  const path = join(dir, "events.jsonl");
  if (!existsSync(path)) return 0;
  let n = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let event: { k?: unknown };
    try {
      event = JSON.parse(line) as { k?: unknown };
    } catch {
      continue;
    }
    if (event.k === "ptr") n++;
  }
  return n;
}

export function hasDialogue(path: string): boolean {
  return existsSync(path) && readFileSync(path, "utf8").includes("Dialogue:");
}

function clickActions(beats: SavedBeat[]): SavedAction[] {
  return beats.flatMap((beat) => (beat.actions ?? []).filter((a) => a.k === "click" && typeof a.t === "number"));
}

function actionTimes(meta: TakeMeta, beats: SavedBeat[], trimStart: number, trimEnd: number, camera: CameraDefaults): number[] {
  const squeezes = idleSqueezes(pacedBeats(meta, beats), trimStart, trimEnd, camera);
  const at = (t: number) => warp(Math.max(0, t - trimStart), squeezes, camera.idle_speed);
  const end = at(trimEnd);
  const times = [0, end];
  for (const beat of beats) {
    for (const action of beat.actions ?? []) {
      // A resting pointer is the dead air pacing measures, as in the warp's own activity.
      if (action.k === "dwell" || action.k === "ptr") continue;
      for (const t of [action.t, action.t0, action.t1]) if (typeof t === "number") times.push(Math.min(end, at(t)));
    }
  }
  return [...new Set(times.map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b);
}

/** The longest actionless span of the film this camera renders: its length and its start, in output seconds. */
export function longestHoldFor(dir: string, meta: TakeMeta, camera: CameraDefaults): { span: number; at: number } {
  const beats = JSON.parse(readFileSync(join(dir, "analysis/beats.json"), "utf8")) as SavedBeat[];
  const trimStart = meta.trim_start ?? 0;
  const trimEnd = meta.trim_end ?? purposefulEnd(pacedBeats(meta, beats), trimStart, meta.duration ?? Math.max(0, ...beats.map((b) => b.t1)), camera);
  const times = actionTimes(meta, beats, trimStart, trimEnd, camera);
  let longest = { span: 0, at: 0 };
  for (let i = 1; i < times.length; i++) if (times[i]! - times[i - 1]! > longest.span) longest = { span: times[i]! - times[i - 1]!, at: times[i - 1]! };
  return longest;
}

async function extract(film: string, t: number, path: string): Promise<void> {
  await runFfmpeg(["-y", "-v", "error", "-ss", Math.max(0, t).toFixed(3), "-i", film, "-frames:v", "1", "-update", "1", path]);
}

export interface MeasureOptions {
  dir: string;
  camera: CameraDefaults;
  frameDir: string;
  baseline?: BaselineMeasure;
}

export async function measureFilm(
  film: string,
  round: number,
  determinism: Determinism,
  o: MeasureOptions,
): Promise<MeasuredFacts> {
  const meta = JSON.parse(readFileSync(join(o.dir, "take.json"), "utf8")) as TakeMeta & { duration_ms?: number; width: number; height: number };
  const beats = JSON.parse(readFileSync(join(o.dir, "analysis/beats.json"), "utf8")) as SavedBeat[];
  const cameraFrames = JSON.parse(readFileSync(join(o.dir, "camera.json"), "utf8")) as CameraFrame[];
  const camera = o.camera;
  const duration = probeDuration(film);
  const trimStart = meta.trim_start ?? 0;
  const trimEnd = meta.trim_end ?? purposefulEnd(pacedBeats(meta, beats), trimStart, meta.duration ?? Math.max(0, ...beats.map((b) => b.t1)), camera);
  const squeezes = idleSqueezes(pacedBeats(meta, beats), trimStart, trimEnd, camera);
  const hold = longestHoldFor(o.dir, meta, camera);
  const clicks = clickActions(beats);
  const click = clicks[0];
  const clickOut = click?.t === undefined ? undefined : warp(Math.max(0, click.t - trimStart), squeezes, camera.idle_speed);
  const nearest = clickOut === undefined || cameraFrames.length === 0
    ? undefined
    : cameraFrames.reduce((best, f) => Math.abs(f.t - clickOut) < Math.abs(best.t - clickOut) ? f : best);
  const restWidth = baseWidth(meta.width, meta.height, camera);
  const zoomAtClick = nearest ? restWidth / nearest.w : 0;
  // How much of what the click changed the last frame shows: a push-in that ends on the control alone hides its payoff.
  const result = beats.find((b) => b.actions?.includes(click!))?.zones?.filter((z) => z.type === "res")
    .sort((a, b) => b.bbox[2] * b.bbox[3] - a.bbox[2] * a.bbox[3])[0];
  const last = cameraFrames.at(-1);
  const resultInFrame = result && last ? overlap(result.bbox, last) / (result.bbox[2] * result.bbox[3]) : undefined;
  const stage = stageGeometry(meta.width, meta.height, camera);
  const widthShare = (stage.baseW * stage.restScale) / camera.out_w;
  const heightShare = (stage.baseH * stage.restScale) / camera.out_h;

  mkdirSync(o.frameDir, { recursive: true });
  const pageT = Math.min(1.0, Math.max(0.2, duration * 0.3));
  // The final shot is the last frame before the fade to the background, not a frame half way into it.
  const endT = Math.max(0, duration - Math.min(camera.fade_s, duration / 4) - 0.1);
  const frames = [
    { label: "page", t: pageT, path: join(o.frameDir, `round-${round}-page.png`), shows: "the real page at rest" },
    ...(clickOut === undefined ? [] : [{ label: "click", t: Math.min(endT, clickOut + 0.12), path: join(o.frameDir, `round-${round}-click.png`), shows: "the click or cursor moment" }]),
    { label: "end", t: endT, path: join(o.frameDir, `round-${round}-end.png`), shows: "the final shot" },
  ];
  for (const frame of frames) await extract(film, frame.t, frame.path);

  const safePath = join(o.dir, "safe-area.json");
  const safeAreaFailures = existsSync(safePath)
    ? ((JSON.parse(readFileSync(safePath, "utf8")) as { failures?: unknown[] }).failures?.length ?? 0)
    : 0;
  let baseline: BaselineFacts | undefined;
  if (o.baseline) {
    const b = o.baseline;
    baseline = {
      round: 1,
      score: b.score,
      pageShare: b.facts.pageShare,
      cursorDrawn: b.facts.cursorDrawn,
      clickOverlay: b.facts.clickOverlay,
      zoomAtClick: b.facts.zoomAtClick,
      ...(b.facts.resultInFrame === undefined ? {} : { resultInFrame: b.facts.resultInFrame }),
    };
  }
  return {
    film,
    duration,
    frameCount: determinism.frames,
    pageShare: widthShare * heightShare,
    stageMargin: camera.stage_margin,
    pointerSamples: pointerCount(o.dir),
    cursorFree: meta.cursor_free === true,
    cursorDrawn: hasDialogue(join(o.dir, "cursor.ass")),
    clickOverlay: hasDialogue(join(o.dir, "clicks.ass")),
    clickCount: clicks.length,
    zoomAtClick,
    captionSize: camera.caption_size,
    captions: meta.captions?.length ?? 0,
    title: typeof meta.title === "string" && meta.title.length > 0,
    safeAreaFailures,
    beats: beats.length,
    longestHold: hold.span,
    longestHoldAt: hold.at,
    ...(resultInFrame === undefined ? {} : { resultInFrame }),
    determinism,
    frames,
    ...(baseline === undefined ? {} : { baseline }),
  };
}

export function clearOverlays(dir: string): void {
  rmSync(join(dir, "cursor.ass"), { force: true });
}
