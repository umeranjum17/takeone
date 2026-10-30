import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BBox } from "../types.ts";

const run = promisify(execFile);
const STEP_S = 0.25;
const CELLS = 16 * 16;
const CHANGED_LEVEL = 24; // a cell of the 16x16 summary that moved this many grey levels from the beat's first frame has changed
const CHANGED_CELLS = 16; // a region with at least this many changed cells shows something new

/** A spotlight lights its region while the rest dims. The zone a beat's action brings up (a menu, a list) looks as it did
 * before the beat until it opens and again after it closes, and lighting that unchanged patch beside a dimmed action is a
 * defect. This keeps the first stretch of [from, to) where the footage in `rect` differs from its first frame (at least
 * half a second), or null when it never does. */
export async function litWindow(webm: string, rect: BBox, from: number, to: number): Promise<{ t: number; d: number } | null> {
  const [x, y, w, h] = rect.map(Math.round);
  const { stdout } = await run("ffmpeg", ["-nostdin", "-v", "error", "-ss", String(from), "-t", String(to - from), "-i", webm,
    "-vf", `fps=${1 / STEP_S},crop=${w}:${h}:${x}:${y},scale=16:16,format=gray`, "-f", "rawvideo", "-"],
  { encoding: "buffer", maxBuffer: 64 << 20 });
  let start = -1, end = -1;
  const first = stdout.subarray(0, CELLS);
  for (let i = 1; i * CELLS < stdout.length; i++) {
    const cells = stdout.subarray(i * CELLS, (i + 1) * CELLS);
    if (cells.reduce((n, v, j) => n + (Math.abs(v - first[j]!) > CHANGED_LEVEL ? 1 : 0), 0) >= CHANGED_CELLS) {
      if (start < 0) start = i;
      end = i;
    } else if (start >= 0) break;
  }
  const d = (end - start + 1) * STEP_S;
  return start < 0 || d < 0.5 ? null : { t: from + start * STEP_S, d: Math.min(4, d) };
}
