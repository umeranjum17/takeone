// Beat segmentation (design 7.1). Pure functions over plain data.

import type { Action, BBox, Beat, BeatKind, FrameRegions, Region } from "../types.ts";
import { bboxIoU, unionBBox } from "../types.ts";

export const BEAT_GAP_MS = 1200; // next action must start within this of last activity
export const BEAT_SPREAD_FRAC = 0.35; // ... and within this x diagonal of the first action point
export const RESULT_MIN_AREA = 0.005;
export const RESULT_AFTER_MS = 1500;
export const IDLE_GAP_MS = 2000;
export const MERGE_SHORT_MS = 800;
export const MAX_BEATS_PER_MIN = 30;
export const CUT_SETTLE_FRAC = 0.05;
export const CUT_SETTLE_MS = 300;

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
  o: { stream: { w: number; h: number }; takeMs: number; startMs?: number; endMs?: number },
): Beat[] {
  const diag = Math.hypot(o.stream.w, o.stream.h);
  const cutEnd = (t: number): number => {
    let quietStart: number | null = null;
    for (const frame of scopedFrames) {
      if (frame.t < t) continue;
      quietStart = frame.changed_frac < CUT_SETTLE_FRAC ? quietStart ?? frame.t : null;
      if (quietStart !== null && frame.t - quietStart >= CUT_SETTLE_MS) return frame.t;
    }
    return o.endMs ?? o.takeMs;
  };

  // Walk actions and cuts in time order. Cuts inside an action are discarded;
  // long gaps form idle beats unless the hard beat cap later merges them.
  const raws: RawBeat[] = [];
  let cur: RawBeat | null = null;
  let activeWindow = "";
  const appendIdle = (t: number) => {
    const from = cur?.t1 ?? o.startMs;
    if (from !== undefined && t - from >= IDLE_GAP_MS) {
      raws.push({ t0: from, t1: t, anchor_t: from, anchorPt: null, window_cls: cur?.window_cls ?? activeWindow, actions: [] });
    }
  };
  const start = o.startMs ?? -Infinity;
  const end = o.endMs ?? Infinity;
  const scopedFrames = frames.filter((frame) => frame.t >= start && frame.t <= end);
  const scoped = actions.filter((a) => actStart(a) >= start && actStart(a) <= end).map((a): Action => {
    if (!("t1" in a)) return a;
    const bounded = { ...a, t1: Math.min(a.t1, end) };
    if (bounded.k !== "type" || !bounded.region) return bounded;
    let region: BBox | undefined;
    for (const frame of scopedFrames) {
      if (frame.t < bounded.t0 || frame.t > bounded.t1) continue;
      for (const change of frame.regions) {
        if (bboxIoU(change.bbox, bounded.region) > 0) region = region ? unionBBox(region, change.bbox) : change.bbox;
      }
    }
    const { region: _whole, ...rest } = bounded;
    return { ...rest, ...(region ? { region } : {}) };
  });
  const acts = scoped.filter((a) => a.k !== "cut");
  const cuts = scoped.filter((a): a is CutAction => a.k === "cut")
    .filter((c) => !acts.some((a) => actStart(a) < c.t && actEnd(a) > c.t));
  const timeStart = (a: Action) => Math.max(start, actStart(a));
  const timeEnd = (a: Action) => Math.min(end, actEnd(a));
  let nextAct = 0;
  let nextCut = 0;
  while (nextAct < acts.length || nextCut < cuts.length) {
    const useCut =
      nextCut < cuts.length &&
      (nextAct >= acts.length || cuts[nextCut]!.t <= timeStart(acts[nextAct]!));
    if (useCut) {
      const c = cuts[nextCut++]!;
      const settled = cutEnd(c.t);
      appendIdle(c.t);
      activeWindow = c.window_cls ?? activeWindow;
      cur = {
        t0: c.t,
        t1: settled,
        anchor_t: c.t,
        anchorPt: null,
        window_cls: activeWindow,
        actions: [c],
      };
      raws.push(cur);
      continue;
    }
    const a = acts[nextAct++]!;
    const t = timeStart(a);
    const pt = actPoint(a);
    const windowCls = a.k === "focus" ? a.cls : a.window_cls ?? activeWindow;
    activeWindow = windowCls;
    const canExtend =
      cur !== null &&
      cur.actions[0]?.k !== "cut" &&
      t - cur.t1 <= BEAT_GAP_MS &&
      windowCls === cur.window_cls &&
      (!pt ||
        !cur.anchorPt ||
        Math.hypot(pt[0] - cur.anchorPt[0], pt[1] - cur.anchorPt[1]) <=
          diag * BEAT_SPREAD_FRAC);
    if (canExtend) {
      cur!.actions.push(a);
      cur!.t1 = Math.max(cur!.t1, timeEnd(a));
    } else {
      appendIdle(t);
      cur = {
        t0: t,
        t1: Math.max(timeEnd(a), t),
        anchor_t: t,
        anchorPt: pt,
        window_cls: windowCls,
        actions: [a],
      };
      raws.push(cur);
    }
  }

  if (o.endMs !== undefined) appendIdle(o.endMs);

  for (let i = 0; i + 1 < raws.length; i++) {
    const r = raws[i]!;
    if (r.actions[0]?.k === "cut") r.t1 = Math.min(r.t1, raws[i + 1]!.t0);
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

  // Hard cap 30 beats per minute, even over idle/cut boundaries: merge the
  // adjacent same-window pair with the smallest combined duration. A cap must always be enforceable, so when no
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
        if (sameWindowOnly && (isCutBeat(a) || isCutBeat(b) || a.window_cls !== b.window_cls)) continue;
        const d = b.t1 - a.t0;
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      if (bi >= 0) break;
    }
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
    kind: r.actions.length === 0 ? "idle" : r.actions.some((a) => a.k === "cut") ? "cut" : dominantKind(r.actions),
  }));

  // result attachment: change regions of area_frac >= RESULT_MIN_AREA beginning
  // within RESULT_AFTER_MS after the beat's last action, even far away
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i]!;
    if (b.kind === "idle" || b.kind === "cut") continue;
    const lastAction = timeEnd(b.actions[b.actions.length - 1]!);
    const nextAction = beats.slice(i + 1).flatMap((next) => next.actions).map(timeStart).find((t) => t >= lastAction);
    b.results = attachedResults(scopedFrames, lastAction, Math.min(lastAction + RESULT_AFTER_MS, nextAction === undefined ? end : nextAction - 1));
    if (b.results.length === 0) delete b.results;
  }

  return beats;
}

/** Change regions beginning within [fromT, untilT], area >= RESULT_MIN_AREA, largest first. */
export function attachedResults(frames: FrameRegions[], fromT: number, untilT: number): Region[] {
  const out: Region[] = [];
  for (const f of frames) {
    if (f.t < fromT || f.t > untilT) continue;
    for (const r of f.regions) {
      if (r.area_frac >= RESULT_MIN_AREA) out.push(r);
    }
  }
  return out.sort((a, b) => b.area_frac - a.area_frac);
}

/** The largest attached result region's bbox, or null. */
export function resultBBox(beat: Beat): BBox | null {
  return beat.results?.[0]?.bbox ?? null;
}

/** The first-change time of the largest attached result region, or null. */
export function resultTime(beat: Beat, frames: FrameRegions[]): number | null {
  const largest = beat.results?.[0];
  if (!largest) return null;
  return frames.find((f) => f.regions.includes(largest))?.t ?? null;
}
