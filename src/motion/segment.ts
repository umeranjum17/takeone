// Model-written motion segments: one HTML page (DOM, Canvas, SVG or Three.js) rendered offline to a video the
// film plays full-frame beside real footage. The page is untrusted code, so it only ever runs in the pinned
// headless shell with the network off; every fetch it tries fails the render by name.
//
// Contract: the page defines window.takeoneSegment = { seek(t) } (t in seconds, a pure function of t: no clocks,
// no rAF loop, no state carried between frames) and may set window.takeoneReady to a promise for its assets.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { renderFrames, MOTION_CRF } from "./render.ts";
import { pinnedShell } from "./shell.ts";
import type { Segment, Storyboard } from "./types.ts";

// The classic global build of three r149 (MIT, the last release that ships one), from the pinned dependency.
const THREE = join(dirname(createRequire(import.meta.url).resolve("three")), "three.min.js");
const HARNESS_VERSION = 1;

/** The renderer's end of the contract: it seeks the page by time and refuses frames whose text leaves the 5% inset. */
const harness = (w: number, h: number) => `<script>(() => {
  // Math.random restarts on every seek, so a page that draws noise gets the same noise at the same time on every run.
  const seeded = () => { let a = 0x9e3779b9; Math.random = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  seeded();
  const outside = () => {
    const x0 = ${w} * 0.05 - 0.5, y0 = ${h} * 0.05 - 0.5, x1 = ${w} * 0.95 + 0.5, y1 = ${h} * 0.95 + 0.5;
    for (const el of document.body.querySelectorAll("*")) {
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      let o = 1;
      for (let e = el; e && o > 0.02; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      if (o <= 0.02 || cs.visibility === "hidden" || cs.display === "none" || !r.width || !r.height) continue;
      if (r.left < x0 || r.top < y0 || r.right > x1 || r.bottom > y1) return el.textContent.trim().slice(0, 40) + " at " + [r.left, r.top, r.right, r.bottom].map(Math.round).join(",");
    }
    return "";
  };
  window.ready = (async () => {
    await window.takeoneReady; await document.fonts.ready;
    if (typeof window.takeoneSegment?.seek !== "function") throw new Error("the page defines no window.takeoneSegment.seek(t)");
  })();
  window.installSeek = () => {
    window.__seek = async (ms) => {
      seeded();
      window.takeoneSegment.seek(ms / 1000);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const bad = outside();
      if (bad) throw new Error("text outside the 5% safe inset at " + (ms / 1000).toFixed(3) + " s: " + bad);
    };
  };
})();</script>`;

/** The page as it renders: Three.js inlined when the page uses it, the harness last. */
function wrapped(html: string, w: number, h: number): string {
  const at = html.search(/<script\b|<\/head>|<body\b/i);
  const three = /\bTHREE\b/.test(html) ? `<script>${readFileSync(THREE, "utf8")}</script>` : "";
  const cut = at < 0 ? html.length : at;
  return `${html.slice(0, cut)}${three}${html.slice(cut)}${harness(w, h)}`;
}

/** What a segment render needs from a storyboard: the film size and the segments. */
export type SegmentFilm = Pick<Storyboard, "output" | "segments">;

const file = (dir: string, f: string) => (isAbsolute(f) ? f : resolve(dir, f));

function fingerprint(dir: string, sb: SegmentFilm, seg: Segment): string {
  const html = readFileSync(file(dir, seg.file), "utf8");
  return createHash("sha256").update(JSON.stringify([HARNESS_VERSION, html, seg.d, sb.output.out_w, sb.output.out_h, sb.output.preset])).digest("hex");
}

/** True when a segment has no rendered video for its current page, length and film size. */
export function segmentStale(dir: string, sb: SegmentFilm, id: string): boolean {
  const seg = sb.segments![id]!;
  if (!seg.video || !existsSync(join(dir, seg.video))) return true;
  return seg.made?.sha256 !== fingerprint(dir, sb, seg);
}

/** Render every stale segment to sources/segments/<id>.mp4 at the film's size and 60 fps. */
export async function ingestSegments(dir: string, sb: SegmentFilm, log: (line: string) => void = () => {}): Promise<void> {
  const { out_w: width, out_h: height, fps } = sb.output;
  for (const [id, seg] of Object.entries(sb.segments ?? {})) {
    if (!segmentStale(dir, sb, id)) continue;
    const page = join(dir, ".motion", "segments", `${id}.html`), video = `sources/segments/${id}.mp4`;
    mkdirSync(join(dir, ".motion", "segments"), { recursive: true });
    mkdirSync(join(dir, "sources", "segments"), { recursive: true });
    writeFileSync(page, wrapped(readFileSync(file(dir, seg.file), "utf8"), width, height));
    const frames = Math.round(seg.d * fps);
    log(`motion: rendering segment ${id} (${frames} frames, ${width}x${height})`);
    try {
      await renderFrames({ html: page, width, height, fps, frames, workers: Math.min(sb.output.workers, 4), mp4: join(dir, video), crf: MOTION_CRF, preset: sb.output.preset, shell: await pinnedShell() });
    } catch (e) {
      rmSync(join(dir, video), { force: true });
      throw new Error(`segment ${id} (${seg.file}): ${(e as Error).message}`);
    }
    seg.video = video;
    seg.made = { sha256: fingerprint(dir, sb, seg), width, height };
  }
}
