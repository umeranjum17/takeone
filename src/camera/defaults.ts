// Every camera constant in one object. Override with --set key=value.
// A re-render with new values costs zero tokens.

export interface CameraDefaults {
  out_w: number;
  out_h: number;
  fps: number;
  max_upscale: number; // never upscale source pixels more than this
  deadzone_margin: number; // 8% margin for the deadzone rule
  deadzone_zoom: number; // max zoom change for the deadzone rule
  dwell: number; // s after previous arrival before a move may start
  dwell_k2: number; // s, for K = 2
  dwell_merge_delay: number; // s, merge if honouring dwell delays arrival this much
  min_shot: number; // s between arrivals, else merge
  rate_window: number; // s
  rate_max: number; // max moves per window
  cut_settle_ms: number; // changed_frac must stay under cut_max for this long
  cut_max: number;
  idle_s: number; // idle beat length for BREATHE
  next_beat_s: number; // next beat must be this far away for BREATHE
  breathe_s: number; // eased widen duration
  move_t_min: number;
  move_t_max: number;
  move_t_slope: number;
  anchor_early: number; // target A arrives at anchor_t - this
  result_late: number; // target B arrives at first change + this
  hop_zoom: number; // both zooms must exceed this
  hop_pan: number; // in viewport widths
  hop_zoom_div: number; // z_mid = min(z1,z2) / this
  hop_t_scale: number;
  follow_omega: number; // rad/s, critically damped spring
  follow_inner: number; // fraction of viewport; move only when subject leaves this
  lowpass_omega: number; // rad/s, final low-pass over (cx, cy, ln z)
  l1_pad: number;
  l2_pad: number;
  l3_pad: number;
}

export const DEFAULTS: CameraDefaults = {
  out_w: 1920,
  out_h: 1080,
  fps: 30,
  max_upscale: 1.25,
  deadzone_margin: 0.08,
  deadzone_zoom: 1.25,
  dwell: 0.6,
  dwell_k2: 1.5,
  dwell_merge_delay: 0.8,
  min_shot: 1.2,
  rate_window: 10,
  rate_max: 4,
  cut_settle_ms: 300,
  cut_max: 0.05,
  idle_s: 3,
  next_beat_s: 2,
  breathe_s: 1.5,
  move_t_min: 0.6,
  move_t_max: 1.4,
  move_t_slope: 0.35,
  anchor_early: 0.1,
  result_late: 0.15,
  hop_zoom: 1.6,
  hop_pan: 1.2,
  hop_zoom_div: 1.8,
  hop_t_scale: 1.3,
  follow_omega: 6,
  follow_inner: 0.6,
  lowpass_omega: 12,
  l1_pad: 2.2,
  l2_pad: 1.8,
  l3_pad: 1.35,
};

export type Overrides = Partial<Record<keyof CameraDefaults, number>>;

/** Apply `--set key=value` overrides onto a copy of DEFAULTS. */
export function applyOverrides(overrides: Overrides): CameraDefaults {
  const out: CameraDefaults = { ...DEFAULTS };
  for (const [k, v] of Object.entries(overrides)) {
    const key = k as keyof CameraDefaults;
    if (!(key in out) || typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`unknown or invalid --set ${k}=${v}`);
    }
    out[key] = v;
  }
  return out;
}
