#!/usr/bin/env node
// Generate a fully synthetic demo take: a scripted 1920x1080 44 s "product
// demo" screen.webm drawn entirely with ffmpeg filters, plus the matching
// take.json, frames.tsv, and events.jsonl. No desktop capture anywhere.
//
//   node scripts/synth-take.ts <output-dir>
//
// One timeline spec below drives BOTH the video filtergraph and the emitted
// event stream, so the pointer/button/keys can never drift from the picture.
//
// ffmpeg note: drawbox/drawtext coordinate expressions with `t` do not
// re-evaluate per frame reliably; overlay x/y expressions do (documented).
// So animated elements (scrolling rows, cursor) live on transparent PNG
// layers composited with overlay, and everything else is static filters
// gated by enable=between(t,a,b).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const W = 1920;
const H = 1080;
const FPS = 30;
const DUR = 44;

const FONT_CANDIDATES = [
  "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/Adwaita/AdwaitaSans-Regular.ttf",
];
const FONT_BOLD_CANDIDATES = [
  "/usr/share/fonts/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/Adwaita/AdwaitaSans-Bold.ttf",
];

function pickFont(candidates: string[]): string {
  for (const f of candidates) if (existsSync(f)) return f;
  throw new Error(`no font found; looked at ${candidates.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Timeline spec
// ---------------------------------------------------------------------------

// Pointer path: piecewise-linear keyframes [t, x, y]. The cursor and the ptr
// event samples are derived from the same array. Clusters sit more than a
// 0.35-diagonal spread apart so the segmenter cuts beats between scenes.
const PATH: [number, number, number][] = [
  [0.0, 960, 700],
  [3.2, 960, 700],
  [4.6, 250, 210],
  [7.4, 250, 210],
  [8.4, 1560, 170],
  [8.6, 1560, 170],
  [13.9, 1560, 178],
  [14.4, 1300, 600],
  [18.2, 1300, 600],
  [18.9, 430, 690],
  [21.8, 430, 690],
  [22.5, 300, 820],
  [22.8, 320, 820],
  [25.8, 750, 820],
  [31.8, 750, 820],
  [32.8, 1620, 32],
  [DUR, 1620, 32],
];

const CLICKS = [
  { t: 5.0, x: 250, y: 210 }, // nav -> Reports
  { t: 8.5, x: 1560, y: 170 }, // search box
  { t: 19.0, x: 430, y: 690 }, // row card
  { t: 33.0, x: 1620, y: 32 }, // Export
];
const DRAG = { down: 22.5, up: 26.2 };
const SCROLL = { t0: 14.5, t1: 16.7, max: 240 };
const TYPE_TEXT = "quarterly report";
const TYPE_T0 = 8.6;
const TYPE_STEP = 0.24;
const TYPE_X = 1384; // search text x (search box sits top-right)

const SCENE_B = 4.98; // Dashboard -> Reports swap
const FILTER_T = 12.4; // search results dim
const DETAIL_T = 19.0; // detail card opens
const TOAST_T = 33.0; // export toast
const SLIDE = { t0: 22.8, t1: 25.8, from: 300, to: 750 }; // slider handle x

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function pointerAt(t: number): [number, number] {
  for (let i = 0; i < PATH.length - 1; i++) {
    const [t0, x0, y0] = PATH[i]!;
    const [t1, x1, y1] = PATH[i + 1]!;
    if (t >= t0 && t <= t1) {
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      return [Math.round(x0 + (x1 - x0) * f), Math.round(y0 + (y1 - y0) * f)];
    }
  }
  const last = PATH[PATH.length - 1]!;
  return [last[1], last[2]];
}

function buildEvents(): string[] {
  const out: { t: number; v: unknown }[] = [];
  out.push({ t: 0, v: { t: 0, k: "win", cls: "chromium", title: "Acme Analytics", rect: [0, 0, W, H] } });
  for (let ms = 0; ms <= DUR * 1000; ms += 50) {
    const t = ms / 1000;
    const [x, y] = pointerAt(t);
    out.push({ t, v: { t: ms, k: "ptr", x, y } });
  }
  for (const c of CLICKS) {
    out.push({ t: c.t, v: { t: Math.round(c.t * 1000), k: "btn", b: "left", down: true } });
    out.push({ t: c.t + 0.08, v: { t: Math.round((c.t + 0.08) * 1000), k: "btn", b: "left", down: false } });
  }
  out.push({ t: DRAG.down, v: { t: DRAG.down * 1000, k: "btn", b: "left", down: true } });
  out.push({ t: DRAG.up, v: { t: DRAG.up * 1000, k: "btn", b: "left", down: false } });
  for (let t = 14.6; t <= 17.2; t += 0.3) {
    out.push({ t, v: { t: Math.round(t * 1000), k: "wheel", dx: 0, dy: 120 } });
  }
  TYPE_TEXT.split("").forEach((ch, k) => {
    const t = TYPE_T0 + k * TYPE_STEP;
    out.push({ t, v: { t: Math.round(t * 1000), k: "key", cls: ch === " " ? "space" : "char", down: true } });
  });
  return out
    .sort((a, b) => a.t - b.t)
    .map((e) => JSON.stringify(e.v));
}

// ---------------------------------------------------------------------------
// Filter builders (static coordinates only)
// ---------------------------------------------------------------------------

/** Escape a string for use inside an ffmpeg filter option value. */
function esc(s: string): string {
  return s.replace(/[\\':,%]/g, "\\$&");
}

const FONT = pickFont(FONT_CANDIDATES);
const FONT_BOLD = pickFont(FONT_BOLD_CANDIDATES);

type Draw =
  | { k: "box"; x: number; y: number; w: number | string; h: number | string; color: string; enable?: string }
  | { k: "text"; s: string; x: number; y: number; size: number; color: string; bold?: boolean; enable?: string };

const box = (x: number, y: number, w: number | string, h: number | string, color: string, enable?: string): Draw =>
  ({ k: "box", x, y, w, h, color, enable });
const text = (s: string, x: number, y: number, size: number, color: string, opts: { bold?: boolean; enable?: string } = {}): Draw =>
  ({ k: "text", s, x, y, size, color, bold: opts.bold, enable: opts.enable });

/** Serialize one draw; the mask pass replaces every color with white. */
function ser(d: Draw, mask: boolean): string {
  const color = mask ? "0xffffff" : d.color;
  if (d.k === "box") {
    return `drawbox=x=${d.x}:y=${d.y}:w='${d.w}':h='${d.h}':color=${color}:t=fill${d.enable ? `:enable='${d.enable}'` : ""}`;
  }
  return `drawtext=fontfile=${d.bold ? FONT_BOLD : FONT}:text='${esc(d.s)}':fontsize=${d.size}:fontcolor=${color}:x=${d.x}:y=${d.y}${d.enable ? `:enable='${d.enable}'` : ""}`;
}

const between = (t0: number, t1: number) => `between(t,${t0},${t1})`;
const after = (t0: number) => `gte(t,${t0})`;

/** The app chrome, scene A, scene B statics, and typing reveal. */
function baseDraws(): Draw[] {
  const d: Draw[] = [];
  d.push(box(0, 0, W, 64, "0xffffff"));
  d.push(box(0, 62, W, 2, "0xdadce0"));
  d.push(box(0, 64, 320, H - 64, "0xeef1f5"));
  d.push(box(318, 64, 2, H - 64, "0xdadce0"));
  d.push(text("Acme Analytics", 24, 16, 28, "0x202124", { bold: true }));
  d.push(box(1560, 12, 160, 40, "0x1a73e8"));
  d.push(text("Export", 1618, 22, 22, "0xffffff"));

  // nav (active highlight switches at SCENE_B)
  d.push(box(0, 116, 6, 44, "0x1a73e8", between(0, SCENE_B)));
  d.push(text("Dashboard", 48, 124, 24, "0x1a73e8", { enable: between(0, SCENE_B) }));
  d.push(text("Dashboard", 48, 124, 24, "0x5f6368", { enable: after(SCENE_B) }));
  d.push(box(0, 196, 6, 44, "0x1a73e8", after(SCENE_B)));
  d.push(text("Reports", 48, 204, 24, "0x5f6368", { enable: between(0, SCENE_B) }));
  d.push(text("Reports", 48, 204, 24, "0x1a73e8", { bold: true, enable: after(SCENE_B) }));
  d.push(text("Metrics", 48, 284, 24, "0x5f6368"));
  d.push(text("Settings", 48, 364, 24, "0x5f6368"));

  // scene A: dashboard hero (before first click)
  d.push(box(400, 140, 1400, 840, "0xffffff", between(0, SCENE_B)));
  d.push(text("Welcome to Acme Analytics", 480, 420, 56, "0x202124", { bold: true, enable: between(0, SCENE_B) }));
  d.push(text("Pick a section to get started.", 480, 520, 32, "0x5f6368", { enable: between(0, SCENE_B) }));

  // scene B: search + header live in a sticky top layer (rows scroll under it)
  // (search box drawn in chromeBDraws; placeholder + typed text in searchDraws)

  return d;
}

/** Slider fill and handle, stepped every 150 ms; drawn above the detail card. */
function sliderDraws(): Draw[] {
  const d: Draw[] = [];
  const steps = 20;
  const drawHandle = (hx: number, enable: string) => {
    d.push(box(160, 816, hx - 160, 8, "0x1a73e8", enable));
    d.push(box(hx - 12, 808, 24, 24, "0x1a73e8", enable));
    d.push(box(hx - 4, 816, 8, 8, "0xffffff", enable));
  };
  drawHandle(SLIDE.from, between(DETAIL_T, SLIDE.t0));
  for (let s = 0; s < steps; s++) {
    const t0 = SLIDE.t0 + (s * (SLIDE.t1 - SLIDE.t0)) / steps;
    const t1 = SLIDE.t0 + ((s + 1) * (SLIDE.t1 - SLIDE.t0)) / steps;
    const hx = Math.round(SLIDE.from + ((s + 1) * (SLIDE.to - SLIDE.from)) / steps);
    drawHandle(hx, between(t0, t1));
  }
  drawHandle(SLIDE.to, after(SLIDE.t1));
  return d;
}

const ROWS = [
  "Q1 revenue summary",
  "Churn analysis draft",
  "Regional sales breakdown",
  "Support tickets digest",
  "Ops cost overview",
  "Marketing funnel stats",
];

/** Transparent full-frame layer holding the six report rows at rest position. */
function rowLayerDraws(dimmed: boolean): Draw[] {
  const d: Draw[] = [];
  ROWS.forEach((label, k) => {
    const y = 320 + k * 110;
    d.push(box(400, y, 1400, 90, k % 2 === 0 ? "0xffffff" : "0xf1f3f4"));
    const match = k === 1;
    if (!dimmed) {
      d.push(text(label, 430, y + 32, 26, "0x202124"));
    } else {
      d.push(text(label, 430, y + 32, 26, match ? "0x1a73e8" : "0x9aa0a6", { bold: match }));
    }
  });
  return d;
}

/** Search text: placeholder then the typed reveal, drawn above the sticky box.
 *
 * Each character is drawn once at a measured cumulative x: stacked prefix
 * strings render with subtly different glyph advances and compound into
 * ghosted double strikes.
 */
const CHAR_W = new Map<string, number>();
function measureText(s: string): number {
  if (s === " ") return 8; // whitespace renders nothing to measure
  const cached = CHAR_W.get(s);
  if (cached !== undefined) return cached;
  const png = join(tmpdir(), `measure-${Math.random().toString(36).slice(2)}.png`);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi",
    "-i", "color=c=white:s=120x60",
    "-vf", `drawtext=fontfile=${FONT}:text='${esc(s)}':fontsize=26:fontcolor=black:x=10:y=10`,
    "-frames:v", "1", png], { stdio: ["ignore", "ignore", "ignore"] });
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", png, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { maxBuffer: 1024 * 1024 });
  rmSync(png, { force: true });
  let maxX = 0;
  for (let y = 0; y < 60; y++) {
    for (let x = 119; x > maxX; x--) {
      if (raw[(y * 120 + x) * 3]! < 128) { maxX = x; break; }
    }
  }
  const w = maxX + 1 - 10;
  CHAR_W.set(s, w);
  return w;
}

function searchDraws(): Draw[] {
  const d: Draw[] = [text("Search reports", TYPE_X, 138, 26, "0x9aa0a6", { enable: between(SCENE_B, TYPE_T0 - 0.05) })];
  let x = TYPE_X;
  TYPE_TEXT.split("").forEach((ch, k) => {
    d.push(text(ch, Math.round(x), 138, 26, "0x202124", { enable: between(TYPE_T0 + k * TYPE_STEP, DUR) }));
    x += measureText(ch);
  });
  return d;
}

/** Transparent sticky layer: list background band, search box, header. */
function chromeBDraws(): Draw[] {
  return [
    box(392, 186, 1416, 104, "0xf8f9fa"),
    box(1358, 118, 564, 68, "0xdadce0"),
    box(1360, 120, 560, 64, "0xffffff"),
    text("Quarterly Reports", 400, 232, 40, "0x202124", { bold: true }),
  ];
}

/** Transparent layer with the detail card (left side) and its fields. */
function cardLayerDraws(): Draw[] {
  return [
    box(98, 238, 944, 664, "0xdadce0"),
    box(100, 240, 940, 660, "0xffffff"),
    text("Churn analysis draft", 160, 300, 36, "0x202124", { bold: true }),
    text("Owner: Data team", 160, 380, 26, "0x5f6368"),
    text("Updated 2 hours ago", 160, 424, 26, "0x5f6368"),
    text("Retention", 160, 748, 24, "0x202124"),
    box(160, 816, 740, 8, "0xdadce0"),
  ];
}

/** Transparent layer with the export toast (below the Export button). */
function toastLayerDraws(): Draw[] {
  return [
    box(1360, 200, 500, 72, "0x188038"),
    text("Export complete", 1432, 222, 26, "0xffffff"),
  ];
}

/**
 * 24x32 arrow cursor with its hotspot at (2, 2), drawn with libass: a colour pass
 * (white arrow, dark outline) and a white mask pass give the PNG real alpha.
 */
function renderCursor(out: string): void {
  const ass = (fill: string, edge: string) => `[Script Info]
ScriptType: v4.00+
PlayResX: 24
PlayResY: 32

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Sans,20,${fill},${fill},${edge},&H00000000,0,0,0,0,100,100,0,0,1,1.3,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\an7\\pos(0,0)\\p1}m 2 2 l 2 23 l 7 18.5 l 10.5 26.5 l 14 25 l 10.5 17.5 l 17 17.5
`;
  const colour = join(tmpdir(), `synth-cursor-${process.pid}-c.ass`);
  const mask = join(tmpdir(), `synth-cursor-${process.pid}-m.ass`);
  writeFileSync(colour, ass("&H00FFFFFF", "&H00241F1C"));
  writeFileSync(mask, ass("&H00FFFFFF", "&H00FFFFFF"));
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "color=c=black:s=24x32",
    "-filter_complex", `[0:v]split[a][b];[a]ass=${colour},format=rgb24[c];[b]ass=${mask},format=gray[m];[c][m]alphamerge[out]`,
    "-map", "[out]", "-frames:v", "1", out,
  ], { stdio: ["ignore", "ignore", "inherit"] });
  rmSync(colour);
  rmSync(mask);
}

/** Render a layer spec to a PNG with real alpha via one ffmpeg call.
 *
 * This build's drawbox writes RGB but never alpha, and lumakey is broken,
 * so build the alpha channel with alphamerge: a color pass plus a white
 * mask pass of the same draws (antialiased glyph edges get partial alpha).
 */
function renderLayer(draws: Draw[], out: string, size = `${W}x${H}`): void {
  const fc = [
    `[0:v]format=rgb24,${draws.map((d) => ser(d, false)).join(",")}[c]`,
    `[1:v]format=rgb24,${draws.map((d) => ser(d, true)).join(",")},format=gray[m]`,
    `[c][m]alphamerge[out]`,
  ].join(";");
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=black:s=${size}`,
    "-f", "lavfi", "-i", `color=c=black:s=${size}`,
    "-filter_complex", fc, "-map", "[out]", "-frames:v", "1", out,
  ], { stdio: ["ignore", "ignore", "inherit"] });
}

/** Piecewise-linear overlay expression for the cursor along PATH. */
function pathExpr(axis: 1 | 2): string {
  // if(lt(t,t1), lerp(seg0), if(lt(t,t2), lerp(seg1), ... lastValue))
  const lerp = (i: number): string => {
    const t0 = PATH[i]![0];
    const t1 = PATH[i + 1]![0];
    const a = PATH[i]![axis];
    const b = PATH[i + 1]![axis];
    return `${a}+${b - a}*clip((t-${t0})/${t1 - t0},0,1)`;
  };
  let expr = String(PATH[PATH.length - 1]![axis]);
  for (let i = PATH.length - 2; i >= 0; i--) {
    const t1 = PATH[i + 1]![0];
    expr = `if(lt(t,${t1}),${lerp(i)},${expr})`;
  }
  return expr;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/synth-take.ts <output-dir>");
  process.exit(2);
}
mkdirSync(dir, { recursive: true });

writeFileSync(join(dir, "take.json"), JSON.stringify({
  id: "synth-demo",
  stream: { w: W, h: H },
  width: W,
  height: H,
  fps: FPS,
  pointer: "hyprland",
  scale: 1,
  offset_ms: 0,
  title: "Find any report in seconds",
  captions: [
    { t: 8.4, text: "Search filters as you type" },
    { t: 19.2, text: "Open a report for details" },
    { t: 22.6, d: 3.6, text: "Drag to adjust retention" },
    { t: 33.2, text: "Export in one click" },
  ],
}, null, 1) + "\n");
writeFileSync(join(dir, "frames.tsv"), "0\t0\n");
writeFileSync(join(dir, "events.jsonl"), buildEvents().join("\n") + "\n");

console.log("rendering layers ...");
const tmp = mkdtempSync(join(tmpdir(), "synthtake-"));
const rowsBright = join(tmp, "rows_bright.png");
const rowsDim = join(tmp, "rows_dim.png");
const chromeB = join(tmp, "chrome_b.png");
const card = join(tmp, "card.png");
const toast = join(tmp, "toast.png");
const cursor = join(tmp, "cursor.png");
renderLayer(rowLayerDraws(false), rowsBright);
renderLayer(rowLayerDraws(true), rowsDim);
renderLayer(chromeBDraws(), chromeB);
renderLayer(cardLayerDraws(), card);
renderLayer(toastLayerDraws(), toast);
renderCursor(cursor);

const scrollY = `-${SCROLL.max}*clip((t-${SCROLL.t0})/${SCROLL.t1 - SCROLL.t0},0,1)`;
// inputs: 0 bg color, 1 rows_bright, 2 rows_dim, 3 chromeB, 4 card, 5 toast, 6 cursor
const filterComplex = [
  `[0:v]${baseDraws().map((d) => ser(d, false)).join(",")}[base]`,
  // drawtext sets alpha (drawbox does not), so plain transparent bg + text works
  `[1:v]${searchDraws().map((d) => ser(d, false)).join(",")}[stext]`,
  `[base][2:v]overlay=0:'${scrollY}':format=auto:enable='between(t,${SCENE_B},${FILTER_T})'[a]`,
  `[a][3:v]overlay=0:'${scrollY}':format=auto:enable='between(t,${FILTER_T},${DUR})'[b]`,
  `[b][4:v]overlay=0:0:format=auto:enable='between(t,${SCENE_B},${DUR})'[c]`,
  `[c][stext]overlay=0:0:format=auto:enable='between(t,${SCENE_B},${DUR})'[s]`,
  `[s][5:v]overlay=0:0:format=auto:enable='between(t,${DETAIL_T},${DUR})',${sliderDraws().map((d) => ser(d, false)).join(",")}[d]`,
  `[d][6:v]overlay=0:0:format=auto:enable='between(t,${TOAST_T},${DUR})'[e]`,
  `[e][7:v]overlay='${pathExpr(1)}-2':'${pathExpr(2)}-2':format=auto[vout]`,
].join(";");

console.log("encoding screen.webm ...");
execFileSync("ffmpeg", [
  "-y", "-v", "error",
  "-f", "lavfi", "-i", `color=c=0xf8f9fa:s=${W}x${H}:r=${FPS}:d=${DUR}`,
  "-f", "lavfi", "-i", `color=c=black@0:s=${W}x${H}:r=${FPS}:d=${DUR},format=rgba`,
  "-loop", "1", "-t", String(DUR), "-i", rowsBright,
  "-loop", "1", "-t", String(DUR), "-i", rowsDim,
  "-loop", "1", "-t", String(DUR), "-i", chromeB,
  "-loop", "1", "-t", String(DUR), "-i", card,
  "-loop", "1", "-t", String(DUR), "-i", toast,
  "-loop", "1", "-t", String(DUR), "-i", cursor,
  "-filter_complex", filterComplex,
  "-map", "[vout]",
  "-t", String(DUR),
  "-c:v", "libvpx-vp9", "-crf", "18", "-b:v", "0", "-row-mt", "1",
  "-deadline", "good", "-cpu-used", "4", "-pix_fmt", "yuv420p",
  join(dir, "screen.webm"),
], { stdio: ["ignore", "ignore", "inherit" ] });
rmSync(tmp, { recursive: true, force: true });
console.log(`synthetic take written to ${dir}`);
