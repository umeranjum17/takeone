// Shared plain-data types for the camera solver and render layer.
// No Node imports here: the solver must stay a pure function over plain data.

export type ZoneType = "act" | "res" | "txt" | "path" | "win" | "all";

export interface Zone {
  name: string;
  type: ZoneType;
  bbox: [number, number, number, number]; // x, y, w, h in stream pixels
  /** UI context from perception; independent of the planner's candidate deduplication. */
  boxes?: [number, number, number, number][];
  /** Result zone: time the region first changed (video-relative s). */
  t_change?: number;
}

export type BeatKind =
  | "change"
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
  window_cls?: string;
  window_rect?: [number, number, number, number];
  actions: unknown[];
  zones: Zone[];
  kind: BeatKind;
  /** UI revealed by a dialog dismissal, independent of the selected shot. */
  dialog_results?: { t: number; bbox: [number, number, number, number] }[];
  /** Cut beats: changed_frac at each analysis frame after the cut (video-relative s). */
  changed_frac?: { t: number; f: number }[];
  /** Render-time only: a cut removed the anchor or all zones; surviving actions still draw clicks. */
  camera_suppressed?: boolean;
}

export interface Decision {
  beat: string;
  A: string; // zone name
  B?: string; // zone name, optional
  L: 0 | 1 | 2 | 3;
  p: number; // probability the subject moved
  K: 0 | 1 | 2;
  conf: number;
  decided_by: string;
  model?: string;
  input_tokens?: number;
}

export interface TakeEdits {
  /** Remove half-open intervals, in video-relative seconds. */
  cuts?: { t0: number; t1: number }[];
}

export interface TakeMeta extends TakeEdits {
  /** Mobile capture renders inside a handset frame. */
  device?: "android" | "ios";
  theme?: string;
  id?: string;
  width: number;
  height: number;
  fps?: number;
  monitor?: string;
  scale?: number;
  offset_ms?: number;
  trim_start?: number;
  trim_end?: number;
  pointer?: string;
  events?: string;
  /** Timed source-pixel regions; t/d are video-relative seconds. */
  spotlight?: { t: number; d: number; rect: [number, number, number, number] }[];
  blur?: { t: number; d: number; rect: [number, number, number, number] }[];
  /** Optional opening title, drawn over the first seconds of the render. */
  title?: string;
  /** Optional captions in video-relative seconds; `d` defaults to 3. */
  captions?: { t: number; d?: number; text: string; position?: "top" | "bottom" }[];
  /** Source-pixel regions; requested arrival at t0, automatic framing resumes at t1. */
  zooms?: ManualZoom[];
}

export interface ManualZoom {
  t0: number;
  t1: number;
  bbox: [number, number, number, number];
  /** 0 = whole screen; 1..3 use the camera's context / medium / tight padding. */
  level?: 0 | 1 | 2 | 3;
}

export interface CameraFrame {
  t: number; // s, relative to trim start
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CameraState {
  cx: number;
  cy: number;
  z: number;
}
