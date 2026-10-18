// OCR of zone text (on by default with a planner; --no-screen-text opts out):
// confidence >= 60, capped per zone, redacted. Keyframe thumbnails for models
// that read images go through the same redaction: every word that would not
// pass as screen text is blacked out. I/O wrapper; the redaction itself is
// pure (redact.ts).

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BBox, Zone } from "../types.ts";
import { redactWord } from "./redact.ts";

export const OCR_WORD_CAP = 12;
export const OCR_MIN_CONF = 60;
/** Keyframe thumbnails: long side in pixels. */
export const THUMB_LONG_SIDE = 512;
const ZONE_COLORS = ["0xE6194B", "0x3CB44B", "0x4363D8", "0xF58231", "0x911EB4", "0x42D4F4", "0xF032E6", "0xBFEF45"];

/**
 * Read up to OCR_WORD_CAP words from the zone's rect at time t (ms) of the
 * take's webm. Returns the redacted words joined by spaces, or null when
 * nothing readable is found.
 */
export async function ocrZone(
  webm: string,
  bbox: BBox,
  tMs: number,
): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "takeone-ocr-"));
  const png = join(dir, "zone.png");
  try {
    await cropFrame(webm, bbox, tMs, png);
    const text = await tesseract(png);
    return redactWords(text);
  } catch {
    return null; // OCR never breaks the planner
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One keyframe thumbnail at time t (ms): the full frame, every word that would
 * not pass as screen text blacked out, each zone but the whole screen outlined
 * and labelled with its name, scaled to THUMB_LONG_SIDE. JPEG bytes. Throws
 * when ffmpeg or tesseract fails; the caller then stays text-only.
 */
export async function keyframeThumb(
  webm: string,
  tMs: number,
  zones: Zone[],
  stream: { w: number; h: number },
): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "takeone-thumb-"));
  const png = join(dir, "frame.png");
  const jpg = join(dir, "thumb.jpg");
  try {
    await ffmpeg(["-ss", (tMs / 1000).toFixed(3), "-i", webm, "-frames:v", "1", "-y", png]);
    const hidden = tsvWords(await tesseract(png, "11"))
      .filter((w) => redactWord(w.text) !== w.text);
    const k = Math.max(stream.w, stream.h) / THUMB_LONG_SIDE; // source pixels per thumbnail pixel
    const filters = [
      ...hidden.map((w) => `drawbox=x=${w.box[0]}:y=${w.box[1]}:w=${w.box[2]}:h=${w.box[3]}:color=black:t=fill`),
      ...zones.filter((z) => z.kind !== "all").flatMap((z, i) => {
        const color = ZONE_COLORS[i % ZONE_COLORS.length]!;
        const [x, y, w, h] = z.bbox.map(Math.round) as BBox;
        return [
          `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=${Math.ceil(2 * k)}`,
          `drawtext=font='Liberation Sans':text='${z.name}':x=${x + Math.ceil(3 * k)}:y=${y + Math.ceil(3 * k)}:fontsize=${Math.ceil(14 * k)}:fontcolor=white:box=1:boxcolor=${color}`,
        ];
      }),
      stream.w >= stream.h ? `scale=${THUMB_LONG_SIDE}:-2` : `scale=-2:${THUMB_LONG_SIDE}`,
    ];
    await ffmpeg(["-i", png, "-vf", filters.join(","), "-q:v", "5", "-y", jpg]);
    return new Uint8Array(readFileSync(jpg));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-nostdin", "-threads", "1", "-filter_threads", "1", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr?.on("data", (d) => (err += d));
    p.once("error", reject);
    p.once("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-200)))));
  });
}

function cropFrame(webm: string, b: BBox, tMs: number, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", [
      "-nostdin",
      "-ss",
      (tMs / 1000).toFixed(3),
      "-i",
      webm,
      "-vf",
      `crop=${Math.round(b[2])}:${Math.round(b[3])}:${Math.round(b[0])}:${Math.round(b[1])}`,
      "-frames:v",
      "1",
      "-y",
      out,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr?.on("data", (d) => (err += d));
    p.once("error", reject);
    p.once("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-200)))));
  });
}

function tesseract(png: string, psm = "6"): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("tesseract", [png, "stdout", "--psm", psm, "tsv"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    p.stdout?.on("data", (d) => (out += d));
    p.once("error", reject);
    p.once("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`tesseract exited ${code}`))));
  });
}

/** Words in tesseract TSV with their confidence (NaN when unreadable) and box. */
function tsvWords(tsv: string): { text: string; conf: number; box: BBox }[] {
  const words: { text: string; conf: number; box: BBox }[] = [];
  for (const line of tsv.split("\n").slice(1)) {
    const cols = line.split("\t");
    if (cols.length < 12) continue;
    const text = (cols[11] ?? "").trim();
    if (!text) continue;
    words.push({ text, conf: Number(cols[10]), box: [Number(cols[6]), Number(cols[7]), Number(cols[8]), Number(cols[9])] });
  }
  return words;
}

/** Parse tesseract TSV, keep words with conf >= OCR_MIN_CONF, cap and redact. */
export function redactWords(tsv: string): string | null {
  const words: string[] = [];
  for (const w of tsvWords(tsv)) {
    if (!Number.isFinite(w.conf) || w.conf < OCR_MIN_CONF) continue;
    words.push(redactWord(w.text));
    if (words.length >= OCR_WORD_CAP) break;
  }
  if (words.length === 0) return null;
  return words.join(" ");
}
