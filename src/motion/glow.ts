// The glow-reel recipe: real screens and a few lines of copy in, a 5-9 s promo out, planned locally (no engine, no
// network). A typed prompt, kinetic words, a headline over a gradient ribbon, a file tree, the screen with a glowing
// click and the end card, cut fast on a near-black navy stage. The copy is the caller's; only the pressed control is found
// (by OCR, on this machine) so the click lands on a real button of the real screen.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { screenLines } from "../decide/ocr.ts";
import { imageSize } from "./ingest.ts";
import { minSceneDuration } from "./storyboard.ts";
import type { Crop, Rect, Scene } from "./types.ts";

export interface GlowArgs { inputs: string[]; title?: string; subtitle?: string; pitch?: string; press?: string; frame?: string; tree?: string; cta?: string; logo?: string; url?: string; audio?: string; workers?: number }

/** The zoom beat's window: wide enough to read the control, never magnified past ~2x of the source, around the control. */
export const ZOOM_W = 860;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/** Text lines read off the screen, then off its negative: OCR misses the light label of a filled button. */
async function bothLines(file: string): Promise<{ text: string; box: number[] }[]> {
  const dir = mkdtempSync(join(tmpdir(), "takeone-glow-"));
  try {
    const neg = join(dir, "negative.png");
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-i", file, "-vf", "negate", neg], { timeout: 60000 });
    return [...await screenLines(file), ...await screenLines(neg)];
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The pressed control's box: `x,y,w,h` in source px as given, else its text line's box (read by OCR) grown to the button around it. */
export async function pressBox(file: string, press: string): Promise<Rect> {
  const given = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(press);
  if (given) return given.slice(1).map(Number) as Rect;
  const lines = await bothLines(file), want = norm(press);
  const hit = lines.find(l => norm(l.text) === want) ?? lines.find(l => norm(l.text).includes(want));
  if (!hit) throw new Error(`glow: no text line "${press}" on ${file}; pass its box as --press x,y,w,h if OCR cannot read it. The screen reads: ${lines.slice(0, 14).map(l => JSON.stringify(l.text)).join(", ")}`);
  const [x, y, w, h] = hit.box as Rect;
  return [Math.max(0, x - h * 0.9), Math.max(0, y - h * 0.6), w + h * 1.8, h * 2.2];
}

/** `--tree "Crew,>Chief,>Scout"`: a leading `>` indents a row one level. */
export function treeRows(spec: string): string[] {
  return spec.split(",").map(t => t.trim()).filter(Boolean).map(t => (t.startsWith(">") ? "  " : "") + t.replace(/^>\s*/, ""));
}

/** The storyboard for one or two screens and the copy. Pure given the pressed control's box. */
export function glowStoryboard(a: GlowArgs, id: string, sizes: { width: number; height: number }[], tap: Rect, frame?: Rect): unknown {
  const { width: W, height: H } = sizes[0]!;
  const zw = Math.min(ZOOM_W, W), zh = Math.min(Math.round(zw * 9 / 16), H);
  const rect = (c: number, len: number, max: number) => Math.round(Math.max(0, Math.min(c - len / 2, max - len)));
  const crops: Record<string, Crop> = {
    win: { screen: "S1", rect: [0, 0, W, H], exact: true },
    press: { screen: "S1", rect: frame ?? [rect(tap[0] + tap[2] / 2, zw, W), rect(tap[1] + tap[3] / 2, zh, H), zw, zh], exact: true },
    ...(sizes[1] ? { phone: { screen: "S2", rect: [0, 0, sizes[1].width, sizes[1].height], exact: true } } : {}),
  };
  const fit = (s: Scene, floor: number): Scene => ({ ...s, cut: true, d: Math.round(Math.max(floor, minSceneDuration(s)) * 60) / 60 });
  const scenes: Scene[] = [
    fit({ pattern: "glow-prompt", d: 0, text: a.pitch! }, 0.9),
    ...(a.subtitle ? [fit({ pattern: "glow-words", d: 0, title: a.subtitle }, 0.27 * a.subtitle.split(/\s+/).length)] : []),
    fit({ pattern: "glow-hero", d: 0, title: a.title!, text: a.cta ?? "Get started" }, 2.2),
    ...(a.tree ? [fit({ pattern: "glow-tree", d: 0, tree: treeRows(a.tree) }, 0.8)] : []),
    fit({ pattern: "glow-screen", d: 0, screen: "win", tap, ...(sizes[1] ? { phone: "phone" } : {}) }, 0.6),
    fit({ pattern: "glow-screen", d: 0, screen: "press", tap, zoom: true }, 0.9),
    fit({ pattern: "end-card", d: 0, logo: a.logo!, cta: a.cta ?? "Get started", ...(a.url ? { url: a.url } : {}), glow: true }, 2.3),
  ];
  return {
    version: 1, id,
    output: { ...(a.workers !== undefined ? { workers: a.workers } : {}) },
    theme: { name: "aurora", overrides: { background: "#030719", background_to: "#030719", bg_style: "solid", text: "#ffffff", accent: "#2f7bff", display_font: "Inter Bold" } },
    source: { kind: "image", files: a.inputs.map(f => resolve(f)) },
    screens: Object.create(null), regions: [], crops,
    ...(a.audio ? { audio: { file: resolve(a.audio), volume: 0.6 } } : {}),
    layout: { kind: "single" }, scenes,
    planner: { by: "local", abstained: [] },
  };
}

export async function planGlow(a: GlowArgs, id: string): Promise<unknown> {
  if (a.inputs.length < 1 || a.inputs.length > 2 || a.inputs.some(f => !/\.(png|jpe?g|webp)$/i.test(f))) throw new Error("--recipe glow takes one or two screenshots (png, jpg or webp): the screen, then an optional phone screen");
  const missing = (["title", "pitch", "press", "logo"] as const).filter(k => !a[k]?.trim());
  if (missing.length) throw new Error(`--recipe glow needs ${missing.map(k => ({ title: "--title HEADLINE", pitch: "--pitch TYPED_PROMPT", press: "--press BUTTON_TEXT_OR_x,y,w,h", logo: "--logo WORDMARK" })[k]).join(", ")}`);
  return glowStoryboard(a, id, a.inputs.map(f => imageSize(resolve(f))), await pressBox(resolve(a.inputs[0]!), a.press!), a.frame ? await pressBox("", a.frame) : undefined);
}
