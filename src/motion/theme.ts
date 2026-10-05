// Theme tokens for motion pages, exposed to every pattern as CSS variables (L7 themes plus motion-only tokens).
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyOverrides, type CameraDefaults, type Overrides } from "../camera/defaults.ts";
import { themeDefaults, THEMES } from "../themes.ts";

export const SYMBOL_FONT = "Inter SemiBold";
export const RULE_FONT = "Geist Mono";

export const FONTS_DIR = fileURLToPath(new URL("../../resources/fonts/", import.meta.url));

/** Motion-only tokens. `page` is the backdrop behind bento tiles; tiles and single scenes use `background`. */
export interface MotionExtras {
  page: string;
  muted: string; // pending/secondary text; never a settled key line
  line: string; // hairlines, field borders
  ink: string; // strongest text on card surfaces
  mono_font: string;
  gutter_x: number;
  gutter_y: number;
  margin_x: number;
  margin_y: number;
}
export type MotionTokens = CameraDefaults & MotionExtras;

const EXTRAS: Record<string, Partial<MotionExtras>> = {
  midnight: { page: "#101116", muted: "#9aa0b4", line: "#3a3e4c", ink: "#f4f5f8", mono_font: "Geist Mono" },
  paper: { page: "#ebe7de", muted: "#77736a", line: "#d6d1c6", ink: "#111111", mono_font: "IBM Plex Mono" },
  aurora: { page: "#070b18", muted: "#93a0c4", line: "#2b3358", ink: "#eef2ff", mono_font: "Geist Mono" },
  mono: { page: "#000000", muted: "#8a8a8a", line: "#2a2a2a", ink: "#000000", mono_font: "Geist Mono" },
  sand: { page: "#d9c7ab", muted: "#7a6a55", line: "#cdbb9e", ink: "#222222", mono_font: "IBM Plex Mono" },
  editorial: { page: "#ffffff", muted: "#9c9c97", line: "#c5c5c0", ink: "#0b0b0b", mono_font: "Geist Mono",
    gutter_x: 28, gutter_y: 20, margin_x: 60, margin_y: 44 },
};
const BASE_EXTRAS: MotionExtras = { page: "#101116", muted: "#9aa0b4", line: "#3a3e4c", ink: "#f4f5f8", mono_font: "Geist Mono",
  gutter_x: 24, gutter_y: 24, margin_x: 60, margin_y: 44 };

const EXTRA_COLOURS = ["page", "muted", "line", "ink"];
const EXTRA_NUMBERS = ["gutter_x", "gutter_y", "margin_x", "margin_y"];

/** Theme < storyboard overrides. Recording keys go through the same validation as `--set`. */
export function motionTokens(name: string, overrides: Record<string, number | string> = {}): MotionTokens {
  if (!Object.hasOwn(THEMES, name)) throw new Error(`theme.name: unknown theme ${name}; choose ${Object.keys(THEMES).join(", ")}`);
  const extras: MotionExtras = { ...BASE_EXTRAS, ...EXTRAS[name] };
  const recording: Overrides = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (EXTRA_COLOURS.includes(k)) {
      if (typeof v !== "string" || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`theme.overrides.${k}: expected #rrggbb`);
      (extras as unknown as Record<string, unknown>)[k] = v;
    } else if (EXTRA_NUMBERS.includes(k)) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 400) throw new Error(`theme.overrides.${k}: expected 0-400 px`);
      (extras as unknown as Record<string, unknown>)[k] = v;
    } else if (k === "mono_font") {
      if (typeof v !== "string" || !fontFile(v)) throw new Error(`theme.overrides.mono_font: not a bundled font`);
      extras.mono_font = v;
    } else (recording as Record<string, unknown>)[k] = v;
  }
  let base: CameraDefaults;
  try { base = applyOverrides(recording, { ...themeDefaults(name), ...(name === "mono" ? { text: "#ffffff" } : {}) }); } catch (e) { throw new Error(`theme.overrides: ${(e as Error).message}`); }
  for (const f of [base.display_font, base.caption_font]) if (!fontFile(f)) throw new Error(`theme: font ${f} is not bundled in resources/fonts`);
  return { ...base, ...extras };
}

interface FontEntry { file: string; family: string }
let manifest: FontEntry[] | undefined;
export function fontManifest(): FontEntry[] {
  return manifest ??= JSON.parse(readFileSync(new URL("manifest.json", pathToFileURL(FONTS_DIR)), "utf8")) as FontEntry[];
}
/** Absolute path of a bundled family, or null. */
export function fontFile(family: string): string | null {
  const e = fontManifest().find((f) => f.family === family);
  return e ? FONTS_DIR + e.file : null;
}

/** :root CSS variables plus @font-face rules (local files only) for the page. */
export function themeCss(t: MotionTokens): { css: string; faces: string[] } {
  const families = [...new Set([t.display_font, t.caption_font, t.mono_font, SYMBOL_FONT, RULE_FONT])];
  const faces = families.map((f) => `@font-face { font-family: "${f}"; src: url("${pathToFileURL(fontFile(f)!).href}") format("truetype"); }`);
  const vars: Record<string, string> = {
    "--page": t.page, "--bg": t.background, "--bg-to": t.background_to, "--accent": t.accent, "--text": t.text,
    "--card": t.card, "--ink": t.ink, "--muted": t.muted, "--line": t.line, "--border-color": t.border_color,
    "--shadow-color": t.shadow_color, "--display": `"${t.display_font}"`, "--body": `"${t.caption_font}"`,
    "--mono": `"${t.mono_font}"`, "--symbols": `"${SYMBOL_FONT}"`, "--rules": `"${RULE_FONT}"`, "--radius": `${t.corner_radius}px`, "--border": `${t.border}px`,
    "--shadow": String(t.shadow), "--shadow-blur": `${t.shadow_blur}px`, "--shadow-x": `${t.shadow_x}px`,
    "--shadow-y": `${t.shadow_y}px`, "--glow": String(t.glow), "--gutter-x": `${t.gutter_x}px`, "--gutter-y": `${t.gutter_y}px`,
    "--margin-x": `${t.margin_x}px`, "--margin-y": `${t.margin_y}px`, "--pill-radius": String(t.caption_rounding),
  };
  const root = `:root { ${Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join(" ")} }`;
  return { css: faces.join("\n") + "\n" + root, faces: families.map((f) => `16px "${f}"`) };
}
