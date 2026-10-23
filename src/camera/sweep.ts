// The motion side of the no-cut-text guard. A crop edge moving between two clean framings
// crosses whatever text lies between them, so some moving frames cut text whatever path is
// taken. The owner accepted that only while the edge sweeps past quickly: a frame may cut
// text only while its card edge moves at least SWEEP_EDGE_SPEED. Resting and crawling
// frames must show every word whole.
import type { CameraDefaults } from "./defaults.ts";
import type { CameraFrame } from "./types.ts";

/** A cut frame is allowed only while the card edge sweeps the screen faster than this, in output px/s:
 * 2 px per 60 fps frame. The reference demo's camera is effectively at rest (95% of frame pairs move the
 * view under 130 px/s, median 0.1) and its moves (frames over 30 px/s) have p25 85 and median 349 px/s, so 120
 * sits in the slow part of a real move and a view crawling below it is reading, not travelling. */
export const SWEEP_EDGE_SPEED = 120;

/** Fastest a crop edge crosses the screen between frames p and q, in output px/s. */
export function edgeSpeed(p: CameraFrame, q: CameraFrame, outW: number, outH: number, fps: number): number {
  const sx = outW / q.w, sy = outH / q.h;
  return Math.max(Math.abs(q.x - p.x) * sx, Math.abs(q.x + q.w - p.x - p.w) * sx,
    Math.abs(q.y - p.y) * sy, Math.abs(q.y + q.h - p.y - p.h) * sy) * fps;
}

/** The repo's rest definition, as used by the camera bars and the drag-ease reserve. */
export function still(p: CameraFrame, q: CameraFrame, outW: number, outH: number, fps: number): boolean {
  return Math.abs(Math.log(q.w / p.w)) * fps <= 0.005
    && Math.abs(q.x / q.w - p.x / p.w) * outW * fps <= 1
    && Math.abs(q.y / q.h - p.y / p.h) * outH * fps <= 1;
}

// Speed held through a cut, with headroom for the uniform resampling, and the edge acceleration
// that reaches it (output px/s²): a third of the 9000 px/s² pan bar, at most the bar's 8000 headroom.
// Cuts closer than half a second of sweep are crossed in one go: slowing between them would stutter.
const CROSS = SWEEP_EDGE_SPEED * 1.15, ACCEL = 3000, ACCEL_MAX = 8000, PAD = 0.5, JOIN = CROSS / 2, ROUNDS = 6;

/** Output px a resting edge keeps clear of text: room for a move leaving or reaching that rest
 * to be sweeping before the edge meets the text, instead of jolting from rest into it. */
export const SWEEP_CLEARANCE = CROSS * CROSS / (2 * ACCEL) + PAD;

/**
 * Retime every move that crawls a crop edge through text. The move keeps its path, its start
 * and its direction; it crosses each stretch the guard reports cut at no less than CROSS output px/s,
 * reaching that speed and leaving it at a bounded acceleration over the clean path either side,
 * so it only ever runs faster than planned. It arrives early and holds its arrival framing,
 * which the guard already judged clean. `judge` gives each move its own check of a frame as the
 * viewer sees it, so what the check decodes lasts only as long as that move. Each move is
 * re-checked on its new frames, so the result is judged, not assumed.
 */
export function sweepCuts(frames: CameraFrame[], judge: () => (frame: CameraFrame) => boolean, d: CameraDefaults): CameraFrame[] {
  const { out_w: W, out_h: H, fps } = d;
  const out = frames.slice();
  const speed = (f: CameraFrame[], i: number) => edgeSpeed(f[i - 1]!, f[i]!, W, H, fps);
  let left = 0, first: number | undefined;
  for (let a = 1; a < frames.length;) {
    if (still(frames[a - 1]!, frames[a]!, W, H, fps)) { a++; continue; }
    let b = a;
    while (b + 1 < frames.length && !still(frames[b]!, frames[b + 1]!, W, H, fps)) b++;
    // The run's own path: frames a-1 (at rest) through b, and its edge travel s in output px.
    const path = frames.slice(a - 1, b + 1);
    const s = [0];
    for (let i = 1; i < path.length; i++) s.push(s[i - 1]! + speed(path, i) / fps);
    const length = s.at(-1)!, cut = judge();
    const zones: [number, number][] = [];
    const mark = (lo: number, hi: number) => zones.push([Math.max(0, lo - PAD), Math.min(length, hi + PAD)]);
    for (let i = 1; i < path.length; i++)
      if (speed(path, i) < SWEEP_EDGE_SPEED && cut(path[i]!)) mark(s[i - 1]!, s[Math.min(i + 1, path.length - 1)]!);
    let run = path.slice(1);
    for (let round = 0; zones.length && round < ROUNDS; round++) {
      zones.sort((p, q) => p[0] - q[0]);
      const joined = zones.reduce<[number, number][]>((list, [lo, hi]) => {
        const last = list.at(-1);
        if (last && lo - last[1] < JOIN) last[1] = Math.max(last[1], hi); else list.push([lo, hi]);
        return list;
      }, []);
      // Each zone is reached and left at the gentlest acceleration the clean path around it allows.
      const ramps = joined.map(([lo, hi]) => [lo, hi, Math.min(ACCEL_MAX, Math.max(ACCEL,
        lo > 0 ? CROSS * CROSS / (2 * lo) : ACCEL_MAX, hi < length ? CROSS * CROSS / (2 * (length - hi)) : ACCEL_MAX))] as const);
      const floor = (x: number) => Math.max(0, ...ramps.map(([lo, hi, acc]) =>
        Math.sqrt(Math.max(0, CROSS * CROSS - 2 * acc * Math.max(0, lo - x, x - hi)))));
      // Original steps take 1/fps each; a step now takes its travel over the faster speed.
      const T = [0];
      for (let i = 1; i < path.length; i++) {
        const v = speed(path, i);
        T.push(T[i - 1]! + (v > 0 ? v / Math.max(v, floor((s[i - 1]! + s[i]!) / 2)) : 1) / fps);
      }
      // Arrive on a frame, not between two: a part step into the arrival would crawl its last frame.
      const stretch = Math.ceil(T.at(-1)! * fps - 1e-9) / (T.at(-1)! * fps);
      for (let i = 0; i < T.length; i++) T[i] = T[i]! * stretch;
      const at = (t: number): { frame: CameraFrame; s: number } => {
        let k = T.findIndex(x => x > t);
        if (k < 0) return { frame: path.at(-1)!, s: length };
        k = Math.max(1, k);
        const u = (t - T[k - 1]!) / (T[k]! - T[k - 1]!), p = path[k - 1]!, q = path[k]!;
        return { frame: { t: 0, x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u, w: p.w + (q.w - p.w) * u, h: p.h + (q.h - p.h) * u },
          s: s[k - 1]! + (s[k]! - s[k - 1]!) * u };
      };
      const timed = path.slice(1).map((f, i) => ({ ...at((i + 1) / fps), t: f.t }));
      run = timed.map(x => ({ ...x.frame, t: x.t }));
      // Judge the new frames: any that still crawls through a cut widens its zone.
      const missed = timed.filter((x, i) => edgeSpeed(i ? run[i - 1]! : path[0]!, run[i]!, W, H, fps) < SWEEP_EDGE_SPEED
        && !still(i ? run[i - 1]! : path[0]!, run[i]!, W, H, fps) && cut(run[i]!));
      if (!missed.length) { zones.length = 0; break; }
      for (const x of missed) mark(x.s - 2 * CROSS / fps, x.s + 2 * CROSS / fps);
      if (round === ROUNDS - 1) { left += missed.length; first ??= missed[0]!.t; }
    }
    out.splice(a, run.length, ...run);
    a = b + 1;
  }
  if (left) console.warn(`camera: ${left} frames still cut text while the view moves under ${SWEEP_EDGE_SPEED} px/s (first at ${first!.toFixed(2)} s)`);
  return out;
}
