// OCR of zone text (--screen-text opt-in): tesseract --psm 6, words with
// confidence >= 60, capped per zone, redacted. I/O wrapper; the redaction
// itself is pure (redact.ts).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BBox } from "../types.ts";
import { redactText } from "./redact.ts";

export const OCR_WORD_CAP = 12;
export const OCR_MIN_CONF = 60;

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

function tesseract(png: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("tesseract", [png, "stdout", "--psm", "6", "tsv"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    p.stdout?.on("data", (d) => (out += d));
    p.once("error", reject);
    p.once("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`tesseract exited ${code}`))));
  });
}

/** Parse tesseract TSV, keep words with conf >= OCR_MIN_CONF, cap and redact. */
export function redactWords(tsv: string): string | null {
  const words: string[] = [];
  for (const line of tsv.split("\n").slice(1)) {
    const cols = line.split("\t");
    if (cols.length < 12) continue;
    const conf = Number(cols[10]);
    const word = (cols[11] ?? "").trim();
    if (!word || !Number.isFinite(conf) || conf < OCR_MIN_CONF) continue;
    words.push(word);
    if (words.length >= OCR_WORD_CAP) break;
  }
  if (words.length === 0) return null;
  for (let i = 0; i < words.length; i++) {
    if (!/^[A-Za-z0-9]+$/.test(words[i]!)) continue;
    let combined = words[i]!;
    for (let j = i + 1; j < words.length && /^[A-Za-z0-9]+$/.test(words[j]!); j++) {
      combined += words[j]!;
      if (/^\d{6,}$/.test(combined) || (combined.length >= 20 && /[A-Za-z]/.test(combined) && /\d/.test(combined))) {
        words.splice(i, j - i + 1, "[redacted]");
        break;
      }
    }
  }
  return redactText(words.join(" "));
}
