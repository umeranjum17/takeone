// Every camera constant in one object. Override with --set key=value.
// A re-render with new values costs zero tokens.

export interface CameraDefaults {
  out_w: number;
  out_h: number;
  background: string;
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
  preset: string; // x264 encode preset; slower = smaller file, same pixels
  frame_max: number; // padding never widens a shot past this fraction of the screen width
  hold_pad: number; // ... but the zone itself always keeps at least this padding
  establish_s: number; // hold the whole stage this long before the first shot arrives
  outro_s: number; // return to the whole stage for the final seconds; 0 keeps the last shot
  idle_speed: number; // play idle gaps this many times faster; 1 turns it off
  idle_keep: number; // s of real-time footage kept on each side of every action
  // Stage look: the screen sits as a rounded card on a gradient at rest.
  background_to: string; // gradient end colour (background is the start)
  stage_margin: number; // margin around the screen at rest, fraction of its width
  corner_radius: number; // output px at rest
  shadow: number; // drop-shadow opacity, 0 turns it off
  accent: string; // click ripple colour
  ripple_ms: number; // ripple duration, 0 turns click emphasis off
  ripple_r: number; // final ripple radius, output px at rest
  caption_font: string;
  caption_size: number; // output px; the title is 1.4x this
  fade_s: number; // fade in from and out to the background
}

export const DEFAULTS: CameraDefaults = {
  out_w: 1920,
  out_h: 1080,
  background: "#2a2d38",
  fps: 30,
  max_upscale: 1.5,
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
  preset: "slow",
  frame_max: 0.8,
  hold_pad: 1.08,
  establish_s: 1.6,
  outro_s: 1.6,
  idle_speed: 4,
  idle_keep: 1,
  background_to: "#101116",
  stage_margin: 0.055,
  corner_radius: 14,
  shadow: 0.55,
  accent: "#6d8cff",
  ripple_ms: 550,
  ripple_r: 34,
  caption_font: "Inter SemiBold",
  caption_size: 38,
  fade_s: 0.4,
};

const COLOURS = ["background", "background_to", "accent"];

export type Overrides = Partial<Record<keyof CameraDefaults, number | string>>;

/** Apply `--set key=value` overrides onto a copy of DEFAULTS. */
export function applyOverrides(overrides: Overrides): CameraDefaults {
  const out: CameraDefaults = { ...DEFAULTS };
  const PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast",
    "medium", "slow", "slower", "veryslow", "placebo"];
  for (const [k, v] of Object.entries(overrides)) {
    const key = k as keyof CameraDefaults;
    if (key === "preset") {
      if (typeof v !== "string" || !PRESETS.includes(v)) throw new Error(`unknown or invalid --set ${k}=${v}`);
      out.preset = v;
      continue;
    }
    if (COLOURS.includes(k) && typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)) {
      (out as unknown as Record<string, unknown>)[key] = v;
      continue;
    }
    // Font names reach an ASS style line, so keep them to plain words.
    if (k === "caption_font" && typeof v === "string" && /^[A-Za-z0-9 ]{1,64}$/.test(v)) {
      out.caption_font = v;
      continue;
    }
    if (COLOURS.includes(k) || k === "caption_font") {
      throw new Error(`unknown or invalid --set ${k}=${v}`);
    }
    const positive = ["out_w", "out_h", "fps", "max_upscale", "rate_window", "rate_max", "move_t_min", "move_t_max", "hop_zoom", "hop_zoom_div", "hop_t_scale", "follow_omega", "lowpass_omega", "l1_pad", "l2_pad", "l3_pad", "frame_max", "caption_size"];
    const integers = ["out_w", "out_h", "fps", "rate_max"];
    if (!(key in out) || typeof v !== "number" || !Number.isFinite(v)
      || (positive.includes(k) ? v <= 0 : v < 0)
      || (integers.includes(k) && !Number.isInteger(v))
      || (["out_w", "out_h"].includes(k) && v % 2 !== 0)
      || (["max_upscale", "deadzone_zoom", "l1_pad", "l2_pad", "l3_pad", "hold_pad", "idle_speed"].includes(k) && v < 1)
      || (k === "frame_max" && v > 1)
      || (k === "deadzone_margin" && v >= 0.5)
      || (k === "stage_margin" && v > 0.25)
      || (k === "shadow" && v > 1)
      || (k === "follow_inner" && (v === 0 || v > 1))
      || (k === "cut_max" && v > 1)) {
      throw new Error(`unknown or invalid --set ${k}=${v}`);
    }
    (out as unknown as Record<string, unknown>)[key] = v;
  }
  if (out.move_t_max < out.move_t_min) throw new Error("move_t_max must be at least move_t_min");
  return out;
}
