// Candidate zones per beat (design 7.2) and their word descriptions.
// Pure functions over plain data. Descriptions never contain digits.

import type { Action, Beat, BBox, FrameRegions, Region, TakeMeta, Zone, ZoneDesc, ZoneKind } from "../types.ts";
import { bboxArea, bboxIoU, clampBBox, screenArea, unionBBox } from "../types.ts";
import { actEnd, actStart, resultBBox, resultTime } from "./segment.ts";

export const ACT_PAD_LOGICAL: [number, number] = [40, 28]; // logical px, x scale
export const MAX_ZONES = 6;
export const DEDUPE_IOU = 0.6;
export const RES_IOU_MAX = 0.3; // res exists only when IoU against act is below this
export const SMALL_REGION_AREA = 0.03; // change regions under 3% unite into act
export const ACT_REGION_MS = 500; // ... and begin within 0.5 s of the action
export const PANEL_MAX_AREA = 0.5; // a larger region holding a click is the panel it opened, up to half the screen
export const WIN_MAX_COVER = 0.9; // window zone skipped when it covers more of the screen
export const OCR_MAX_AREA = 0.25; // screen text only read for zones under 25%

// ---------------------------------------------------------------- zone bboxes

/**
 * Compute the candidate zones for one beat.
 * `winRect` is the focused window rect at the beat's anchor (from events.jsonl);
 * `stream` is the video size; `scale` maps logical to stream px;
 * `frames` are the perception regions (analysis/regions.json).
 */
export function zonesForBeat(
  beat: Beat,
  o: { winRect: BBox | null; stream: { w: number; h: number }; scale: number; frames: FrameRegions[] },
): Zone[] {
  const screen = screenArea(o.stream);
  const cands: { kind: ZoneKind; bbox: BBox; t?: number }[] = [];

  const act = actZone(beat, o, screen);
  if (act) cands.push({ kind: "act", ...act });

  const txt = txtZone(beat, o.scale);
  if (txt) cands.push({ kind: "txt", bbox: txt.bbox, t: txt.t });

  const path = pathZone(beat);
  if (path) cands.push({ kind: "path", bbox: path.bbox });

  const res = resZone(beat, act?.bbox ?? null, screen, o.frames);
  if (res) cands.push({ kind: "res", ...res });

  if (o.winRect) {
    const w = clampBBox(o.winRect, o.stream.w, o.stream.h);
    if (w && bboxArea(w) / screen <= WIN_MAX_COVER) cands.push({ kind: "win", bbox: w });
  }
  cands.push({ kind: "all", bbox: [0, 0, o.stream.w, o.stream.h] });

  // dedupe: IoU > 0.6 keeps the smaller; then drop degenerate boxes
  const kept: { kind: ZoneKind; bbox: BBox; t?: number }[] = [];
  for (const c of cands) {
    const clamped = clampBBox(c.bbox, o.stream.w, o.stream.h);
    if (!clamped) continue;
    const dup = kept.findIndex((k) => c.kind !== "all" && k.kind !== "all" && bboxIoU(k.bbox, clamped) > DEDUPE_IOU);
    if (dup >= 0) {
      if (bboxArea(clamped) < bboxArea(kept[dup]!.bbox)) kept[dup] = { ...c, bbox: clamped };
      continue;
    }
    kept.push({ ...c, bbox: clamped });
  }
  kept.sort((a, b) => bboxArea(a.bbox) - bboxArea(b.bbox));

  const limited = kept.length > MAX_ZONES ? [...kept.slice(0, MAX_ZONES - 1), kept[kept.length - 1]!] : kept;
  return limited.map((c, i) => {
    const desc = describeZone(c.kind, c.bbox, beat, o, c.t);
    return {
      name: `z${i + 1}`,
      kind: c.kind,
      bbox: c.bbox,
      ...(c.kind !== "all" && c.kind !== "win" ? { boxes: contextBoxes(beat, o, c.t ?? beat.anchor_t, c.kind) } : {}),
      area_frac: bboxArea(c.bbox) / screen,
      ...(c.t !== undefined ? { t: c.t } : {}),
      desc,
    };
  });
}

/** Keep individual nearby change boxes: their union loses the edges we can frame around. */
function contextBoxes(
  beat: Beat,
  o: { stream: { w: number; h: number }; frames: FrameRegions[] },
  at: number,
  kind: ZoneKind,
): BBox[] {
  const nearby = o.frames.filter((f) => !f.cut && f.t >= beat.t0
    && f.t <= beat.t1 && f.t >= at - ACT_REGION_MS && f.t <= at + ACT_REGION_MS);
  const regions = [...nearby.flatMap((f) => f.regions), ...(kind === "res" ? beat.results ?? [] : [])];
  const boxes = new Map<string, BBox>();
  for (const r of regions) {
    const box = clampBBox(r.bbox, o.stream.w, o.stream.h);
    // Whole-screen redraws and modal scrims provide no local UI boundary.
    if (box && bboxArea(box) <= screenArea(o.stream) * PANEL_MAX_AREA) boxes.set(box.join(","), box);
  }
  return [...boxes.values()];
}

function actZone(
  beat: Beat,
  o: { stream: { w: number; h: number }; scale: number; frames: FrameRegions[] },
  screen: number,
): { bbox: BBox; t?: number } | null {
  const pts: [number, number][] = [];
  let first: number | undefined;
  for (const a of beat.actions) {
    if (a.k === "click") {
      pts.push([a.x, a.y]);
      first ??= a.t;
    } else if (a.k === "dwell") {
      pts.push([a.x, a.y]);
      first ??= a.t0;
    } else if (a.k === "drag") {
      pts.push(a.from, a.to);
      first ??= a.t1;
    } else if (a.k === "shortcut") {
      first ??= a.t; // no position known for a combo
    }
  }
  if (pts.length === 0) return null;
  const t0 = first ?? beat.anchor_t;
  let u: BBox | null = null;
  const px = ACT_PAD_LOGICAL[0] * o.scale;
  const py = ACT_PAD_LOGICAL[1] * o.scale;
  for (const [x, y] of pts) {
    u = u ? unionBBox(u, [x - px, y - py, px * 2, py * 2]) : [x - px, y - py, px * 2, py * 2];
  }
  // unite change regions at the action points within 0.5 s: small ones are a
  // button's pressed state or an opening menu; a larger one holding a click is
  // the panel or dialog that click opened, so the shot keeps all of it
  for (const a of beat.actions) {
    const pt = actPointOf(a);
    const at = actStart(a);
    if (!pt) continue;
    for (const f of o.frames) {
      if (f.cut || f.t < beat.t0 || f.t > beat.t1 || f.t < at - 100 || f.t > at + ACT_REGION_MS) continue;
      for (const r of f.regions) {
        const [rx, ry, rw, rh] = r.bbox;
        if (r.area_frac >= SMALL_REGION_AREA) {
          const panel = a.k === "click" && bboxArea(r.bbox) / screen <= PANEL_MAX_AREA
            && pt[0] >= rx && pt[0] <= rx + rw && pt[1] >= ry && pt[1] <= ry + rh;
          if (panel) u = unionBBox(u!, r.bbox);
          continue;
        }
        if (
          pt[0] >= rx - px && pt[0] <= rx + rw + px &&
          pt[1] >= ry - py && pt[1] <= ry + rh + py
        ) {
          u = unionBBox(u!, r.bbox);
        }
      }
    }
  }
  return u ? { bbox: u, t: t0 } : null;
}

function actPointOf(a: Action): [number, number] | null {
  if (a.k === "click" || a.k === "dwell") return [a.x, a.y];
  if (a.k === "drag") return a.to;
  if (a.k === "scroll") return [a.x, a.y];
  return null;
}

/**
 * Everywhere the beat typed, with the clicks that moved between fields, and any
 * result opening within a control's height of them (the dropdown a field
 * opens): one beat filling a form frames the form, not the first field's caret.
 */
function txtZone(beat: Beat, scale: number): { bbox: BBox; t: number } | null {
  let zone: { bbox: BBox; t: number } | null = null;
  for (const a of beat.actions) {
    if (a.k === "type" && a.region) zone = zone ? { bbox: unionBBox(zone.bbox, a.region), t: zone.t } : { bbox: a.region, t: a.t0 };
  }
  if (!zone) return null;
  for (const a of beat.actions) {
    if (a.k === "click") zone.bbox = unionBBox(zone.bbox, [a.x, a.y, 1, 1]);
  }
  const reach = 2 * ACT_PAD_LOGICAL[1] * scale;
  const [zx, zy, zw, zh] = zone.bbox;
  const near: BBox = [zx - reach, zy - reach, zw + 2 * reach, zh + 2 * reach];
  for (const r of beat.results ?? []) {
    if (r.area_frac <= PANEL_MAX_AREA && bboxIoU(r.bbox, near) > 0) zone.bbox = unionBBox(zone.bbox, r.bbox);
  }
  return zone;
}

function pathZone(beat: Beat): { bbox: BBox } | null {
  for (const a of beat.actions) {
    if (a.k === "drag" || a.k === "travel") return { bbox: a.bbox };
  }
  return null;
}

function resZone(
  beat: Beat,
  actBBox: BBox | null,
  screen: number,
  frames: FrameRegions[],
): { bbox: BBox; t: number } | null {
  const rb = resultBBox(beat);
  if (!rb) return null;
  if (actBBox && bboxIoU(rb, actBBox) >= RES_IOU_MAX) return null;
  return { bbox: rb, t: resultTime(beat, frames) ?? beat.t1 };
}

// ------------------------------------------------------------ word descriptions

const APP_NAMES: Record<string, string> = {
  chromium: "Chromium",
  "google-chrome": "Chrome",
  alacritty: "Alacritty",
  kitty: "Kitty",
  foot: "Foot",
  code: "Code",
  firefox: "Firefox",
};

const SIZE_WORDS: [number, string][] = [
  [0.01, "tiny, about one button or field"],
  [0.05, "small, a group of controls"],
  [0.2, "medium, about a panel or dialog"],
  [0.6, "large, most of the window"],
];

function sizeWords(areaFrac: number): string {
  for (const [lim, words] of SIZE_WORDS) {
    if (areaFrac < lim) return words;
  }
  return "the whole screen";
}

function whereWords(bbox: BBox, stream: { w: number; h: number }): string {
  const cx = bbox[0] + bbox[2] / 2;
  const cy = bbox[1] + bbox[3] / 2;
  const gx = cx < stream.w / 3 ? "left" : cx > (stream.w * 2) / 3 ? "right" : "center";
  const gy = cy < stream.h / 3 ? "top" : cy > (stream.h * 2) / 3 ? "bottom" : "middle";
  if (gx === "center" && gy === "middle") return "center";
  if (gy === "middle") return gx;
  if (gx === "center") return `${gy} center`;
  return `${gy} ${gx}`;
}

/** Quantize a delay in ms to words; descriptions carry no digits. */
export function delayWords(ms: number): string {
  if (ms < 300) return "immediately";
  if (ms < 1000) return "a moment later";
  if (ms < 2000) return "shortly after";
  return "later in the beat";
}

function describeZone(
  kind: ZoneKind,
  bbox: BBox,
  beat: Beat,
  o: { stream: { w: number; h: number } },
  t: number | undefined,
): ZoneDesc {
  const areaFrac = bboxArea(bbox) / screenArea(o.stream);
  const shows = showsWords(kind, beat, o.stream);
  const size = sizeWords(areaFrac);
  const where = kind === "all" ? "everywhere" : whereWords(bbox, o.stream);
  const activity = activityWords(kind, beat, t);
  return { shows, size, where, activity };
}

/**
 * The action the act zone is built around (actZone): a beat that opens with
 * pointer travel and then rests is described as pointing, not clicking.
 */
function actAnchor(beat: Beat): Action | undefined {
  return beat.actions.find((a) => a.k === "click" || a.k === "dwell" || a.k === "drag" || a.k === "shortcut");
}

function showsWords(kind: ZoneKind, beat: Beat, stream: { w: number; h: number }): string {
  switch (kind) {
    case "act": {
      const a = actAnchor(beat);
      if (a?.k === "drag") return "the control the user dragged";
      if (a?.k === "dwell") return "the control the user pointed at";
      if (a?.k === "shortcut") return "the area affected by the shortcut";
      return "the control the user clicked";
    }
    case "txt":
      return "the area where text was typed";
    case "res":
      return "a region that changed after the action";
    case "path":
      return "the path the pointer moved along";
    case "win": {
      const cls = beat.window_cls.toLowerCase();
      const name = Object.hasOwn(APP_NAMES, cls) ? APP_NAMES[cls] : undefined;
      return name ? `the whole ${name} window` : "the app window";
    }
    case "all":
      return "the entire screen";
  }
}

function activityWords(kind: ZoneKind, beat: Beat, t: number | undefined): string {
  switch (kind) {
    case "act": {
      const a = actAnchor(beat);
      if (a?.k === "drag") return "dragged at the start of the beat";
      if (a?.k === "dwell") return "the pointer rested here";
      if (a?.k === "shortcut") return "the shortcut was pressed at the start of the beat";
      const dbl = beat.actions.some((x) => x.k === "click" && x.double);
      return dbl ? "double-clicked at the start of the beat" : "clicked once at the start of the beat";
    }
    case "txt": {
      const a = beat.actions.find((x) => x.k === "type");
      const dur = a ? (a.t1 - a.t0) / 1000 : 0;
      return dur >= 2 ? "text typed here for a while" : "text typed here briefly";
    }
    case "res": {
      if (t === undefined) return "changed after the action";
      return `appeared ${delayWords(t - beat.anchor_t)} after the action`;
    }
    case "path":
      return "the pointer moved through here";
    case "win":
      return "contains the zones above";
    case "all":
      return "contains the zones above";
  }
}
