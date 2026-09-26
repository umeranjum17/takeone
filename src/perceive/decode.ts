// ffmpeg decode of screen.webm into grey analysis frames, and frames.tsv /
// clock helpers. Thin I/O wrappers; the math lives in regions.ts.

import { spawn } from "node:child_process";
import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Event, TakeMeta } from "../types.ts";

export const ANALYSIS_FPS = 10;

export interface GreyFrame {
  t: number; // ms on the event clock
  data: Uint8Array; // w*h grey bytes
}

export interface Decoded {
  w: number;
  h: number;
  frames: GreyFrame[];
}

/**
 * Decode the take's webm at ANALYSIS_FPS, downscaled to 1/4, as grey frames.
 * Frame i sits at t0 + i * (1000 / ANALYSIS_FPS) on the event clock, where t0
 * is the first frame's capture time from frames.tsv and take.offset_ms.
 */
export async function decodeAnalysisFrames(webm: string, take: TakeMeta, framesTsv: string): Promise<Decoded> {
  const w = Math.floor(take.stream.w / 4);
  const h = Math.floor(take.stream.h / 4);
  const t0 = firstFrameTimeMs(framesTsv, take);
  const step = 1000 / ANALYSIS_FPS;

  const frames: GreyFrame[] = [];
  const proc = spawn(
    "ffmpeg",
    [
      "-nostdin",
      "-i",
      webm,
      "-vf",
      `fps=${ANALYSIS_FPS},scale=${w}:${h},format=gray`,
      "-f",
      "rawvideo",
      "-",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const n = w * h;
  let buf = Buffer.alloc(0);
  for await (const chunk of proc.stdout) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    while (buf.length >= n) {
      frames.push({ t: t0 + frames.length * step, data: new Uint8Array(buf.subarray(0, n)) });
      buf = buf.subarray(n);
    }
  }
  await new Promise<void>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code) => (code === 0 || code === null ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
  return { w, h, frames };
}

/** First frame capture time on the event clock: rtp/90 + offset_ms. */
export function firstFrameTimeMs(framesTsv: string, take: TakeMeta): number {
  const line = readFirstLineSync(framesTsv);
  if (!line) return 0;
  const rtp = Number(line.split("\t")[0]);
  if (!Number.isFinite(rtp)) return 0;
  return rtp / 90 + (take.offset_ms ?? 0);
}

function readFirstLineSync(path: string): string | null {
  // small synchronous read; frames.tsv's first line is all we need here
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(256);
    const bytesRead = readSync(fd, buf, 0, 256, 0);
    const s = buf.subarray(0, bytesRead).toString("utf8");
    const nl = s.indexOf("\n");
    return (nl === -1 ? s : s.slice(0, nl)).trim() || null;
  } finally {
    closeSync(fd);
  }
}

/** Stream events.jsonl as parsed objects. */
export async function readEvents(path: string): Promise<Event[]> {
  const out: Event[] = [];
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }) });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as Event);
    } catch {
      // skip malformed lines; the take stays usable
    }
  }
  return out;
}
