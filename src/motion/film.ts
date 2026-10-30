// `takeone motion film <video>`: the real recording, framed by model-written motion segments. The signed-in
// engine writes each segment as one offline HTML page (DOM, Canvas, SVG or Three.js); every page is rendered
// and checked before the film is planned, and the film plays them full-frame around the footage untouched.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { MemoryCache, type Answer } from "@byokit/decide";
import { CallBudget } from "../decide/budget.ts";
import { askChunk } from "../decide/planner.ts";
import { signedInPlanner } from "./editorial.ts";
import { referenceCuts } from "./reference.ts";
import { renderMotion } from "./motion.ts";
import { ingestSegments } from "./segment.ts";
import { validateStoryboard } from "./storyboard.ts";
import type { MotionEngine, Scene, Segment, Storyboard } from "./types.ts";

export type Tech = "html" | "canvas" | "three";
export type Kind = "intro" | "callout" | "outro";
export interface Piece { kind: Kind; /** A page to use as it is, or a brief for the model to write one from. */ source: string; at?: number }
export interface FilmArgs { video: string; pieces: Piece[]; tech: Tech; out?: string; workers?: number; engine: MotionEngine; /** A reference film to cut the footage on: a video to measure, or a facts.json from --measure. */ reference?: string; /** Its measured beats, filled in by runFilm. */ beats?: number[] }

export const FILM_USAGE = `takeone motion film <video.mp4> [--intro BRIEF|page.html] [--callout "BRIEF@SECONDS"|page.html@SECONDS]... [--outro BRIEF|page.html]
  [--tech html|canvas|three] [--reference <video|facts.json>] [--out DIR] [--workers N]
  writes model-made motion segments around the real recording: the signed-in AI engine writes each segment from its
  brief as one offline page, TakeOne renders it, and the film plays it full-frame before, inside or after the footage.
  A .html path in place of a brief is used as written. Only the briefs are sent to the engine, never the video.
  --reference cuts the footage on another film's measured beats instead of exactly where the callout asked.`;

const SEGMENT_S = 3;
const KINDS: Record<Kind, string> = {
  intro: "an opening title card: the product's name or promise, the first thing a viewer sees before the real screen recording",
  callout: "a feature callout between two moments of the real recording: one idea shown big, then the recording resumes",
  outro: "a closing card: what to remember and the call to action, the last thing a viewer sees after the real recording",
};
const TECH: Record<Tech, string> = {
  html: "DOM and CSS (SVG allowed), every property set from t in seek",
  canvas: "a 2D canvas filling the page, redrawn from t in seek",
  three: "Three.js: the global THREE (r149) is already loaded, so add no script tag for it; render with a WebGLRenderer onto a canvas of innerWidth x innerHeight (setSize(w, h, false)) inside seek",
};

const ask = (kind: Kind, tech: Tech, w: number, h: number) =>
  `Write ${KINDS[kind]} for a product demo video: one complete, self-contained HTML page that renders ${SEGMENT_S} seconds of motion, shown full-frame at ${w}x${h}. Technology: ${TECH[tech]}. `
  + "Rules the renderer enforces: "
  + `define window.takeoneSegment = { seek(t) { ... } } where t runs from 0 to ${SEGMENT_S} seconds and seek draws the whole frame for that time as a pure function of t (no setInterval, requestAnimationFrame loop, Date.now, performance.now or state carried between calls), and call seek(0) once at the end of the script; `
  + "inline everything: no external URL, font, image or script (use system-ui and ui-monospace font stacks); size everything from innerWidth and innerHeight or vw and vh so the same page works at 16:9, 9:16 and 1:1; "
  + "keep every DOM text element inside the frame's 5% inset at every time, so fade and nudge text by a fraction of its size and never slide it in from outside the frame; "
  + "open on picture and hold the finished composition still for the last half second, so the first and last frames are never blank; make the type large and few words. "
  + "Use only what the brief says; never invent a feature, number or claim. Answer yes and give html: the whole page, starting with <!doctype html>.";

/** The film's size: the footage's own, with its long edge at most 1920 px. */
export function filmSize(w: number, h: number): [number, number] {
  const k = Math.min(1, 1920 / Math.max(w, h)), even = (v: number) => Math.max(16, 2 * Math.round(v * k / 2));
  return [even(w), even(h)];
}

/** The storyboard: intro, then the footage in windows cut at each callout, then the outro. Pure. */
export function filmStoryboard(a: FilmArgs, id: string, probe: { width: number; height: number; duration: number }): unknown {
  const fps = 60, snap = (s: number) => Math.round(s * fps) / fps, end = Math.floor(probe.duration * fps) / fps;
  const [out_w, out_h] = filmSize(probe.width, probe.height);
  const callouts = a.pieces.filter(p => p.kind === "callout").sort((x, y) => x.at! - y.at!);
  const cuts: number[] = [];
  for (const p of callouts) {
    // A measured reference beat moves the cut, when one still falls inside the same limits the cut has to meet.
    const low = Math.max(1, (cuts.at(-1) ?? 0) + 1), asked = snap(p.at!);
    const beat = (a.beats ?? []).filter(b => b >= low && b <= end - 1).sort((x, y) => Math.abs(x - asked) - Math.abs(y - asked))[0];
    cuts.push(snap(beat ?? asked));
  }
  cuts.forEach((t, i) => { if (t < 1 || t > end - 1 || t - (cuts[i - 1] ?? 0) < 1) throw new Error(`--callout at ${t} s must fall at least 1 s into the ${end.toFixed(2)} s footage and 1 s after the previous cut`); });
  const segments: Record<string, Segment> = {}, clips: Record<string, unknown> = {}, scenes: Scene[] = [];
  const segment = (key: string) => { segments[key] = { file: `segments/${key}.html`, d: SEGMENT_S }; scenes.push({ pattern: "segment", d: SEGMENT_S, segment: key, cut: true }); };
  const intro = a.pieces.some(p => p.kind === "intro"), outro = a.pieces.some(p => p.kind === "outro");
  if (intro) segment("intro");
  [0, ...cuts].forEach((from, i) => {
    const to = cuts[i] ?? end;
    clips[`footage${i + 1}`] = { files: [resolve(a.video)], start: from, d: snap(to - from) };
    scenes.push({ pattern: "clip", d: snap(to - from), clip: `footage${i + 1}`, fill: true, cut: true });
    if (callouts[i]) segment(`callout${i + 1}`);
  });
  if (outro) segment("outro");
  return {
    version: 1, id, output: { out_w, out_h, ...(a.workers !== undefined ? { workers: a.workers } : {}) },
    theme: { name: "mono", overrides: {} }, source: { kind: "image", files: [] }, screens: {}, regions: [], layout: { kind: "single" },
    clips, segments, scenes, planner: { by: "ai", abstained: [] },
  };
}

/** The pages for a film's segments, written under dir/segments/: a given page is copied, a brief is written by the engine. */
async function writePages(dir: string, a: FilmArgs, board: Storyboard, budget: CallBudget, log: (line: string) => void): Promise<void> {
  mkdirSync(join(dir, "segments"), { recursive: true });
  const named = [["intro", a.pieces.find(p => p.kind === "intro")], ["outro", a.pieces.find(p => p.kind === "outro")],
    ...a.pieces.filter(p => p.kind === "callout").sort((x, y) => x.at! - y.at!).map((p, i) => [`callout${i + 1}`, p] as const)] as const;
  let planner: Awaited<ReturnType<typeof signedInPlanner>> | undefined;
  for (const [key, piece] of named) {
    if (!piece) continue;
    const segments = board.segments!, page = join(dir, segments[key]!.file);
    if (existsSync(piece.source) && /\.html?$/i.test(piece.source)) { copyFileSync(resolve(piece.source), page); continue; }
    planner ??= await signedInPlanner();
    log(`motion: ${planner.label} writes the ${key} segment`);
    // A page that breaks the renderer's contract is asked again once, with what it broke; a second miss stops and says why.
    for (let retry: Record<string, unknown> | undefined, attempt = 0; ; attempt++) {
      const state = { brief: piece.source, kind: piece.kind, frame: { width: board.output.out_w, height: board.output.out_h }, ...(retry ? { retry } : {}) };
      const outcome = await askChunk(state, { page: { kind: "yesno", question: ask(piece.kind, a.tech, board.output.out_w, board.output.out_h), answerFields: ["html"] } }, planner, new MemoryCache(), { timeoutMs: 300_000, keepAnswers: true, budget, workflow: "motion film" });
      const answer: Answer | undefined = outcome.answers?.["page"];
      const html = (answer as unknown as { html?: unknown } | undefined)?.html;
      if (!answer || answer.abstained || answer.answer !== true || typeof html !== "string") throw new Error(`the ${key} segment got no page from the planner (${outcome.failure ?? answer?.reason ?? "no answer"}); rerun to ask again`);
      writeFileSync(page, html);
      try { await ingestSegments(dir, { output: board.output, segments: { [key]: segments[key]! } }, log); break; } catch (e) {
        if (attempt > 0) throw new Error(`${(e as Error).message} (the page is kept at ${page})`);
        log(`motion: ${(e as Error).message}; asking again`);
        retry = { previous_html: html, problem: (e as Error).message };
      }
    }
  }
}

/** A new take directory: --out as given, else a timestamped one under the takes root. */
export function newTakeDir(out: string | undefined, takesDir: string): string {
  if (out !== undefined) { mkdirSync(resolve(out), { recursive: true }); return resolve(out); }
  mkdirSync(takesDir, { recursive: true });
  const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
  const name = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  for (let suffix = 0; ; suffix++) {
    const dir = resolve(takesDir, suffix ? `${name}-${suffix}` : name);
    try { mkdirSync(dir, { mode: 0o700 }); return dir; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
}

export function parseFilmArgs(argv: string[]): FilmArgs {
  const a: FilmArgs = { video: "", pieces: [], tech: "html", engine: "hyperframes" };
  const value = (i: number, flag: string) => { const v = argv[i]; if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`); return v; };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i]!;
    if (!s.startsWith("--")) { if (a.video) throw new Error(`film takes one video, got ${a.video} and ${s}`); a.video = s; continue; }
    const v = value(++i, s);
    if (s === "--intro" || s === "--outro") a.pieces.push({ kind: s.slice(2) as Kind, source: v });
    else if (s === "--callout") {
      const m = /^([\s\S]+)@(\d+(?:\.\d+)?)$/.exec(v);
      if (!m) throw new Error(`--callout expects "BRIEF@SECONDS", got ${v}`);
      a.pieces.push({ kind: "callout", source: m[1]!, at: Number(m[2]) });
    } else if (s === "--tech") {
      if (!["html", "canvas", "three"].includes(v)) throw new Error(`--tech expects html, canvas or three, got ${v}`);
      a.tech = v as Tech;
    } else if (s === "--out") a.out = v;
    else if (s === "--reference") a.reference = v;
    else if (s === "--workers") a.workers = Number(v);
    else throw new Error(`unknown option ${s}`);
  }
  if (!a.video) throw new Error("film needs the recording to frame: takeone motion film <video.mp4>");
  if (!a.pieces.length) throw new Error("film needs at least one of --intro, --callout, --outro");
  for (const k of ["intro", "outro"] as const) if (a.pieces.filter(p => p.kind === k).length > 1) throw new Error(`--${k} may be given once`);
  for (const p of a.pieces) if (p.source.length > 600) throw new Error(`a brief is at most 600 characters, got ${p.source.length}`);
  return a;
}

export async function runFilm(argv: string[], takesDir: string, log: (line: string) => void = (l) => console.error(l)): Promise<number> {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) { console.error(FILM_USAGE); return argv.length ? 0 : 2; }
  const a = parseFilmArgs(argv);
  if (!existsSync(a.video)) throw new Error(`no such video ${a.video}`);
  const [width, height, duration] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "csv=p=0:s=,", a.video], { encoding: "utf8" })
    .trim().split(/[,\n]/).map(Number) as [number, number, number];
  if (!(width > 0 && height > 0 && duration > 0)) throw new Error(`${a.video}: ffprobe found no video stream`);
  const dir = newTakeDir(a.out, takesDir);
  if (a.reference) a.beats = await referenceCuts(a.reference, join(dir, "reference"), log);
  const board = validateStoryboard(filmStoryboard(a, basename(a.video).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "film", { width, height, duration }));
  const budget = new CallBudget(dir);
  await writePages(dir, a, board, budget, log);
  writeFileSync(join(dir, "storyboard.json"), JSON.stringify(board, null, 2) + "\n");
  writeFileSync(join(dir, "take.json"), JSON.stringify({ id: basename(dir), theme: board.theme.name, motion: { pattern: board.scenes.map(s => s.pattern).join("+"), storyboard: "storyboard.json" }, calls: budget.summary() }, null, 2) + "\n");
  const { out, manifest } = await renderMotion(dir, { engine: a.engine, workers: a.workers });
  log(`motion: ${manifest.frames} frames ${manifest.width}x${manifest.height}@${manifest.fps} on ${manifest.workers} workers in ${manifest.render_s} s`);
  console.log(out);
  return 0;
}
