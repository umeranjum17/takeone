// Heuristic decision policy (design 8.3): the pre-pass, --no-jev mode, and the
// per-beat fallback on any Jev failure. Pure functions over plain data.

import type { Beat, Decision, Tightness } from "../types.ts";

/**
 * The heuristic policy for one beat. `viewport` is the bbox of the shot the
 * viewer is looking at when the beat starts (the previous beat's final framing,
 * or the whole screen for the first beat); "fits" means inside with an 8% margin.
 */
export function heuristicDecision(
  beat: Beat,
  ctx: { viewport: BBoxFits | null },
): Decision {
  const A = heuristicA(beat);
  const B = heuristicB(beat, A);
  const L: Tightness = beat.kind === "idle" && beat.t1 - beat.t0 > 3000 ? 0 : heuristicL(beat.kind);
  const aZone = beat.zones.find((z) => z.name === A);
  const p = !ctx.viewport || (aZone && bboxFitsViewport(aZone.bbox, ctx.viewport, 0.08)) ? 0 : 1;
  return {
    beat: beat.id,
    A,
    B,
    L,
    p,
    K: 1,
    conf: {},
    decided_by: "heuristic",
  };
}

export type BBoxFits = { bbox: [number, number, number, number] };

function heuristicA(beat: Beat): string {
  const z = (k: string) => beat.zones.find((x) => x.kind === k);
  switch (beat.kind) {
    case "change":
      return z("res")?.name ?? z("all")!.name;
    case "click":
    case "dwell":
    case "shortcut":
      return z("act")?.name ?? z("win")?.name ?? z("all")!.name;
    case "type":
      return z("txt")?.name ?? z("act")?.name ?? z("win")?.name ?? z("all")!.name;
    case "drag":
    case "travel":
      return z("path")?.name ?? z("act")?.name ?? z("win")?.name ?? z("all")!.name;
    case "scroll":
    case "cut":
      return z("win")?.name ?? z("all")!.name;
    case "idle":
      return z("win")?.name ?? z("all")!.name;
  }
}

function heuristicB(beat: Beat, A: string): string {
  const res = beat.zones.find((x) => x.kind === "res");
  if (res && (beat.kind === "click" || beat.kind === "dwell" || beat.kind === "shortcut")) {
    return res.name;
  }
  return A;
}

function heuristicL(kind: Beat["kind"]): Tightness {
  switch (kind) {
    case "change":
      return 2;
    case "click":
    case "dwell":
    case "shortcut":
    case "type":
      return 2;
    case "drag":
    case "travel":
    case "scroll":
    case "cut":
      return 1;
    case "idle":
      return 0;
  }
}

/**
 * Whether the zone's bbox fits the viewport bbox with `margin` (fraction of the
 * viewport size added on each side).
 */
export function bboxFitsViewport(
  bbox: [number, number, number, number],
  viewport: BBoxFits,
  margin: number,
): boolean {
  const [vx, vy, vw, vh] = viewport.bbox;
  const [zx, zy, zw, zh] = bbox;
  const mx = vw * margin;
  const my = vh * margin;
  return zx >= vx - mx && zy >= vy - my && zx + zw <= vx + vw + mx && zy + zh <= vy + vh + my;
}
