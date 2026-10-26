import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CameraDefaults } from "../camera/defaults.ts";
import type { ManualZoom, TakeMeta } from "../camera/types.ts";
import { purposefulEnd } from "../render/pace.ts";
import type { MeasuredFacts, ScoreCard } from "./rubric.ts";

interface SavedAction { k?: string; t?: number; x?: number; y?: number }
interface SavedBeat { actions?: SavedAction[] }

export interface ImproveContext {
  dir: string;
  camera: CameraDefaults;
  meta: TakeMeta;
  writeMeta: () => void;
  singlePass: () => void;
  limitations: string[];
}

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

function addClickZoom(ctx: ImproveContext, facts: MeasuredFacts): string | null {
  if (facts.zoomAtClick >= 1.1) return null;
  if ((ctx.meta.zooms?.length ?? 0) > 0) {
    ctx.limitations.push("camera push-in unavailable: the no-cut-text camera guard widened the manual zoom back to the whole page");
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
  const trimEnd = ctx.meta.trim_end ?? purposefulEnd(beats, trimStart, ctx.meta.duration ?? 0, ctx.camera);
  const t0 = Math.max(trimStart, click.t - 0.5);
  const t1 = Math.min(trimEnd, Math.max(t0 + 0.5, click.t + 1.5));
  if (t1 - t0 < 0.5) return null;
  const zoom: ManualZoom = { t0: round3(t0), t1: round3(t1), bbox, level: 2 };
  ctx.meta.zooms = [...(ctx.meta.zooms ?? []).filter((z) => z.t0 !== zoom.t0 || z.t1 !== zoom.t1), zoom];
  return "push the camera 2x into the click";
}

export async function improveRound(card: ScoreCard, facts: MeasuredFacts, ctx: ImproveContext): Promise<string[]> {
  const ranked = card.items
    .filter((item) => item.id !== "baseline" && item.score < 10)
    .sort((a, b) => b.weight * (10 - b.score) - a.weight * (10 - a.score));
  const actions: string[] = [];
  for (const item of ranked.slice(0, 2)) {
    if (actions.length >= 2) break;
    if (item.id === "page") {
      const from = ctx.camera.stage_margin;
      if (from <= 0) continue;
      const to = from >= 0.03 ? round3(from * 0.4) : 0;
      if (to === from) continue;
      ctx.camera.stage_margin = to;
      actions.push(`enlarge the page: stage margin ${(from * 100).toFixed(1)}% -> ${(to * 100).toFixed(1)}%`);
      continue;
    }
    if (item.id === "interaction") {
      let changed = false;
      if (facts.pointerSamples > 0 && ctx.meta.cursor_free !== true) {
        ctx.meta.cursor_free = true;
        ctx.camera.cursor_size = Math.max(ctx.camera.cursor_size, 1.15);
        ctx.camera.ripple_ms = Math.max(ctx.camera.ripple_ms, 700);
        changed = true;
        actions.push("draw the recorded cursor and hold the click ripple longer");
      }
      const before = ctx.limitations.length;
      const zoom = addClickZoom(ctx, facts);
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
      if (facts.longestHold > 2.5 && ctx.camera.idle_speed > 1) {
        const from = ctx.camera.idle_speed;
        ctx.camera.idle_speed = from - 1;
        actions.push(`play idle gaps ${from}x -> ${ctx.camera.idle_speed}x faster`);
      }
      continue;
    }
    if (item.id === "determinism") {
      const ratio = facts.determinism.frames === 0 ? 0 : facts.determinism.identical / facts.determinism.frames;
      if (ratio < facts.determinism.tolerance) {
        ctx.singlePass();
        actions.push("render the next round in one pass for repeatable frames");
      }
    }
  }
  if (actions.length) ctx.writeMeta();
  return actions;
}
