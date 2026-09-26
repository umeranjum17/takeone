// Mapping Jev answers to decisions (design 8.2), plus the decision-side framing
// estimator used for fit checks. Pure functions over plain data.

import type { Beat, BBox, Decision, JevAnswers, Tightness, Zone } from "../types.ts";
import { bboxArea } from "../types.ts";

export const LOW_CONF = 0.5;
export const HOLD_P = 0.35;
export const MOVE_P = 0.65;
export const FIT_MARGIN = 0.08;
export const WIDE_UNION_FRAC = 0.7; // union of top two over this -> all
export const KEY_MOMENT_TIGHTEN = 1;
export const CONF_SUM_TOL = 0.01;

/**
 * The frame rect for a zone at tightness L (design 10.1 frame()). This is the
 * decision-side estimate of what the viewer sees; the camera lane owns the
 * final smoothed path.
 */
export function frameRect(
  zone: Zone | null,
  L: Tightness,
  o: { stream: { w: number; h: number }; winRect: BBox | null },
): BBox {
  const { w, h } = o.stream;
  if (L === 0 || !zone || zone.kind === "all") return [0, 0, w, h];
  let r: BBox;
  if (L === 1) {
    const win = o.winRect;
    if (
      win &&
      zone.bbox[0] >= win[0] &&
      zone.bbox[1] >= win[1] &&
      zone.bbox[0] + zone.bbox[2] <= win[0] + win[2] &&
      zone.bbox[1] + zone.bbox[3] <= win[1] + win[3]
    ) {
      r = [...win];
    } else {
      r = pad(zone.bbox, 2.2);
    }
  } else if (L === 2) {
    r = pad(zone.bbox, 1.8);
  } else {
    r = pad(zone.bbox, 1.35);
  }
  // expand the short side to 16:9
  const ar = 16 / 9;
  if (r[2] / r[3] < ar) {
    const nw = r[3] * ar;
    r = [r[0] - (nw - r[2]) / 2, r[1], nw, r[3]];
  } else {
    const nh = r[2] / ar;
    r = [r[0], r[1] - (nh - r[3]) / 2, r[2], nh];
  }
  // clamp inside the frame
  const cw = Math.min(r[2], w);
  const ch = Math.min(r[3], h);
  const cx = Math.min(Math.max(r[0] + r[2] / 2, cw / 2), w - cw / 2);
  const cy = Math.min(Math.max(r[1] + r[3] / 2, ch / 2), h - ch / 2);
  return [Math.round(cx - cw / 2), Math.round(cy - ch / 2), Math.round(cw), Math.round(ch)];
}

function pad(b: BBox, f: number): BBox {
  const w = b[2] * f;
  const h = b[3] * f;
  return [b[0] - (w - b[2]) / 2, b[1] - (h - b[3]) / 2, w, h];
}

function fitsInside(inner: BBox, outer: BBox, margin: number): boolean {
  const mx = outer[2] * margin;
  const my = outer[3] * margin;
  return (
    inner[0] >= outer[0] - mx &&
    inner[1] >= outer[1] - my &&
    inner[0] + inner[2] <= outer[0] + outer[2] + mx &&
    inner[1] + inner[3] <= outer[1] + outer[3] + my
  );
}

/** Probabilities must sum to 1 +/- 0.01 or the answer falls back to heuristic. */
export function sumsTo1(probs: Record<string, number> | number[] | undefined): boolean {
  if (!probs) return false;
  const values = Object.values(probs);
  if (values.length === 0 || values.some((p) => typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1)) return false;
  const s = values.reduce((a, b) => a + b, 0);
  return Math.abs(s - 1) <= CONF_SUM_TOL;
}

/** Argmax level of a score answer's per-level probabilities. */
export function argmaxLevel(probs: number[] | undefined): number | null {
  if (!probs || probs.length === 0 || !sumsTo1(probs)) return null;
  let bi = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i]! > probs[bi]!) bi = i;
  return bi;
}

/**
 * Map one beat's Jev answers to a decision, with the uncertainty rules.
 * `viewport` is the bbox of the shot on screen when the beat starts.
 * Returns null when the answers are unusable (the caller then applies the heuristic).
 */
export function mapAnswers(
  beat: Beat,
  answers: JevAnswers,
  ctx: { viewport: BBox | null; winRect: BBox | null; stream: { w: number; h: number }; about?: string },
): Decision | null {
  const fs = answers.focus_start;
  const fe = answers.focus_end;
  if (!fs?.choice || !fe?.choice) return null;
  const names = beat.zones.map((z) => z.name);
  const validChoice = (p: Record<string, number> | undefined) => p && Object.keys(p).every((n) => names.includes(n)) && sumsTo1(p);
  const validConf = (c: number | undefined) => c === undefined || (Number.isFinite(c) && c >= 0 && c <= 1);
  if (!validChoice(fs.probabilities) || !validChoice(fe.probabilities) ||
      !Object.hasOwn(fs.probabilities!, fs.choice) || !Object.hasOwn(fe.probabilities!, fe.choice) ||
      !validConf(fs.confidence) || !validConf(fe.confidence) ||
      !validConf(answers.tightness?.confidence) || !validConf(answers.key_moment?.confidence)) return null;
  const byName = (n: string) => beat.zones.find((z) => z.name === n);
  const zA = byName(fs.choice);
  const zB = byName(fe.choice);
  if (!zA || !zB) return null;

  const confA = fs.confidence ?? choiceConfidence(fs.probabilities);
  const confB = fe.confidence ?? choiceConfidence(fe.probabilities);

  let A = resolveChoice(zA, confA, fs.probabilities, beat);
  let B = resolveChoice(zB, confB, fe.probabilities, beat);

  // tightness: argmax level, one level wider when confidence is low
  if (answers.tightness?.probabilities?.length !== 4) return null;
  const rawL = argmaxLevel(answers.tightness?.probabilities);
  if (rawL === null) return null;
  let L: Tightness = rawL as Tightness;
  const confL = answers.tightness?.confidence ?? 0;
  if (confL < LOW_CONF) L = Math.max(0, rawL - 1) as Tightness;

  // new_subject probability
  const p = answers.new_subject?.p;
  if (p === undefined || !Number.isFinite(p) || p < 0 || p > 1) return null;

  // key moment (only asked with --about)
  let K: 0 | 1 | 2 = 1;
  if (ctx.about) {
    if (answers.key_moment?.probabilities?.length !== 3) return null;
    const kl = argmaxLevel(answers.key_moment?.probabilities);
    if (kl === null) return null;
    {
      K = Math.min(2, kl) as 0 | 1 | 2;
      const confK = answers.key_moment?.confidence ?? 0;
      if (K === 2 && confK >= LOW_CONF) L = Math.min(3, L + KEY_MOMENT_TIGHTEN) as Tightness;
    }
  }

  // B = A when B fits the frame chosen for A with 8% margin
  const frameA = frameRect(byName(A) ?? null, L, { stream: ctx.stream, winRect: ctx.winRect });
  if (fitsInside(byName(B)!.bbox, frameA, FIT_MARGIN)) B = A;

  return {
    beat: beat.id,
    A,
    B,
    L,
    p,
    K,
    conf: { A: confA, B: confB, L: confL, K: ctx.about ? answers.key_moment?.confidence : undefined },
    decided_by: "jev",
    model: "jev-latest",
  };
}

/**
 * A choice with confidence < 0.5 widens: the smallest zone containing the top
 * two options' bboxes; `all` when that zone covers over 70% of the screen or no
 * zone contains both.
 */
function resolveChoice(
  top: Zone,
  conf: number,
  probs: Record<string, number> | undefined,
  beat: Beat,
): string {
  if (conf >= LOW_CONF) return top.name;
  const second = secondChoice(probs, top.name);
  const z2 = second ? beat.zones.find((z) => z.name === second) : null;
  if (!z2) return top.name;
  const union: BBox = [
    Math.min(top.bbox[0], z2.bbox[0]),
    Math.min(top.bbox[1], z2.bbox[1]),
    Math.max(top.bbox[0] + top.bbox[2], z2.bbox[0] + z2.bbox[2]) - Math.min(top.bbox[0], z2.bbox[0]),
    Math.max(top.bbox[1] + top.bbox[3], z2.bbox[1] + z2.bbox[3]) - Math.min(top.bbox[1], z2.bbox[1]),
  ];
  const screen = beat.zones.find((z) => z.kind === "all")?.bbox;
  const screenArea = screen ? screen[2] * screen[3] : 1;
  // smallest zone whose bbox contains the union
  let best: Zone | null = null;
  for (const z of beat.zones) {
    if (
      z.bbox[0] <= union[0] &&
      z.bbox[1] <= union[1] &&
      z.bbox[0] + z.bbox[2] >= union[0] + union[2] &&
      z.bbox[1] + z.bbox[3] >= union[1] + union[3]
    ) {
      if (!best || bboxArea(z.bbox) < bboxArea(best.bbox)) best = z;
    }
  }
  const allName = beat.zones.find((z) => z.kind === "all")?.name ?? top.name;
  if (!best || best.kind === "all" || bboxArea(best.bbox) / screenArea > WIDE_UNION_FRAC) return allName;
  return best.name;
}

function choiceConfidence(probs: Record<string, number> | undefined): number {
  if (!probs) return 0;
  const vals = Object.values(probs);
  if (vals.length < 2) return 0;
  const pmax = Math.max(...vals);
  return (vals.length * pmax - 1) / (vals.length - 1);
}

function secondChoice(probs: Record<string, number> | undefined, top: string): string | null {
  if (!probs) return null;
  let best: string | null = null;
  for (const [k, v] of Object.entries(probs)) {
    if (k === top) continue;
    if (!best || v > probs[best]!) best = k;
  }
  return best;
}

export type { Decision };
