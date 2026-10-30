// `takeone motion --reference <video> --measure`: measure a reference film, so an existing pattern can be
// cut on the reference's own beat list instead of on reading floors alone. Writes facts.json, a frame
// early in every beat plus an even grid under frames/, contact.jpg and the replication rules beside them.
// The procedure is the vendored resources/motion/craft/REPLICATE.md (Apache-2.0, see THIRD_PARTY_NOTICES.md).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Vendored replication rules, copied into the measurement's directory. */
export const RULES = fileURLToPath(new URL("../../resources/motion/craft/REPLICATE.md", import.meta.url));
/** A beat scores at least this much of the film's own strongest change: a promo's beats are rarely hard cuts. */
export const SCENE_RATIO = 0.35;
/** ...and at least this much absolutely, so encoder noise never becomes a beat. */
export const SCENE_MIN = 0.008;
/** Two changes closer than this are one beat (a dissolve, a fast wipe). */
export const MIN_BEAT_GAP_S = 0.4;
/** Frames sampled from the film's own grid, beside one early in every beat. */
export const FRAME_GRID = 16;
export const FRAME_WIDTH = 480;
export const CONTACT_COLS = 4;

export interface Probe { width: number; height: number; fps: number; duration: number; audio: boolean }
export interface Score { t: number; s: number }
export interface Beat { t: number; score: number }

export interface ReferenceFacts {
  version: 1;
  file: string;
  sha256: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  audio: boolean;
  /** Beat boundaries in seconds: snap scene boundaries onto these. */
  cuts: number[];
  cut_scores: number[];
  frames: { t: number; file: string }[];
  contact: string;
  rules: string;
}

const ffprobeArgs = (file: string) => ["-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=codec_type,width,height,avg_frame_rate:format=duration", "-of", "json", file];

export function parseProbe(json: string): Probe {
  const doc = JSON.parse(json) as {
    streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string }[];
    format?: { duration?: string };
  };
  const video = doc.streams?.find((s) => s.codec_type === "video");
  const [n, d] = (video?.avg_frame_rate ?? "").split("/").map(Number);
  const fps = d ? n! / d : NaN, width = video?.width ?? 0, height = video?.height ?? 0, duration = Number(doc.format?.duration);
  if (!(width > 0 && height > 0 && fps > 0 && duration > 0)) throw new Error("reference: ffprobe found no video stream");
  return { width, height, fps, duration, audio: !!doc.streams?.some((s) => s.codec_type === "audio") };
}

/** `metadata=print` output: one pts_time line and one scene_score line per frame, in film order. */
export function parseScores(meta: string): Score[] {
  const times = [...meta.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
  const scores = [...meta.matchAll(/lavfi\.scene_score=([\d.eE+-]+)/g)].map((m) => Number(m[1]));
  if (!times.length || times.length !== scores.length) throw new Error("reference: ffmpeg printed no scene scores; is this a video?");
  return times.map((t, i) => ({ t: t!, s: scores[i]! }));
}

/** The film's beat boundaries: local maxima of the scene score, kept from the strongest down, so one hard
 *  cut cannot hide the softer beats around it, and no two beats on one dissolve. */
export function cutPeaks(frames: Score[]): Beat[] {
  const top = Math.max(...frames.map((f) => f.s));
  const floor = Math.max(SCENE_MIN, SCENE_RATIO * top);
  const peaks = frames.filter((f, i) => f.t >= 0.3 && f.s >= floor
    && f.s >= (frames[i - 1]?.s ?? 0) && f.s >= (frames[i + 1]?.s ?? 0));
  const kept: Beat[] = [];
  for (const p of [...peaks].sort((a, b) => b.s - a.s)) {
    if (!kept.some((k) => Math.abs(k.t - p.t) < MIN_BEAT_GAP_S)) kept.push({ t: Math.round(p.t * 1000) / 1000, score: p.s });
  }
  return kept.sort((a, b) => a.t - b.t);
}

/** A frame early in every beat, then an even grid over the whole film: the frames are the evidence, the cuts the hint. */
export function frameTimes(duration: number, cuts: number[]): number[] {
  const grid = Array.from({ length: FRAME_GRID }, (_, i) => Math.round((duration * (i + 0.5) / FRAME_GRID) * 1000) / 1000);
  const times = [...cuts.map((t) => Math.round((t + 0.2) * 1000) / 1000).filter((t) => t < duration - 1e-6), ...grid].sort((a, b) => a - b);
  const kept: number[] = [];
  for (const t of times) if (!kept.length || t - kept.at(-1)! >= 0.2) kept.push(t);
  return kept;
}

/** Snap each scene onto the first measured beat at or after its floor: the reading floor stays a hard minimum. */
export function beatTimings(floors: number[], beats: number[], fps = 60): number[] {
  const out: number[] = [];
  let at = 0;
  for (const [i, floor] of floors.entries()) {
    const beat = i === floors.length - 1 ? undefined : beats.find((b) => b >= at + floor - 1e-6 && b > at + 1e-6);
    const d = beat === undefined ? floor : beat - at;
    out.push(Math.ceil(d * fps - 1e-9) / fps);
    at += out.at(-1)!;
  }
  return out;
}

/** A facts.json written by an earlier `--measure`: its beat list, so a plan reuses one measurement. */
export function readCuts(file: string): number[] {
  const cuts = (JSON.parse(readFileSync(file, "utf8")) as { cuts?: unknown }).cuts;
  if (!Array.isArray(cuts) || cuts.some((c) => typeof c !== "number" || !Number.isFinite(c) || c <= 0)) {
    throw new Error(`${file} is not a reference facts.json: it has no positive cuts list`);
  }
  return cuts as number[];
}

/** The measured beats of `ref`: a facts.json is read, a video is measured into `dir`. */
export async function referenceCuts(ref: string, dir: string, log: (line: string) => void = () => {}): Promise<number[]> {
  if (/\.json$/i.test(ref)) return readCuts(ref);
  return (await measureReference(ref, dir, log)).cuts;
}

/** Measure a reference film into `dir`: facts.json, frames/, contact.jpg and REPLICATE.md. Local ffmpeg only. */
export async function measureReference(file: string, dir: string, log: (line: string) => void = () => {}): Promise<ReferenceFacts> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer); // never the whole film in memory
  const probe = parseProbe((await execFileAsync("ffprobe", ffprobeArgs(file), { maxBuffer: 1024 * 1024 })).stdout);
  const meta = (await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-threads", "2", "-filter_threads", "2", "-i", file, "-an",
    "-vf", "scale=480:-2,select='gte(scene\\,0)',metadata=print:file=-", "-f", "null", "-"],
    { timeout: 900_000, maxBuffer: 64 * 1024 * 1024 })).stdout;
  const beats = cutPeaks(parseScores(meta));
  const times = frameTimes(probe.duration, beats.map((b) => b.t));
  log(`motion: reference ${probe.duration.toFixed(2)} s, ${probe.width}x${probe.height}@${probe.fps.toFixed(2)}: ${beats.length} beats`);

  rmSync(join(dir, "frames"), { recursive: true, force: true });
  mkdirSync(join(dir, "frames"), { recursive: true });
  const frames: { t: number; file: string }[] = [];
  for (const [i, t] of times.entries()) {
    const name = `${String(i + 1).padStart(3, "0")}.jpg`;
    await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-threads", "2", "-filter_threads", "2",
      "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `scale=${FRAME_WIDTH}:-2`, "-q:v", "4", join(dir, "frames", name)],
      { timeout: 300_000, maxBuffer: 1024 * 1024 });
    frames.push({ t, file: `frames/${name}` });
  }
  const rows = Math.ceil(frames.length / CONTACT_COLS);
  await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-threads", "2", "-filter_threads", "2",
    "-i", join(dir, "frames", "%03d.jpg"), "-vf", `scale=320:-2,tile=${CONTACT_COLS}x${rows}:padding=6:margin=6`,
    "-frames:v", "1", join(dir, "contact.jpg")], { timeout: 300_000, maxBuffer: 1024 * 1024 });
  copyFileSync(RULES, join(dir, "REPLICATE.md"));

  const facts: ReferenceFacts = {
    version: 1, file, sha256: hash.digest("hex"),
    duration: probe.duration, width: probe.width, height: probe.height, fps: probe.fps, audio: probe.audio,
    cuts: beats.map((b) => b.t), cut_scores: beats.map((b) => b.score),
    frames, contact: "contact.jpg", rules: "REPLICATE.md",
  };
  writeFileSync(join(dir, "facts.json"), `${JSON.stringify(facts, null, 2)}\n`);
  return facts;
}
