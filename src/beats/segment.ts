// Beat segmentation (design 7.1). Pure functions over plain data.

import type { Action, BBox, Beat, BeatKind, FrameRegions, Region } from "../types.ts";

export const BEAT_GAP_MS = 1200; // next action must start within this of last activity
export const BEAT_SPREAD_FRAC = 0.35; // ... and within this x diagonal of the first action point
export const RESULT_MIN_AREA = 0.005;
export const RESULT_AFTER_MS = 1500;
export const IDLE_GAP_MS = 2000;
export const MERGE_SHORT_MS = 800;
export const MAX_BEATS_PER_MIN = 30;

type CutAction = Extract<Action, { k: "cut" }>;

export function actStart(a: Action): number {
  return a.k === "click" || a.k === "shortcut" || a.k === "focus" || a.k === "cut" ? a.t : a.t0;
}

export function actEnd(a: Action): number {
  return a.k === "click" || a.k === "shortcut" || a.k === "focus" || a.k === "cut" ? a.t : a.t1;
}

function actPoint(a: Action): [number, number] | null {
  switch (a.k) {
    case "click":
    case "dwell":
      return [a.x, a.y];
    case "drag":
    case "travel":
      return a.to;
    case "scroll":
      return [a.x, a.y];
    default:
      return null;
  }
}

/** The beat kind is the dominant action's: longest, first on a tie. */
function dominantKind(actions: Action[]): BeatKind {
  let best = actions[0]!;
  let bestDur = -1;
  for (const a of actions) {
    const d = actEnd(a) - actStart(a);
    if (d > bestDur) {
      bestDur = d;
      best = a;
    }
  }
  const k = best.k;
  if (k === "focus") return "click"; // a lone focus change behaves like pointing
  return k as BeatKind;
}

interface RawBeat {
  t0: number;
  t1: number;
  anchor_t: number;
  anchorPt: [number, number] | null;
  window_cls: string;
  actions: Action[];
}

/**
 * Segment actions into beats.
 * `stream` gives the frame size for the 0.35 x diagonal spread rule; `takeMs`
 * is the take duration used by the 30-beats-per-minute cap.
 */
export function segmentBeats(
  actions: Action[],
  frames: FrameRegions[],
  o: { stream: { w: number; h: number }; takeMs: number },
): Beat[] {
  const diag = Math.hypot(o.stream.w, o.stream.h);
  const cuts = actions.filter((a): a is CutAction => a.k === "cut");
  const acts = actions.filter((a) => a.k !== "cut");

  // walk actions and cuts in time order; a cut always closes the beat and
  // starts a cut beat; a gap >= IDLE_GAP_MS becomes an idle beat
  const raws: RawBeat[] = [];
  let cur: RawBeat | null = null;
  let lastEnd = -Infinity;
  const ai = acts[Symbol.iterator]();
  let nextAct: IteratorResult<Action>;
  let nextCut = 0;
  nextAct = ai.next();
  while (!nextAct.done || nextCut < cuts.length) {
    const useCut =
      nextCut < cuts.length &&
      (nextAct.done || cuts[nextCut]!.t <= actStart(nextAct.value));
    if (useCut) {
      const c = cuts[nextCut++]!;
      cur = null; // a cut always starts a new beat
      raws.push({
        t0: c.t,
        t1: c.t,
        anchor_t: c.t,
        anchorPt: null,
        window_cls: "",
        actions: [c],
      });
      lastEnd = c.t;
      continue;
    }
    const a = nextAct.value;
    nextAct = ai.next();
    const t = actStart(a);
    const pt = actPoint(a);
    const cutBetween = cuts.some((c) => c.t > (cur ? cur.t1 : lastEnd) && c.t < t);
    const canExtend =
      cur !== null &&
      !cutBetween &&
      t - cur.t1 <= BEAT_GAP_MS &&
      a.window_cls === cur.window_cls &&
      (!pt ||
        !cur.anchorPt ||
        Math.hypot(pt[0] - cur.anchorPt[0], pt[1] - cur.anchorPt[1]) <=
          diag * BEAT_SPREAD_FRAC);
    if (canExtend) {
      cur!.actions.push(a);
      cur!.t1 = Math.max(cur!.t1, actEnd(a));
    } else {
      if (cur && t - cur.t1 >= IDLE_GAP_MS) {
        raws.push({
          t0: cur.t1,
          t1: t,
          anchor_t: cur.t1,
          anchorPt: null,
          window_cls: cur.window_cls,
          actions: [],
        });
        lastEnd = t;
      }
      cur = {
        t0: t,
        t1: Math.max(actEnd(a), t),
        anchor_t: t,
        anchorPt: pt,
        window_cls: a.window_cls,
        actions: [a],
      };
      raws.push(cur);
    }
    lastEnd = Math.max(lastEnd, actEnd(a));
  }

  // cut beats extend to the start of the next beat
  for (let i = 0; i < raws.length; i++) {
    const r = raws[i]!;
    if (r.actions.length === 1 && r.actions[0]!.k === "cut") {
      const next = raws[i + 1];
      r.t1 = Math.max(next ? next.t0 : r.t0 + 1000, r.t0 + 400);
    }
  }

  // merge beats shorter than MERGE_SHORT_MS into the previous beat when the
  // window is the same, otherwise into the next beat. Cut and idle beats never
  // merge: a cut beat is a cut, an idle beat is breathing room. Repeats until
  // no short beat can merge (folding can expose another short beat).
  const isCutBeat = (r: RawBeat) => r.actions.length === 1 && r.actions[0]!.k === "cut";
  const isMergable = (r: RawBeat) => !isCutBeat(r) && r.actions.length > 0;
  const merged: RawBeat[] = [...raws];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < merged.length; i++) {
      const r = merged[i]!;
      if (!isMergable(r) || r.t1 - r.t0 >= MERGE_SHORT_MS) continue;
      const prev = merged[i - 1];
      const next = merged[i + 1];
      if (prev && isMergable(prev) && prev.window_cls === r.window_cls) {
        prev.actions.push(...r.actions);
        prev.t1 = Math.max(prev.t1, r.t1);
        merged.splice(i, 1);
      } else if (next && isMergable(next)) {
        next.actions.unshift(...r.actions);
        next.t0 = r.t0;
        next.anchor_t = r.anchor_t;
        next.anchorPt = r.anchorPt ?? next.anchorPt;
        merged.splice(i, 1);
      } else if (prev && isMergable(prev)) {
        prev.actions.push(...r.actions);
        prev.t1 = Math.max(prev.t1, r.t1);
        merged.splice(i, 1);
      } else {
        continue; // nothing to merge into; keep it
      }
      changed = true;
      i--; // recheck this position
    }
  }

  // hard cap 30 beats per minute: merge the adjacent same-window pair with the
  // smallest combined duration. A cap must always be enforceable, so when no
  // same-window pair remains, the smallest pair regardless.
  // ponytail: quadratic rescan; beats are bounded by the cap so this is tiny.
  const cap = Math.max(1, Math.ceil((o.takeMs / 60000) * MAX_BEATS_PER_MIN));
  while (merged.length > cap && merged.length > 1) {
    let bi = -1;
    let bd = Infinity;
    for (const sameWindowOnly of [true, false]) {
      for (let i = 0; i + 1 < merged.length; i++) {
        const a = merged[i]!;
        const b = merged[i + 1]!;
        if (isCutBeat(a) || isCutBeat(b)) continue;
        if (sameWindowOnly && a.window_cls !== b.window_cls) continue;
        const d = b.t1 - a.t0;
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      if (bi >= 0) break;
    }
    if (bi < 0) break; // only cut beats left; leave them
    const a = merged[bi]!;
    const b = merged[bi + 1]!;
    a.actions.push(...b.actions);
    a.t1 = b.t1;
    merged.splice(bi + 1, 1);
  }

  const beats: Beat[] = merged.map((r, i) => ({
    id: `b${i + 1}`,
    t0: r.t0,
    t1: r.t1,
    anchor_t: r.anchor_t,
    window_cls: r.window_cls,
    actions: r.actions,
    zones: [],
    kind: r.actions.length === 0 ? "idle" : isCutBeat(r) ? "cut" : dominantKind(r.actions),
  }));

  // result attachment: change regions of area_frac >= RESULT_MIN_AREA beginning
  // within RESULT_AFTER_MS after the beat's last action, even far away
  for (const b of beats) {
    if (b.kind === "idle" || b.kind === "cut") continue;
    b.results = attachedResults(frames, actEnd(b.actions[b.actions.length - 1]!), b.t1 + RESULT_AFTER_MS);
    if (b.results.length === 0) delete b.results;
  }

  return beats;
}

/** Change regions beginning within [fromT, untilT], area >= RESULT_MIN_AREA, largest first. */
export function attachedResults(frames: FrameRegions[], fromT: number, untilT: number): Region[] {
  const out: { r: Region; t: number }[] = [];
  for (const f of frames) {
    if (f.t < fromT || f.t > untilT) continue;
    for (const r of f.regions) {
      if (r.area_frac >= RESULT_MIN_AREA) out.push({ r, t: f.t });
    }
  }
  return out.sort((a, b) => b.r.area_frac - a.r.area_frac).map((x) => x.r);
}

/** The largest attached result region's bbox, or null. */
export function resultBBox(beat: Beat): BBox | null {
  return beat.results?.reduce<Region | null>((best, r) => !best || r.area_frac > best.area_frac ? r : best, null)?.bbox ?? null;
}

/** The first-change time of the beat's attached results, or null. */
export function resultTime(beat: Beat, frames: FrameRegions[]): number | null {
  const rs = beat.results;
  if (!rs || rs.length === 0) return null;
  const lastEnd = beat.actions.length > 0 ? actEnd(beat.actions[beat.actions.length - 1]!) : beat.t1;
  for (const f of frames) {
    if (f.t < lastEnd || f.t > beat.t1 + RESULT_AFTER_MS) continue;
    if (f.regions.some((r) => rs.includes(r))) return f.t;
  }
  return null;
}
