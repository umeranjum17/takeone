// storyboard.json v1: the only contract between planning and the motion renderer.
// The renderer is a pure function of this file plus the files under sources/.
import type { Overrides } from "../camera/defaults.ts";

export type Rect = [number, number, number, number]; // x, y, w, h in source px of its screen
export type Device = "browser" | "phone" | "laptop" | "none";
export type MotionEngine = "hyperframes" | "legacy";
export const PATTERNS = ["hero-reveal", "zoom-tour", "end-card", "fragment", "kinetic-type", "bento", "clip", "statement", "word-swap", "phone-story", "chip-stack", "canon"] as const;
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

export interface BentoTile { title: string; screen?: string }

/** Real footage: [start, start + d) seconds of one or more videos, cut at ingest into 60 fps JPEG frames.
 *  `files` are renders of one take in different aspects; the page plays the one whose own (uncropped) aspect is nearest the output aspect. */
export interface Clip {
  files: string[];
  start: number;
  d: number;
  /** Optional per file: ffmpeg crop "w:h:x:y" in source pixels, cutting the real frame down to its subject. */
  crop?: (string | null)[];
  /** Filled by ingest, one per file: frame directory (frames 0001.jpg...), frame size and the uncropped file's aspect.
   *  `framesSource` records the window the frames were cut from; a later edit to files/start/d/crop re-ingests. */
  frames?: { dir: string; count: number; width: number; height: number; aspect: number }[];
  framesSource?: { files: string[]; start: number; d: number; crop?: (string | null)[] };
}

/** clip pattern: at `at` scene seconds, retarget the window (one spring added) and optionally swap footage/label. */
export interface ClipCut { at: number; clip?: string; label?: string; scale?: number }

/** Named device-px sub-rects of screens, cut at ingest (close-ups with no extra capture). */
/** `exact` keeps the planned rect (a single UI line cut as a chip) instead of snapping it to whole UI. */
export interface Crop { screen: string; rect: Rect; exact?: boolean }

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
  /** Swap the theme background and text colours for this scene (a black beat on a cream film, and back). */
  invert?: boolean;
  /** bento: exactly four title tiles in row order. */
  tiles?: BentoTile[];
  /** Hard cut on the beat instead of the half-second push-in. */
  cut?: boolean;
  /** clip: the footage fills the whole frame, edge to edge (HyperFrames engine), its label a chip inside the safe area. */
  fill?: boolean;
  /** clip: the footage window's clip id. */
  clip?: string;
  /** clip: typed mono label; statement: mono footnote under the type. */
  label?: string;
  note?: string;
  /** clip: window scale of its fitted size (default 1) and the scale it springs from (default 0.94 of it). */
  scale?: number;
  from?: number;
  cuts?: ClipCut[];
  /** word-swap: the words that finish the title in turn, each struck out for the next. */
  swaps?: string[];
  /** chip-stack: screen ids (crops) stacked one row per beat. */
  chips?: string[];
  /** phone-story: the pressed control, in source px of the screen the crop was cut from. */
  tap?: Rect;
  /** canon: the master film time each of the four tiles shows at the canon's first frame. */
  offsets?: number[];
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

/** One film-level audio bed, copied into the HyperFrames project and muxed once. */
export interface Audio {
  /** Path relative to the take dir or absolute. */
  file: string;
  /** Seconds into the source. */
  start?: number;
  /** Linear gain, 0..1 (HyperFrames `data-volume`). */
  volume?: number;
}

export interface Storyboard {
  version: 1;
  id: string;
  output: Output;
  theme: { name: string; overrides: Overrides & Record<string, number | string> };
  tempo?: Tempo;
  crops?: Record<string, Crop>;
  clips?: Record<string, Clip>;
  audio?: Audio;
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
  /** Filled by ingest: screen id -> image under sources/ (copied input or captured PNG). */
  screens: Record<string, Screen>;
  regions: Region[];
  layout: Layout;
  scenes: Scene[];
  /** `abstained` lists the planner decisions that fell back to the local defaults. */
  planner: { by: "ai" | "local" | "user"; abstained: string[] };
}
