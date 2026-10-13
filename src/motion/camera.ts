import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { clippedFractions, HIGH_CLIP_FRACTION, LABEL_AREA_MAX, wholeCrop } from "../camera/solver.ts";
import type { CameraFrame } from "../camera/types.ts";
import { detectUiBoxes } from "../perceive/boxes.ts";
import { edgeCuts } from "../render/framing.ts";
import { bentoViewport, bitmapSize, heroSize, heroTransform } from "./geometry.ts";
import { allTimelines } from "./layout.ts";
import { readingFloor } from "./storyboard.ts";
import { motionTokens } from "./theme.ts";
import type { Rect, Storyboard } from "./types.ts";

export function cameraViewport(sb: Storyboard, list: number) {
  const tokens = motionTokens(sb.theme.name, sb.theme.overrides);
  const { out_w: W, out_h: H } = sb.output;
  if (sb.layout.kind === "single") return {width:W,height:H};
  return bentoViewport(W, H, tokens, sb.layout.grid, list);
}

export interface TourStop { rect: Rect; caption?: string; hold?: number }

type View = { x: number; y: number; w: number; h: number };
/** Keeps a whole view, else moves it to the tightest whole framing at its aspect that holds the subject. */
export type Snap = (view: View, subject: Rect, what: string) => View;

/** Whole-UI framing on one screen image, as make frames recordings: its UI boxes (cards, fields,
 *  buttons) stay whole or out, and no edge runs through a word or control (the edge check).
 *  A view no framing up to the whole screen can clean stays as planned, with a warning. */
export function screenSnap(file: string, width: number, height: number): Snap {
  const grey = (w: number, h: number) => new Uint8Array(execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-i", file,
    "-vf", `scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"], { maxBuffer: w * h + 1024, timeout: 60000 }));
  const qw = Math.floor(width / 4), qh = Math.floor(height / 4);
  const boxes = detectUiBoxes(grey(qw, qh), qw, qh, width, height).filter(b => b[2] * b[3] <= width * height * LABEL_AREA_MAX);
  const cuts = edgeCuts([grey(width, height)], width, height);
  return (view, subject, what) => {
    if (!cuts(view) && clippedFractions(view, boxes).every(f => f === 0 || f >= HIGH_CLIP_FRACTION)) return view;
    const aspect = view.w / view.h;
    const crop = wholeCrop(view.w, Math.min(width, height * aspect), aspect, subject, boxes, width, height, c => cuts(c) === 0);
    if (crop) return { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
    console.warn(`motion: no framing of ${what} keeps every word and control whole; keeping the planned one`);
    return view;
  };
}

/** Bounded zoom-tour segments for stops on a screen, plus the bitmap size and the exact
 *  scene duration the moves and reading holds need. Shared by the renderer and the planner
 *  so planned durations never guess. */
export function tourSegments(screen: { width: number; height: number }, width: number, height: number,
  stops: TourStop[], minShot: number, snap?: Snap): { segments: { at: number; d: number; from: { x: number; y: number; w: number; h: number }; to: { x: number; y: number; w: number; h: number }; caption: string }[]; size: { width: number; height: number }; need: number } {
  const full = { x: 0, y: 0, w: screen.width, h: screen.height };
  const requested = Math.min(width * .88, height * .65 * screen.width / screen.height);
  const size = bitmapSize(screen, requested, requested * screen.height / screen.width);
  const holds = stops.map(s => Math.max(minShot, s.hold ?? 0, readingFloor(s.caption ?? "")));
  const aspect = screen.width / screen.height;
  const targets = stops.map((s, j) => {
    // Fit the region width: settled close-ups magnify never past 1 output px per source px
    // (the max_upscale camera gate), so screen text stays sharp at the settled hold.
    const w = Math.min(screen.width, Math.max(s.rect[2] * 1.05, size.width));
    const h = w / aspect;
    // Close-ups (view shorter than region) anchor to the region top so column headers and
    // card tops stay whole and the cut falls on lower content; wider views stay centred.
    const y = h < s.rect[3] ? Math.max(0, Math.min(screen.height - h, s.rect[1]))
      : Math.max(0, Math.min(screen.height - h, s.rect[1] + s.rect[3] / 2 - h / 2));
    const view = { x: Math.max(0, Math.min(screen.width - w, s.rect[0] + s.rect[2] / 2 - w / 2)), y, w, h };
    // Snapped close-ups keep the region's width from its top; wider views keep all of it.
    return snap ? snap(view, h < s.rect[3] ? [s.rect[0], s.rect[1], s.rect[2], 0] : s.rect, `tour stop ${j + 1}`) : view;
  });
  const segments: { at: number; d: number; from: typeof full; to: typeof full; caption: string }[] = [];
  let at = .4, from = full;
  // Tours end on their last stop and cut to the next beat; the pull-back is the next scene opening full.
  [...targets].forEach((to, j) => {
    const dw = to.w - from.w, minW = Math.min(from.w, to.w);
    const ratio = Math.abs(dw) / minW;
    const pan = size.width * Math.hypot((to.x - from.x) * from.w - from.x * dw, (to.y - from.y) * from.w - from.y * dw) / (minW * minW);
    const d = Math.max(1.4, 1.875 * ratio, Math.sqrt((5.774 * ratio + 3.516 * ratio * ratio) / 4), Math.sqrt(pan * (5.774 + 7.032 * ratio) / 9000));
    segments.push({ at, d, from, to, caption: stops[j]?.caption ?? "" });
    at += d + (holds[j] ?? 0);
    from = to;
  });
  return { segments, size, need: at };
}

export function sceneCameras(sb: Storyboard, dir?: string): Record<string, (CameraFrame & { caption?: string; output?: CameraFrame })[]> {
  const paths: Record<string, (CameraFrame & { caption?: string; output?: CameraFrame })[]> = {};
  const minShot = motionTokens(sb.theme.name, sb.theme.overrides).min_shot;
  const lists = allTimelines(sb.layout, sb.scenes);
  // Tour stops snap to whole UI on their screen image (one analysis per screen) when it is on disk.
  const snaps = new Map<string, Snap>();
  const snapOf = (id: string): Snap | undefined => {
    const s = sb.screens[id];
    if (!dir || !s) return undefined;
    if (!snaps.has(id)) snaps.set(id, screenSnap(isAbsolute(s.file) ? s.file : resolve(dir, s.file), s.width, s.height));
    return snaps.get(id);
  };
  lists.forEach((scenes, list) => scenes.forEach((scene, i) => {
    if (scene.pattern !== "zoom-tour" && scene.pattern !== "hero-reveal") return;
    const screen = sb.screens[scene.screen ?? Object.keys(sb.screens)[0]!]!;
    if (!screen) throw new Error(`${scene.pattern}: screen missing`);
    const key = sb.layout.kind === "single" ? String(i) : sb.layout.grid === "2x2" ? `master:${i}` : `${["A", "B", "C", "D"][list]}:${i}`;
    const {width,height} = cameraViewport(sb,list);
    if (scene.pattern === "hero-reveal") {
      const push = scene.push ?? .03;
      const need = .6 + Math.max(1.875 * push, Math.sqrt((5.774 * push + 3.516 * push * push) / 4));
      if (scene.d < need) throw new Error(`hero-reveal.d: needs ${need.toFixed(2)} s for bounded push`);
      const border = scene.device === "laptop" ? 12 : 2;
      const size = heroSize(screen, scene, width, height);
      // Phone shows the whole screen (contain-fit, as the device frame renders it):
      // min-fit maps the letterboxed film back onto the screen; crop terms go negative.
      const fit = scene.device === "phone" ? Math.min(size.width / screen.width, size.height / screen.height) : size.width / screen.width;
      const region = scene.focus ? sb.regions.find(r => r.id === scene.focus) : undefined;
      const ox = region ? (region.rect[0] + region.rect[2] / 2) / screen.width : .5;
      const oy = region ? (region.rect[1] + region.rect[3] / 2) / screen.height : .5;
      const bar = scene.device === "phone" ? size.height * .045 : (scene.device ?? "browser") === "browser" ? size.height * .075 : 0;
      const cropX = (screen.width * fit - size.width) / 2, cropY = (screen.height * fit - size.height) / 2;
      paths[key] = Array.from({ length: Math.ceil(scene.d * sb.output.fps) + 1 }, (_, f) => {
        const t = f / sb.output.fps, p = heroTransform(t, scene.d, scene.push ?? .03);
        const left = (width - size.width) / 2 + (size.width + 2 * border) * ox * (1 - p.scale) + border * p.scale;
        const top = height * .34 + p.y + (size.height + bar + 2 * border) * oy * (1 - p.scale) + (bar + border) * p.scale;
        return { t, x: (cropX * p.scale - left) / (fit * p.scale), y: (cropY * p.scale - top) / (fit * p.scale), w: width / (fit * p.scale), h: height / (fit * p.scale) };
      });
      return;
    }
    const full = { x: 0, y: 0, w: screen.width, h: screen.height };
    const stops = scene.stops ?? [];
    const owner = scene.screen ?? Object.keys(sb.screens)[0];
    const rects = stops.map(s => {
      const r = sb.regions.find(r => r.id === s.region)!;
      if (r.screen !== owner) throw new Error("zoom-tour: stops must belong to the scene screen");
      return { rect: r.rect, caption: s.caption, hold: s.hold };
    });
    let tour = tourSegments(screen, width, height, rects, minShot, snapOf(owner!));
    // The plan timed the unsnapped stops (it never reads pixels); a snapped tour that needs
    // longer falls back to the planned stops, whole or not, rather than failing the render.
    // ponytail: all-or-nothing per scene; snap per stop within d if this ever fires.
    if (scene.d + 1e-9 < tour.need && snapOf(owner!)) {
      console.warn(`motion: whole-UI stops of scene ${i + 1} need ${tour.need.toFixed(2)} s, more than its ${scene.d} s; using the planned stops, which may cut UI`);
      tour = tourSegments(screen, width, height, rects, minShot);
    }
    const { segments, size, need } = tour;
    if (scene.d + 1e-9 < need) throw new Error(`zoom-tour.d: needs ${need.toFixed(2)} s for bounded moves and reading holds`);
    paths[key] = Array.from({ length: Math.ceil(scene.d * sb.output.fps) + 1 }, (_, f) => {
      const t = f / sb.output.fps;
      let view = full, caption = "";
      for (const segment of segments) {
        if (t < segment.at) break;
        const u = Math.min(1, (t - segment.at) / segment.d), a = u * u * u * (u * (u * 6 - 15) + 10), { from, to } = segment;
        const w = from.w + (to.w - from.w) * a;
        view = { x: from.x + (to.x - from.x) * a, y: from.y + (to.y - from.y) * a, w, h: w * screen.height / screen.width };
        if (t >= segment.at + segment.d) caption = segment.caption;
      }
      const border = scene.device === "laptop" ? 12 : 2;
      const bar = (scene.device ?? "browser") === "browser" ? size.height * .075 : scene.device === "phone" ? size.height * .045 : 0;
      const left = (width - size.width) / 2 + border, top = height * .08 + border + bar;
      return { t, ...view, caption, output: { t, x: view.x - left * view.w / size.width, y: view.y - top * view.w / size.width, w: width * view.w / size.width, h: height * view.w / size.width } };
    });
  }));
  return paths;
}
