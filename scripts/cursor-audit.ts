#!/usr/bin/env node
// Drawn-cursor audit of a real render: arrow size, idle fades, where a looping film ends and how far
// each press lands from its click ripple, in output px.
// usage: node scripts/cursor-audit.ts <cursor-take> <plain-take> <no-ripple-take>
// The three are renders of one take with the same settings: the cursor-free take (its cursor.ass is
// read), a copy with take.json cursor_free false, and that copy rendered with --set ripple_ms=0.
// Differencing the decoded films' luma isolates the drawn cursor (cursor - plain) and each click ripple
// (plain - no-ripple), so the ripple centre is the click as the viewer sees it.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

type Box = [number, number, number, number];
interface Drawn { line: number; tip: [number, number]; ink: Box; alpha: number; bord: number }

/** The arrow each output frame shows from cursor.ass: its line, hotspot, ink box (path plus border) and
 * alpha. Frames are matched to lines the way ffmpeg's ass filter does: at the frame's truncated
 * millisecond, against centisecond line times. Also counts lines no frame shows. */
function drawnCursor(file: string, fps: number): { shown: Map<number, Drawn>; lines: number; unshown: number } {
  const shown = new Map<number, Drawn>();
  const sec = (h: string, m: string, s: string) => Math.round((Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000);
  let lines = 0, unshown = 0;
  for (const text of readFileSync(file, "utf8").split("\n")) {
    const m = /^Dialogue: 1,(\d+):(\d+):([\d.]+),(\d+):(\d+):([\d.]+),.*\\bord([\d.]+).*\\1a&H([0-9A-F]{2})&.*\}(m .*)$/.exec(text);
    if (!m) continue;
    const start = sec(m[1]!, m[2]!, m[3]!), end = sec(m[4]!, m[5]!, m[6]!);
    const xy = m[9]!.split(" ").filter((v) => !/[a-z]/.test(v)).map(Number);
    const xs = xy.filter((_, i) => i % 2 === 0), ys = xy.filter((_, i) => i % 2 === 1), bord = Number(m[7]);
    const drawn = { line: lines++, tip: [xs[0]!, ys[0]!] as [number, number], alpha: 1 - parseInt(m[8]!, 16) / 255, bord,
      ink: [Math.min(...xs) - bord, Math.min(...ys) - bord, Math.max(...xs) + bord, Math.max(...ys) + bord] as Box };
    let seen = false;
    for (let i = Math.max(0, Math.floor(start * fps / 1000) - 1); i <= Math.ceil(end * fps / 1000) + 1; i++) {
      const ms = Math.floor(i * 1000 / fps);
      if (ms >= start && ms < end) { shown.set(i, drawn); seen = true; }
    }
    if (!seen) unshown++;
  }
  return { shown, lines, unshown };
}

/** Pixels where films `a` and `b` (side by side, three per row) differ by over `level`, inside `within`. */
function changed(px: Buffer, a: number, b: number, w: number, h: number, level: number, within?: Box): [number, number][] {
  const [l, t, r, bottom] = within ?? [0, 0, w - 1, h - 1];
  const out: [number, number][] = [];
  for (let y = Math.max(0, Math.floor(t)); y <= Math.min(h - 1, Math.ceil(bottom)); y++) {
    const row = y * 3 * w;
    for (let x = Math.max(0, Math.floor(l)); x <= Math.min(w - 1, Math.ceil(r)); x++) {
      if (Math.abs(px[row + a * w + x]! - px[row + b * w + x]!) > level) out.push([x, y]);
    }
  }
  return out;
}

const boxOf = (pts: [number, number][]): Box | null => pts.length === 0 ? null : pts.reduce<Box>((b, [x, y]) =>
  [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1]!;

/** A ripple's first ring changes several hundred pixels, at least this many by over 60 levels. Encoder
 * drift between two otherwise identical films (x264 re-spends bits before a ripple) stays faint. */
const RIPPLE_MIN_PX = 150, RIPPLE_STRONG_PX = 40;

/** The films' luma planes side by side, one frame at a time. (ffmpeg's blend difference is not exact here.) */
async function* lumas(films: string[], w: number, h: number) {
  const ff = spawn("ffmpeg", ["-v", "error", "-threads", "2", "-filter_threads", "2", "-filter_complex_threads", "2",
    ...films.flatMap((f) => ["-i", f]), "-filter_complex", `${films.map((_, i) => `[${i}]format=gray[g${i}]`).join(";")};`
      + `${films.map((_, i) => `[g${i}]`).join("")}hstack=inputs=${films.length}`,
    "-f", "rawvideo", "-pix_fmt", "gray", "-"], { stdio: ["ignore", "pipe", "inherit"] });
  const size = films.length * w * h;
  let frame = Buffer.allocUnsafe(size), fill = 0;
  for await (const chunk of ff.stdout as AsyncIterable<Buffer>) {
    for (let off = 0; off < chunk.length;) {
      const n = Math.min(size - fill, chunk.length - off);
      chunk.copy(frame, fill, off, off + n);
      fill += n; off += n;
      if (fill === size) { yield frame; frame = Buffer.allocUnsafe(size); fill = 0; }
    }
  }
  const code = await new Promise((done) => ff.once("close", done));
  if (code !== 0) throw new Error(`ffmpeg exited ${code} differencing ${films.join(" ")}`);
}

export async function auditCursor(cursorTake: string, plainTake: string, noRippleTake: string) {
  const meta = JSON.parse(readFileSync(join(cursorTake, "take.json"), "utf8")) as { id?: string };
  const film = (dir: string) => join(dir, "out", `${meta.id ?? basename(cursorTake)}.mp4`);
  const probe = JSON.parse(await new Promise<string>((done, fail) => {
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", film(cursorTake)]);
    let s = ""; p.stdout.on("data", (c) => { s += c; }); p.once("close", (c) => c === 0 ? done(s) : fail(new Error(`ffprobe exited ${c}`)));
  })).streams[0] as { width: number; height: number; r_frame_rate: string };
  const { width: w, height: h } = probe;
  const [num, den] = probe.r_frame_rate.split("/").map(Number);
  const fps = num! / den!;
  const { shown: drawn, lines, unshown } = drawnCursor(join(cursorTake, "cursor.ass"), fps);
  const presses: { frame: number; t: number; ripple: [number, number]; tip: [number, number] | null; error_px: number | null }[] = [];
  const heights: number[] = [];
  let frames = 0, inkOutside = 0, inkMissing = 0, rippleOn = false;
  const outsideAt: [number, number][] = [], missingAt: number[] = [];
  for await (const px of lumas([cursorTake, plainTake, noRippleTake].map(film), w, h)) {
    const i = frames++, d = drawn.get(i);
    // The film's own fade in/out dims the arrow; judge ink only where it is drawn opaque.
    const ink = d ? boxOf(changed(px, 0, 1, w, h, 48, [d.ink[0] - 24, d.ink[1] - 24, d.ink[2] + 24, d.ink[3] + 24])) : null;
    if (d && d.alpha > 0.99) {
      if (!ink) { inkMissing++; if (missingAt.length < 20) missingAt.push(i); }
      else {
        const over = Math.max(d.ink[0] - ink[0], d.ink[1] - ink[1], ink[2] - d.ink[2], ink[3] - d.ink[3]);
        if (over > 2) { inkOutside++; if (outsideAt.length < 20) outsideAt.push([i, +over.toFixed(1)]); }
      }
      if (ink) heights.push(ink[3] - ink[1] + 1);
    }
    // A ripple starts where none was. Its centre is the box of the ring around the changed pixels'
    // median, so a few drifted pixels elsewhere cannot move it.
    const diff = changed(px, 1, 2, w, h, 24);
    const ring = diff.length >= RIPPLE_MIN_PX && changed(px, 1, 2, w, h, 60).length >= RIPPLE_STRONG_PX;
    if (ring && !rippleOn) {
      const mx = median(diff.map((p) => p[0])), my = median(diff.map((p) => p[1]));
      const box = boxOf(diff.filter(([x, y]) => Math.hypot(x - mx, y - my) < 120))!;
      const ripple: [number, number] = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
      const tip = d ? d.tip : null;
      presses.push({ frame: i, t: +(i / fps).toFixed(3), ripple, tip,
        error_px: tip ? +Math.hypot(tip[0] - ripple[0], tip[1] - ripple[1]).toFixed(2) : null });
    }
    rippleOn = ring;
  }
  const visible = [...drawn.keys()].sort((a, b) => a - b);
  // A frame that shows the same line as the frame before repeats the arrow while it should move on.
  const repeated = visible.filter((i) => drawn.get(i - 1)?.line === drawn.get(i)!.line).length;
  // Fades: runs where the arrow is drawn translucent before it disappears.
  const fades: { start_s: number; gone_s: number }[] = [];
  for (let i = 1; i < frames; i++) {
    const p = drawn.get(i - 1), q = drawn.get(i);
    if (p && p.alpha > 0.99 && q && q.alpha <= 0.99) {
      let j = i; while (drawn.get(j + 1) && drawn.get(j + 1)!.alpha <= drawn.get(j)!.alpha) j++;
      if (!drawn.has(j + 1)) fades.push({ start_s: +(i / fps).toFixed(3), gone_s: +((j + 1) / fps).toFixed(3) });
    }
  }
  const first = drawn.get(visible[0] ?? -1), last = drawn.get(frames - 1);
  const errors = presses.flatMap((p) => p.error_px === null ? [] : [p.error_px]).sort((a, b) => a - b);
  heights.sort((a, b) => a - b);
  return {
    take: cursorTake, frames, fps, out: [w, h],
    drawn_frames: visible.length, hidden_frames: frames - visible.length,
    cursor_lines: lines, repeated_frames: repeated, unshown_lines: unshown,
    ink_outside_drawn_frames: inkOutside, ink_missing_frames: inkMissing,
    ink_outside_at: outsideAt, ink_missing_at: missingAt,
    arrow_height_px: { min: heights[0] ?? null, median: heights[heights.length >> 1] ?? null, max: heights[heights.length - 1] ?? null },
    fades,
    loop: { first_frame: visible[0] ?? null, first_tip: first?.tip ?? null, last_tip: last?.tip ?? null,
      last_to_first_px: first && last ? +Math.hypot(last.tip[0] - first.tip[0], last.tip[1] - first.tip[1]).toFixed(2) : null },
    clicks: { presses: presses.length, measured: errors.length, max_error_px: errors[errors.length - 1] ?? null,
      median_error_px: errors[errors.length >> 1] ?? null, within_2px: errors.filter((e) => e <= 2).length },
    presses,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cursorTake, plainTake, noRippleTake] = process.argv.slice(2);
  if (!cursorTake || !plainTake || !noRippleTake) {
    console.error("usage: node scripts/cursor-audit.ts <cursor-take> <plain-take> <no-ripple-take>");
    process.exit(2);
  }
  console.log(JSON.stringify(await auditCursor(cursorTake, plainTake, noRippleTake), null, 1));
}
