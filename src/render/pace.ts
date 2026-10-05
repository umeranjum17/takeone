// Pacing: play the idle stretches between actions faster so a demo never sits
// on dead air. The camera is then solved in the warped (output) time, so moves
// keep their natural speed. Local only; costs zero tokens.
import type { CameraDefaults } from "../camera/defaults.ts";
import type { Beat } from "../camera/types.ts";

/** A trim-relative span played at `idle_speed`. */
export interface Squeeze { a: number; b: number }

/** Activity spans in video-relative seconds from beat anchors, actions (ms) and screen results. */
function activity(beats: Beat[]): [number, number][] {
  const spans: [number, number][] = [];
  for (const beat of beats) {
    spans.push([beat.anchor_t, beat.anchor_t]);
    for (const result of beat.dialog_results ?? []) spans.push([result.t, result.t]);
    // Video-only screen changes have no input-action spans. Their observed
    // result hold is activity, so pacing must not compress it as dead air.
    if (beat.kind === "change") spans.push([beat.t0, beat.t1]);
    for (const zone of beat.zones) if (zone.t_change !== undefined) spans.push([zone.t_change, zone.t_change]);
    for (const action of beat.actions) {
      const a = action as { k?: string; t?: number; t0?: number; t1?: number };
      // A resting pointer is exactly the dead air being squeezed.
      if (a.k === "dwell" || a.k === "ptr") continue;
      if (a.t !== undefined) spans.push([a.t / 1000, a.t / 1000]);
      if (a.t0 !== undefined) spans.push([a.t0 / 1000, (a.t1 ?? a.t0) / 1000]);
    }
  }
  return spans.sort((x, y) => x[0] - y[0]);
}

/** Idle gaps, less `idle_keep` of real time on each side, that last at least a second. */
export function idleSqueezes(beats: Beat[], start: number, end: number, d: CameraDefaults): Squeeze[] {
  if (d.idle_speed <= 1) return [];
  const out: Squeeze[] = [];
  let busyUntil = start;
  const spans = [...activity(beats), [end + d.idle_keep, end + d.idle_keep] as [number, number]];
  for (const [t0, t1] of spans) {
    const a = Math.max(start, busyUntil + d.idle_keep);
    const b = Math.min(end, t0 - d.idle_keep);
    if (b - a >= 1) out.push({ a: a - start, b: b - start });
    busyUntil = Math.max(busyUntil, t1);
  }
  return out;
}

/** Output time of trim-relative time `t`. */
export function warp(t: number, squeezes: Squeeze[], speed: number): number {
  let out = t;
  for (const { a, b } of squeezes) out -= Math.min(Math.max(t - a, 0), b - a) * (1 - 1 / speed);
  return out;
}

/** The same warp as an ffmpeg setpts expression over trim-relative T. */
export function setptsExpr(squeezes: Squeeze[], speed: number): string {
  const terms = squeezes.map(({ a, b }) => `clip(T-${a.toFixed(4)},0,${(b - a).toFixed(4)})`);
  return terms.length ? `(T-${(1 - 1 / speed).toFixed(6)}*(${terms.join("+")}))/TB` : "PTS-STARTPTS";
}

/** Beats with every timestamp moved onto the output clock; times before `start` are kept. */
export function warpBeats(beats: Beat[], start: number, squeezes: Squeeze[], speed: number): Beat[] {
  if (squeezes.length === 0) return beats;
  const s = (t: number) => (t <= start ? t : start + warp(t - start, squeezes, speed));
  const ms = (t: number) => s(t / 1000) * 1000;
  return beats.map((beat) => ({
    ...beat,
    t0: s(beat.t0),
    t1: s(beat.t1),
    anchor_t: s(beat.anchor_t),
    dialog_results: beat.dialog_results?.map((result) => ({ ...result, t: s(result.t) })),
    zones: beat.zones.map((zone) => zone.t_change === undefined ? zone : { ...zone, t_change: s(zone.t_change) }),
    changed_frac: beat.changed_frac?.map((sample) => ({ ...sample, t: s(sample.t) })),
    actions: beat.actions.map((action) => {
      const a = action as { t?: number; t0?: number; t1?: number; path?: { t: number; x: number; y: number }[] };
      return {
        ...a,
        ...(a.t === undefined ? {} : { t: ms(a.t) }),
        ...(a.t0 === undefined ? {} : { t0: ms(a.t0) }),
        ...(a.t1 === undefined ? {} : { t1: ms(a.t1) }),
        ...(a.path ? { path: a.path.map(p => ({ ...p, t: ms(p.t) })) } : {}),
      };
    }),
  }));
}
