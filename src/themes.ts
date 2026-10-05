// Shared recording/motion tokens. Keep editorial colours and type easy to tune here.
import { applyOverrides, DEFAULTS, type CameraDefaults, type Overrides } from "./camera/defaults.ts";

export const THEMES = {
  midnight: {}, // Exact existing stage, caption and camera defaults.
  paper: { background: "#f6f4ef", background_to: "#ebe7de", accent: "#e2522f", text: "#111111", card: "#f6f4ef",
    display_font: "Instrument Serif", caption_font: "IBM Plex Sans", bg_style: "solid", grain: 5,
    stage_margin: 0.14, shadow: 0.12, shadow_blur: 40, corner_radius: 10, border: 1, border_color: "#111111",
    caption_rounding: 0.08, caption_opacity: 1, spring_omega: 12, pace: 1.15 },
  aurora: { background: "#0a0f1f", background_to: "#24124a", bg_stops: "#0a0f1f,#24124a,#0e5a6b,#5b2a86",
    accent: "#7cf5d0", display_font: "Geist SemiBold", caption_font: "Geist", bg_style: "mesh",
    stage_margin: 0.12, shadow: 0.6, shadow_color: "#050b28", glow: 0.3, corner_radius: 18, spring_omega: 13, spring_zeta: 0.9 },
  mono: { background: "#000000", background_to: "#0a0a0a", accent: "#ffffff", display_font: "Geist SemiBold",
    caption_font: "Geist Mono", bg_style: "solid", grain: 0, stage_margin: 0.11, shadow: 0, border: 1, corner_radius: 12,
    text: "#000000", card: "#ffffff", caption_rounding: 0, caption_opacity: 1, caption_border: 1, border_color: "#ffffff", pace: 0.9 },
  sand: { background: "#efe6d8", background_to: "#d9c7ab", accent: "#3b5bdb", text: "#222222", card: "#efe6d8",
    display_font: "Fraunces SemiBold", caption_font: "Manrope Medium", grain: 4,
    stage_margin: 0.15, shadow: 0.22, shadow_color: "#5c4935", shadow_blur: 48, corner_radius: 20, caption_opacity: 1, caption_rounding: 0.35, spring_omega: 10, pace: 1.2 },
  // Cream and ink, type-led (motion recipes). Display face is the bundled Instrument Serif.
  editorial: { background: "#f1f1ec", background_to: "#f1f1ec", accent: "#0b0b0b", text: "#0b0b0b", card: "#ffffff",
    display_font: "Instrument Serif", caption_font: "Geist", bg_style: "solid", grain: 0, stage_margin: 0.1,
    shadow: 0, corner_radius: 28, border: 1, border_color: "#0b0b0b", caption_rounding: 1, caption_opacity: 1, pace: 1 },
} satisfies Record<string, Overrides>;
export type ThemeName = keyof typeof THEMES;
const REMOVED_THEMES = new Set(["neon", "brutalist", "terminal"]);

export function themeDefaults(name: unknown = "midnight"): CameraDefaults {
  if (typeof name === "string" && REMOVED_THEMES.has(name)) {
    throw new Error(`theme ${name} was removed; pass --theme with one of ${Object.keys(THEMES).join(", ")} or re-record with a kept theme`);
  }
  if (typeof name !== "string" || !Object.hasOwn(THEMES, name)) {
    throw new Error(`unknown theme ${String(name)}; choose ${Object.keys(THEMES).join(", ")}`);
  }
  return applyOverrides(THEMES[name as ThemeName], DEFAULTS);
}

/** Precedence: theme tokens < explicit --set overrides. */
export function resolveTheme(name: unknown, overrides: Overrides = {}): CameraDefaults {
  return applyOverrides(overrides, themeDefaults(name));
}
