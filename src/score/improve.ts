import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CameraDefaults } from "../camera/defaults.ts";
import type { CameraFrame, ManualZoom, TakeMeta } from "../camera/types.ts";
import { purposefulEnd } from "../render/pace.ts";
import { clickShot, longestHoldFor, pacedBeats, pageShare } from "./measure.ts";
import type { MeasuredFacts, ScoreCard } from "./rubric.ts";

interface SavedAction { k?: string; t?: number; x?: number; y?: number }
interface SavedBeat { actions?: SavedAction[] }

export interface ImproveContext {
  dir: string;
  camera: CameraDefaults;
  meta: TakeMeta;
  writeMeta: () => void;
  /** Render the next round in one pass; false when it already renders in one. */
  singlePass: () => boolean;
  limitations: string[];
  /** The camera path this camera and take would render, solved without rendering a frame. */
  solve: (camera: CameraDefaults, meta: TakeMeta) => Promise<CameraFrame[]>;
}

// The least an action must change before a round is spent on it; an action under its bar is recorded as "no change".
/** Share of the click's result region in the last frame a wider push-in must add. */
const MIN_RESULT_GAIN = 0.05;
/** Share of the output frame a smaller stage margin must add to the page. */
const MIN_PAGE_GAIN = 0.01;
/** Zoom at the click the rubric counts as a push-in. */
const PUSH_IN = 1.1;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function clickAt(dir: string): { t: number; x: number; y: number } | null {
  const beats = JSON.parse(readFileSync(join(dir, "analysis/beats.json"), "utf8")) as SavedBeat[];
  for (const beat of beats) {
    for (const a of beat.actions ?? []) {
      if (a.k === "click" && typeof a.t === "number" && typeof a.x === "number" && typeof a.y === "number") {
        return { t: a.t, x: a.x, y: a.y };
      }
    }
  }
  return null;
}

function clip(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * A take that waits before its first action opens on dead air the warp cannot squeeze (the establishing hold sits
 * there). Start it later, keeping the shortest establishing hold the camera allows plus the push-in's move before
 * that action, and never below the rubric's 3 s short-film floor; taken only when that measurably shortens the
 * longest actionless span.
 */
function openingTrim(ctx: ImproveContext, hold: number, duration: number): string | null {
  const beats = JSON.parse(readFileSync(join(ctx.dir, "analysis/beats.json"), "utf8")) as SavedBeat[];
  const from = ctx.meta.trim_start ?? 0;
  const first = Math.min(...beats.flatMap((b) => b.actions ?? [])
    .flatMap((a) => a.k !== "dwell" && a.k !== "ptr" && typeof a.t === "number" && a.t > from + 0.05 ? [a.t] : []));
  const to = round3(Math.min(first - (ctx.camera.establish_s / 2 + ctx.camera.anchor_early + ctx.camera.move_t_max), from + duration - 3));
  if (!Number.isFinite(to) || to <= from || (ctx.meta.trim_end !== undefined && ctx.meta.trim_end <= to)) return null;
  const next = longestHoldFor(ctx.dir, { ...ctx.meta, trim_start: to }, ctx.camera).span;
  if (next >= hold - 0.1) return null;
  ctx.meta.trim_start = to;
  ctx.writeMeta();
  return `trim the dead opening: start ${from}s -> ${to}s; longest actionless span ${hold.toFixed(2)}s -> ${next.toFixed(2)}s`;
}

async function addClickZoom(ctx: ImproveContext, facts: MeasuredFacts): Promise<string | null> {
  if (facts.zoomAtClick >= 1.1) return null;
  if ((ctx.meta.zooms?.length ?? 0) > 0) {
    // Say only what was measured: the cause (no source pixels to zoom into, framing rules) is not known here.
    ctx.limitations.push(`camera push-in unavailable: with a manual zoom at the click the render still measures ${facts.zoomAtClick.toFixed(2)}x there`);
    return null;
  }
  const click = clickAt(ctx.dir);
  if (!click) return null;
  const width = ctx.meta.width;
  const height = ctx.meta.height;
  const w = Math.round(width / 2 / 2) * 2;
  const h = Math.round(height / 2 / 2) * 2;
  const bbox: [number, number, number, number] = [
    Math.round(clip(click.x - w / 2, 0, width - w)),
    Math.round(clip(click.y - h / 2, 0, height - h)),
    w,
    h,
  ];
  const trimStart = ctx.meta.trim_start ?? 0;
  const beats = JSON.parse(readFileSync(join(ctx.dir, "analysis/beats.json"), "utf8")) as never[];
  const trimEnd = ctx.meta.trim_end ?? purposefulEnd(pacedBeats(ctx.meta, beats), trimStart, ctx.meta.duration ?? 0, ctx.camera);
  const t0 = Math.max(trimStart, click.t - 0.5);
  const t1 = Math.min(trimEnd, Math.max(t0 + 0.5, click.t + 1.5));
  if (t1 - t0 < 0.5) return null;
  const zoom: ManualZoom = { t0: round3(t0), t1: round3(t1), bbox, level: 2 };
  const trial = { ...ctx.meta, zooms: [...(ctx.meta.zooms ?? []).filter((z) => z.t0 !== zoom.t0 || z.t1 !== zoom.t1), zoom] };
  const after = clickShot(ctx.dir, trial, ctx.camera, await ctx.solve(ctx.camera, trial)).zoomAtClick;
  if (after < PUSH_IN) {
    ctx.limitations.push(`no change: a 2x manual zoom at the click still solves to ${after.toFixed(2)}x there (a push-in is ${PUSH_IN}x), so no round was spent on it`);
    return null;
  }
  ctx.meta.zooms = trial.zooms;
  return `push the camera 2x into the click (solved zoom at the click ${facts.zoomAtClick.toFixed(2)}x -> ${after.toFixed(2)}x)`;
}

/** A third wider shot padding, kept only when the solved path then shows measurably more of the click's result. */
async function widenPushIn(ctx: ImproveContext, facts: MeasuredFacts): Promise<string | null> {
  if (facts.resultInFrame === undefined || facts.resultInFrame >= 0.5 || ctx.camera.l2_pad >= 2.4) return null;
  const wider = { ...ctx.camera, l1_pad: round3(ctx.camera.l1_pad * 4 / 3), l2_pad: round3(ctx.camera.l2_pad * 4 / 3), l3_pad: round3(ctx.camera.l3_pad * 4 / 3) };
  const share = async (camera: CameraDefaults) => clickShot(ctx.dir, ctx.meta, camera, await ctx.solve(camera, ctx.meta)).resultInFrame ?? 0;
  const [from, to] = [await share(ctx.camera), await share(wider)];
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  if (to - from < MIN_RESULT_GAIN) {
    ctx.limitations.push(`no change: shot padding ${ctx.camera.l2_pad} -> ${wider.l2_pad} leaves ${pct(to)} of the click's result in the last frame (was ${pct(from)}; needs ${pct(MIN_RESULT_GAIN)} more), so no round was spent on it`);
    return null;
  }
  const was = ctx.camera.l2_pad;
  Object.assign(ctx.camera, { l1_pad: wider.l1_pad, l2_pad: wider.l2_pad, l3_pad: wider.l3_pad });
  return `widen the push-in so the click's result is in frame: shot padding ${was} -> ${wider.l2_pad}; result in the last frame ${pct(from)} -> ${pct(to)}`;
}

/**
 * Up to two build-input changes for the weakest weighted items, best first. Each change is checked before a round is
 * spent on it: a camera change is solved without rendering and kept only when the shot it targets measurably changes, a
 * pacing change only when it shortens the longest actionless span. A change that would leave the film as it is falls
 * through to the next-best item; when none is left the loop stops with no gain instead of re-rendering the same film.
 */
export async function improveRound(card: ScoreCard, facts: MeasuredFacts, ctx: ImproveContext): Promise<string[]> {
  const ranked = card.items
    .filter((item) => item.id !== "baseline" && item.score < 10)
    .sort((a, b) => b.weight * (10 - b.score) - a.weight * (10 - a.score));
  const solved = new Map<string, Promise<CameraFrame[]>>();
  const solve = ctx.solve;
  ctx = { ...ctx, solve: (camera, meta) => {
    const key = JSON.stringify([camera, meta]);
    if (!solved.has(key)) solved.set(key, solve(camera, meta));
    return solved.get(key)!;
  } };
  const actions: string[] = [];
  for (const item of ranked) {
    if (actions.length >= 2) break;
    if (item.id === "page") {
      const from = ctx.camera.stage_margin;
      if (from <= 0) continue;
      // Straight to the full page: any margin left keeps the page under the rubric's 97% share and costs a round.
      const to = 0;
      const [a, b] = [pageShare(ctx.meta, ctx.camera), pageShare(ctx.meta, { ...ctx.camera, stage_margin: to })];
      if (b - a < MIN_PAGE_GAIN) {
        ctx.limitations.push(`no change: stage margin ${(from * 100).toFixed(1)}% -> ${(to * 100).toFixed(1)}% leaves the page at ${(b * 100).toFixed(1)}% of the frame, so no round was spent on it`);
        continue;
      }
      ctx.camera.stage_margin = to;
      actions.push(`enlarge the page: stage margin ${(from * 100).toFixed(1)}% -> ${(to * 100).toFixed(1)}%; page ${(a * 100).toFixed(1)}% -> ${(b * 100).toFixed(1)}% of the frame`);
      continue;
    }
    if (item.id === "interaction") {
      let changed = false;
      if (facts.pointerSamples > 0 && !facts.cursorDrawn && ctx.meta.cursor_free !== true) {
        ctx.meta.cursor_free = true;
        ctx.camera.cursor_size = Math.max(ctx.camera.cursor_size, 1.15);
        ctx.camera.ripple_ms = Math.max(ctx.camera.ripple_ms, 700);
        changed = true;
        actions.push("draw the recorded cursor and hold the click ripple longer");
      }
      const before = ctx.limitations.length;
      // A push-in that ends on the clicked control alone hides what the click did: frame the shots a third wider so the
      // composer can take in the result beside the control.
      const widened = await widenPushIn(ctx, facts);
      if (widened) { changed = true; actions.push(widened); }
      const zoom = await addClickZoom(ctx, facts);
      if (zoom) { changed = true; actions.push(zoom); }
      if (!changed && ctx.limitations.length === before) {
        ctx.limitations.push(facts.pointerSamples === 0
          ? "cursor unavailable: the take has no pointer track; no cursor was invented"
          : "interaction: no further build input can add a visible interaction");
      }
      continue;
    }
    if (item.id === "legibility") {
      if ((ctx.meta.captions?.length ?? 0) > 0 && ctx.camera.caption_size < 34) {
        const from = ctx.camera.caption_size;
        ctx.camera.caption_size = 38;
        actions.push(`raise caption type ${from}px -> 38px`);
      } else if ((ctx.meta.captions?.length ?? 0) === 0) {
        ctx.limitations.push("legibility: this take has no title or captions, so there is no build-input type size to raise; the page is the only text");
      }
      continue;
    }
    if (item.id === "pacing") {
      // Shorten the longest actionless span: play idle gaps twice as fast and keep half the real time around each action.
      // Taken only when the warp measurably shortens that span; footage that is not idle (an opening establishing shot,
      // a move in flight) is recorded as a limitation instead of re-rendered for nothing.
      const trial = { ...ctx.camera, idle_speed: Math.min(16, Math.max(2, ctx.camera.idle_speed * 2)), idle_keep: round3(Math.max(0.4, ctx.camera.idle_keep / 2)) };
      const next = longestHoldFor(ctx.dir, ctx.meta, trial).span;
      if (next < facts.longestHold - 0.1) {
        actions.push(`squeeze idle footage: ${ctx.camera.idle_speed}x -> ${trial.idle_speed}x, ${ctx.camera.idle_keep}s -> ${trial.idle_keep}s kept around each action; longest actionless span ${facts.longestHold.toFixed(2)}s -> ${next.toFixed(2)}s`);
        ctx.camera.idle_speed = trial.idle_speed;
        ctx.camera.idle_keep = trial.idle_keep;
      } else {
        const trimmed = facts.longestHoldAt === 0 ? openingTrim(ctx, facts.longestHold, facts.duration) : null;
        if (trimmed) actions.push(trimmed);
        else ctx.limitations.push(`pacing: the longest actionless span (${facts.longestHold.toFixed(2)}s) is not idle footage the warp can squeeze`);
      }
      continue;
    }
    if (item.id === "determinism") {
      const ratio = facts.determinism.frames === 0 ? 0 : facts.determinism.identical / facts.determinism.frames;
      if (ratio < facts.determinism.tolerance) {
        if (ctx.singlePass()) actions.push("render the next round in one pass for repeatable frames");
        else ctx.limitations.push("no change: the render already runs in one pass, so a re-render cannot make its frames more repeatable");
      }
    }
  }
  if (actions.length) ctx.writeMeta();
  return actions;
}
