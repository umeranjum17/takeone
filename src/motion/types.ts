// storyboard.json v1: the only contract between planning and the motion renderer.
// The renderer is a pure function of this file plus the files under sources/.
import type { Overrides } from "../camera/defaults.ts";

export type Rect = [number, number, number, number]; // x, y, w, h in source px of its screen
export type Device = "browser" | "phone" | "laptop" | "none";
export const PATTERNS = ["hero-reveal", "zoom-tour", "end-card", "fragment"] as const;
export type PatternName = (typeof PATTERNS)[number];

/** DOM-driven ingest ops (L8-h), played in order in one capture page; each named state is captured after its ops. */
export type StateOp =
  | ["click", string]
  | ["type", string, string]
  | ["drag", string, string, { capture_at?: number }?]
  | ["drop"]
  | ["wait", number];

export interface Screen { file: string; width: number; height: number }

export interface Region {
  id: string;
  rect: Rect;
  screen: string;
  label?: string;
  /** For html/url sources: resolved to rect at ingest. */
  selector?: string;
  from: "user" | "dom" | "default";
}

export interface Stop { region: string; caption?: string; hold?: number }

export interface Scene {
  pattern: PatternName;
  /** Seconds. */
  d: number;
  /** Start in film seconds; filled by the validator from the running sum when absent. */
  at?: number;
  screen?: string;
  device?: Device;
  title?: string;
  subtitle?: string;
  focus?: string;
  stops?: Stop[];
  cta?: string;
  url?: string;
  /** Wordmark text for the end card (set in the display font, letters at kerned x). */
  logo?: string;
  /** fragment pattern: kind and state, laid out by FRAGMENTS[kind]. */
  kind?: string;
  state?: string;
  text?: string;
  /** Reading-hold push, fraction of scale (0.03-0.05). */
  push?: number;
}

export interface Tempo { bpm: number; phase_s: number; snap: "beat" | "half" }

export type BentoTile2x2 = "TL" | "TR" | "BL" | "BR";
export interface Bento2x2 {
  kind: "bento";
  grid: "2x2";
  /** One master film, mounted once per tile, its clock shifted by offset_s (canon). */
  tiles: { id: BentoTile2x2; offset_s: number }[];
  master: { d: number; scenes: Scene[] };
}
export interface BentoPinwheel {
  kind: "bento";
  grid: "pinwheel-3x2";
  /** Per-tile timelines; tile ids A (2x1), B (1x1), C (1x1), D (2x1). */
  tiles: Record<"A" | "B" | "C" | "D", Scene[]>;
}
export type Layout = { kind: "single" } | Bento2x2 | BentoPinwheel;

export interface Output {
  out_w: number;
  out_h: number;
  fps: number;
  /** Fixed per render: anti-aliasing can differ across worker counts, so it is part of the render's identity. */
  workers: number;
  /** 0 off, 1 on: sub-frame accumulation on fast spans (L8-i). */
  motion_blur: number;
  preset: string;
}

export interface Storyboard {
  version: 1;
  id: string;
  output: Output;
  theme: { name: string; overrides: Overrides & Record<string, number | string> };
  tempo?: Tempo;
  source: {
    kind: "image" | "html" | "url";
    /** image: files; html: file; url: url. Paths are relative to the take dir or absolute. */
    files?: string[];
    file?: string;
    url?: string;
    viewport?: [number, number];
    dsf?: number;
    states?: Record<string, (StateOp | string)[]>;
  };
  /** Filled by ingest: screen id -> PNG under sources/. */
  screens: Record<string, Screen>;
  regions: Region[];
  layout: Layout;
  scenes: Scene[];
  planner: { by: "local" | "user"; abstained: string[] };
}
