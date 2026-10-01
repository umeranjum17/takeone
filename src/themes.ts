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
  neon: { background: "#07060d", background_to: "#40106d", accent: "#ff3df2", display_font: "Space Grotesk Bold",
    caption_font: "Space Grotesk Medium", bg_style: "radial", grain: 6, stage_margin: 0.14, glow: 0.85,
    shadow_color: "#320849", text: "#ff94f5", card: "#190b30", caption_opacity: 0.96, caption_rounding: 0.4,
    corner_radius: 16, spring_omega: 16, spring_zeta: 0.75, pace: 0.85 },
  brutalist: { background: "#ffe14d", background_to: "#ffe14d", accent: "#111111", text: "#111111", card: "#ffe14d",
    display_font: "Archivo ExtraBold Expanded", caption_font: "IBM Plex Mono", bg_style: "solid", grain: 0,
    stage_margin: 0.1, shadow: 1, shadow_blur: 0, shadow_x: 10, shadow_y: 10, corner_radius: 0,
    caption_rounding: 0, caption_opacity: 1, caption_border: 2, border_color: "#111111", pace: 0.8 },
  sand: { background: "#efe6d8", background_to: "#d9c7ab", accent: "#3b5bdb", text: "#222222", card: "#efe6d8",
    display_font: "Fraunces SemiBold", caption_font: "Manrope Medium", grain: 4,
    stage_margin: 0.15, shadow: 0.22, shadow_color: "#5c4935", shadow_blur: 48, corner_radius: 20, caption_opacity: 1, caption_rounding: 0.35, spring_omega: 10, pace: 1.2 },
  terminal: { background: "#0d1117", background_to: "#0d1117", accent: "#3fb950", text: "#3fb950", card: "#0d1117",
    display_font: "JetBrains Mono Bold", caption_font: "JetBrains Mono", bg_style: "solid", grain: 2,
    stage_margin: 0.13, bg_pattern: "grid", shadow: 0.4, corner_radius: 8, border: 1, border_color: "#3fb950",
    caption_rounding: 0.08, caption_opacity: 1, caption_border: 1, pace: 0.9 },
} satisfies Record<string, Overrides>;
export type ThemeName = keyof typeof THEMES;

export function themeDefaults(name: unknown = "midnight"): CameraDefaults {
  if (typeof name !== "string" || !Object.hasOwn(THEMES, name)) {
    throw new Error(`unknown theme ${String(name)}; choose ${Object.keys(THEMES).join(", ")}`);
  }
  return applyOverrides(THEMES[name as ThemeName], DEFAULTS);
}

/** Precedence: theme tokens < explicit --set overrides. */
export function resolveTheme(name: unknown, overrides: Overrides = {}): CameraDefaults {
  return applyOverrides(overrides, themeDefaults(name));
}
