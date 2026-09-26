// Plain data types shared across the pipeline. Everything here is JSON-serializable
// and free of behaviour so the later in-browser editor can import the decision,
// beat and zone modules directly.

export type BBox = [x: number, y: number, w: number, h: number];

/** One change region on one analysis frame. bbox is in stream pixels. */
export interface Region {
  bbox: BBox;
  /** region area / screen area */
  area_frac: number;
}

/** Per-analysis-frame perception output (analysis/regions.json). */
export interface FrameRegions {
  /** ms on the event clock */
  t: number;
  changed_frac: number;
  cut: boolean;
  regions: Region[];
}

/** Input event classes written by the recorder (events.jsonl). */
export type Event =
  | { t: number; k: "ptr"; x: number; y: number }
  | { t: number; k: "btn"; b: "left" | "right" | "middle"; down: boolean }
  | { t: number; k: "wheel"; dx: number; dy: number }
  | {
      t: number;
      k: "key";
      cls: "char" | "space" | "enter" | "backspace" | "tab" | "esc" | "nav" | "mod" | "fn";
      down: boolean;
      combo?: string;
    }
  | { t: number; k: "win"; cls: string; title: string; rect: BBox | null };

/** High-level actions derived from events, refined by change regions (analysis/actions.json). */
export type Action =
  | { k: "click"; t: number; x: number; y: number; double?: boolean; window_cls: string }
  | {
      k: "drag";
      t0: number;
      t1: number;
      from: [number, number];
      to: [number, number];
      bbox: BBox;
      window_cls: string;
    }
  | {
      k: "scroll";
      t0: number;
      t1: number;
      x: number;
      y: number;
      dx: number;
      dy: number;
      detents: number;
      window_cls: string;
    }
  | {
      k: "type";
      t0: number;
      t1: number;
      window_cls: string;
      /** union of change regions inside the focused window during the burst; absent when nothing changed */
      region?: BBox;
    }
  | { k: "shortcut"; t: number; combo: string; window_cls: string }
  | { k: "focus"; t: number; cls: string; rect: BBox }
  | { k: "dwell"; t0: number; t1: number; x: number; y: number; window_cls?: string }
  | { k: "travel"; t0: number; t1: number; from: [number, number]; to: [number, number]; bbox: BBox; window_cls?: string }
  | { k: "cut"; t: number; changed_frac: number; window_cls?: string };

export type ActionKind = Action["k"];

/** Candidate zone kinds, in the fixed vocabulary sent to Jev. */
export type ZoneKind = "act" | "res" | "txt" | "path" | "win" | "all";

/** Fixed-vocabulary zone description; optional opt-in text can contain digits. */
export interface ZoneDesc {
  shows: string;
  size: string;
  where: string;
  activity: string;
  /** OCR words + window title, only with --screen-text */
  text?: string;
}

export interface Zone {
  name: string;
  kind: ZoneKind;
  bbox: BBox;
  area_frac: number;
  /** ms of the zone's first activity within the beat, when it has any */
  t?: number;
  desc: ZoneDesc;
}

export type BeatKind =
  | "click"
  | "type"
  | "drag"
  | "scroll"
  | "travel"
  | "dwell"
  | "shortcut"
  | "cut"
  | "idle";

export interface Beat {
  id: string;
  t0: number;
  t1: number;
  anchor_t: number;
  window_cls: string;
  actions: Action[];
  zones: Zone[];
  kind: BeatKind;
  /** change regions attached as the beat's result (design 7.1 step 3), largest first */
  results?: Region[];
}

/** Jev answers for one beat, as returned by the API. */
export interface JevAnswers {
  focus_start?: { choice?: string; probabilities?: Record<string, number>; confidence?: number };
  focus_end?: { choice?: string; probabilities?: Record<string, number>; confidence?: number };
  tightness?: { score?: number; probabilities?: number[]; confidence?: number };
  new_subject?: { p?: number };
  key_moment?: { score?: number; probabilities?: number[]; confidence?: number };
}

/** Framing tightness levels, whole screen (0) to tight (3). */
export type Tightness = 0 | 1 | 2 | 3;

export interface Decision {
  beat: string;
  A: string;
  B: string;
  L: Tightness;
  p: number;
  K: 0 | 1 | 2;
  conf: { A?: number; B?: number; L?: number; K?: number };
  decided_by: "jev" | "heuristic";
  model?: string;
  input_tokens?: number;
}

/** Take metadata (take.json), the subset the planner reads. */
export interface TakeMeta {
  id: string;
  /** stream (video) pixel size */
  stream: { w: number; h: number };
  scale: number;
  offset_ms: number;
  /** "hyprland" | "none" */
  pointer: string;
  events?: string;
  /** ms since take start; absent for an untrimmed take */
  trim?: { start: number; end: number };
  jev?: { input_tokens: number; usd: number; failed: number };
}

export function bboxArea(b: BBox): number {
  return Math.max(0, b[2]) * Math.max(0, b[3]);
}

export function screenArea(stream: { w: number; h: number }): number {
  return stream.w * stream.h;
}

export function bboxIoU(a: BBox, b: BBox): number {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (inter === 0) return 0;
  const union = bboxArea(a) + bboxArea(b) - inter;
  return union <= 0 ? 0 : inter / union;
}

export function clampBBox(b: BBox, w: number, h: number): BBox | null {
  const x0 = Math.min(Math.max(0, Math.round(b[0])), w);
  const y0 = Math.min(Math.max(0, Math.round(b[1])), h);
  const x1 = Math.min(Math.max(0, Math.round(b[0] + b[2])), w);
  const y1 = Math.min(Math.max(0, Math.round(b[1] + b[3])), h);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return [x0, y0, x1 - x0, y1 - y0];
}

export function unionBBox(a: BBox, b: BBox): BBox {
  const x0 = Math.min(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  return [x0, y0, Math.max(a[0] + a[2], b[0] + b[2]) - x0, Math.max(a[1] + a[3], b[1] + b[3]) - y0];
}
