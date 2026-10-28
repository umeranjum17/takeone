// `takeone motion` argument parsing and the local planner: a complete storyboard from flags alone.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { redactScreenshot } from "./redact.ts";
import { renderMotion } from "./motion.ts";
import { tourSegments } from "./camera.ts";
import { stopTimes } from "./geometry.ts";
import { validateStateNames } from "./ingest.ts";
import { motionTokens } from "./theme.ts";
import { installHyperframes } from "./hyperframes.ts";
import { installShell } from "./shell.ts";
import { MAX_DURATION_S, minSceneDuration, readingFloor, validateStoryboard } from "./storyboard.ts";
import { planBento } from "./bento.ts";
import { planEditorial } from "./editorial.ts";
import { FILM_USAGE, newTakeDir, runFilm } from "./film.ts";
import type { Device, MotionEngine, PatternName, Region, Scene } from "./types.ts";

/** The named recipes the local planner lays out from flags: the patterns each one plays, in order. */
export const RECIPES = {
  launch: ["logo-sting", "hero-reveal", "zoom-tour", "end-card"],
  feature: ["hero-reveal", "feature-callouts", "end-card"],
  social: ["kinetic-type", "device-orbit", "spotlight", "end-card"],
  compare: ["kinetic-type", "before-after", "end-card"],
} as const satisfies Record<string, PatternName[]>;
type Recipe = keyof typeof RECIPES;
const ASPECTS = { landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080] } as const;
type Aspect = keyof typeof ASPECTS;

export const MOTION_USAGE = `takeone motion <image.png|page.html|https://url|take-dir>... [--out DIR] [--pattern hero-reveal,zoom-tour,end-card,kinetic-type,logo-sting,spotlight,feature-callouts,before-after,device-orbit]
  [--recipe launch|feature|social|compare] [--aspect landscape|portrait|square]
  [--theme midnight|paper|aurora|mono|sand|editorial]
  [--title TEXT] [--subtitle TEXT] [--cta TEXT] [--url TEXT] [--logo WORD] [--device browser|phone|laptop|none]
  [--region x,y,w,h[:label][@SCREEN]]... [--state NAME='click #id; type #id "text"; drag #a #b; wait 300']...
  [--workers N] [--blur 0|1] [--storyboard file.json] [--plan-only] [--no-ai]
  [--engine hyperframes|legacy] [--alpha] [--redaction-dry-run --out DIR] [--public-domain example.com]...
takeone motion <screenshot.png> --recipe editorial|bento --pitch TEXT [--logo WORD] [--cta TEXT] [--url TEXT] [--audio FILE] [--out DIR]
takeone motion film <video.mp4> [--intro BRIEF] [--callout "BRIEF@SECONDS"]... [--outro BRIEF] [--tech html|canvas|three] [--out DIR]
takeone motion install-shell         download the pinned chrome-headless-shell (sha256 checked)
takeone motion install-hyperframes   install hyperframes@0.8.200 + chrome-headless-shell@156.0.8078.47

  A take-dir (a directory holding take.json) plays that take's own footage, out/<id>.mp4 or else screen.webm,
  edge to edge between a title and a closing line; edit storyboard.json (clips.footage start/d/crop) to cut it.

  motion writes a take-shaped directory (take.json, sources/, storyboard.json, out/<id>.mp4, render.json);
  --alpha writes out/<id>.mov instead: ProRes 4444 with a real alpha channel, the themed backdrop dropped so
  the type, devices and footage composite over anything (hyperframes engine; no MP4 is made or transcoded).
  takeone render <dir> rerenders it. Image planning is disabled; --redaction-dry-run writes a local
  masked PNG and mask report without planning, rendering or sending an image. With no --pattern the local
  rules plan hero-reveal, zoom-tour and end-card; with three or more screens they plan a launch film
  instead: a kinetic-type title, each labelled screen announced by its own full-type beat ahead of a clean
  tour, and the end card, with black and cream beats alternating by scene order.

  --recipe launch (logo-sting, hero-reveal, zoom-tour of up to 3 stops, end-card), feature (hero-reveal,
  feature-callouts, end-card), social (kinetic-type, device-orbit, spotlight, end-card; portrait by default) and
  compare (kinetic-type, before-after, end-card) are laid out by the local rules from the same flags: --region
  x,y,w,h:label marks the lit regions (spotlight, feature-callouts need them; callouts take 2 to 5), before-after
  takes two images (or two --state names) and --subtitle as its delta line. --aspect sets the output shape for
  any plan (portrait is 1080x1920); --recipe and --pattern are exclusive.

  --recipe editorial plans an editorial launch film with the signed-in AI engine: a struck-word headline,
  the screen large on a phone with a tap, a stack of the screen's own UI lines, a four-tile canon, the
  payoff and the end card, cut on a 120 BPM grid. Only redacted text read off the screen and the pitch
  are sent; the screenshot is not. With no engine it stops and names the sign-in; there is no local plan.
  --recipe bento plans a bento launch reel the same way: five tiles (headline with a highlight wipe, op-art,
  a rolling counter with a drawing chart, a live feed, and real crops of the screen) reflow between three
  grids on the beat, then the payoff and the end card. The counter and feed are demo figures, never real data.

${FILM_USAGE.split("\n").slice(1).join("\n")}`;

export interface MotionArgs {
  inputs: string[]; out?: string; patterns?: PatternName[]; theme?: string; title?: string;
  subtitle?: string; cta?: string; url?: string; logo?: string; device?: Device; regions: string[]; states: [string, string][];
  workers?: number; blur?: number; storyboard?: string; planOnly: boolean; noAi?: boolean; engine: MotionEngine;
  recipe?: Recipe | "editorial" | "bento"; pitch?: string; audio?: string; alpha?: boolean; aspect?: Aspect;
  redactionDryRun?: boolean; publicDomains: string[];
}

export function parseMotionArgs(argv: string[]): MotionArgs {
  const a: MotionArgs = { inputs: [], regions: [], states: [], planOnly: false, engine: "hyperframes", publicDomains: [] };
  const value = (i: number, flag: string) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i]!;
    if (!s.startsWith("--")) { a.inputs.push(s); continue; }
    if (s === "--plan-only") { a.planOnly = true; continue; }
    if (s === "--redaction-dry-run") { a.redactionDryRun = true; continue; }
    if (s === "--no-ai") { a.noAi = true; continue; }
    if (s === "--alpha") { a.alpha = true; continue; }
    const v = value(++i, s);
    if (s === "--public-domain") {
      if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(v)) throw new Error("--public-domain expects one public domain, without scheme or path");
      a.publicDomains.push(v.toLowerCase());
    } else if (s === "--out") a.out = v;
    else if (s === "--pattern") a.patterns = v.split(",") as PatternName[];
    else if (s === "--theme") a.theme = v;
    else if (s === "--title") a.title = v;
    else if (s === "--subtitle") a.subtitle = v;
    else if (s === "--cta") a.cta = v;
    else if (s === "--url") a.url = v;
    else if (s === "--logo") a.logo = v;
    else if (s === "--device") a.device = v as Device;
    else if (s === "--region") a.regions.push(v);
    else if (s === "--state") {
      const m = /^([A-Za-z0-9_-]{1,64})=(.*)$/s.exec(v);
      if (!m) throw new Error(`--state expects NAME=ops, got ${v}`);
      validateStateNames([...a.states.map(([name]) => name), m[1]!]);
      a.states.push([m[1]!, m[2]!]);
    } else if (s === "--workers") a.workers = Number(v);
    else if (s === "--blur") a.blur = Number(v);
    else if (s === "--storyboard") a.storyboard = v;
    else if (s === "--recipe") {
      if (v !== "editorial" && v !== "bento" && !Object.hasOwn(RECIPES, v)) throw new Error(`--recipe expects ${[...Object.keys(RECIPES), "editorial", "bento"].join(", ")}, got ${v}`);
      a.recipe = v as Recipe | "editorial" | "bento";
    } else if (s === "--aspect") {
      if (!Object.hasOwn(ASPECTS, v)) throw new Error(`--aspect expects ${Object.keys(ASPECTS).join(", ")}, got ${v}`);
      a.aspect = v as Aspect;
    } else if (s === "--pitch") a.pitch = v;
    else if (s === "--audio") a.audio = v;
    else if (s === "--engine") {
      if (v !== "hyperframes" && v !== "legacy") throw new Error(`--engine expects hyperframes or legacy, got ${v}`);
      a.engine = v;
    } else throw new Error(`unknown option ${s}`);
  }
  return a;
}

/** "x,y,w,h[:label][@SCREEN]" -> Region. Coords are CSS px; screens capture at dsf, so scale into device px. */
export function parseRegion(spec: string, index: number, screen: string, dsf = 1): Region {
  const m = /^(-?[\d.]+),(-?[\d.]+),([\d.]+),([\d.]+)(?::([^@]*))?(?:@([A-Za-z0-9_-]+))?$/.exec(spec);
  if (!m) throw new Error(`--region expects x,y,w,h[:label][@SCREEN], got ${spec}`);
  return { id: `r${index + 1}`, rect: [Number(m[1]) * dsf, Number(m[2]) * dsf, Number(m[3]) * dsf, Number(m[4]) * dsf], screen: m[6] ?? screen,
    ...(m[5] ? { label: m[5] } : {}), from: "user" };
}

/** Wide regions read small on video: split CSS-px-wide ones into overlapping halves so every
 *  zoom-tour stop can settle close enough to read. Both halves keep the region label. */
export function splitWide(region: Region, dsf: number, maxCssW = 1100): Region[] {
  const [x, y, w, h] = region.rect;
  if (w! / dsf <= maxCssW) return [region];
  const half = w! / 2;
  return [0, 1].map(i => ({ ...region, id: `${region.id}${i ? "b" : "a"}`,
    rect: [x! + i * half, y, half, h] as Region["rect"] }));
}

export function splitStateOps(text: string): string[] {
  const ops: string[] = [];
  let start = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && quoted) { escaped = true; continue; }
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) { ops.push(text.slice(start, i).trim()); start = i + 1; }
  }
  if (quoted) throw new Error("--state: unterminated quoted text");
  ops.push(text.slice(start).trim());
  return ops.filter(Boolean);
}

/** Provisional screen dims for planning: viewport x dsf for html/url. Images stay on the
 *  legacy duration estimate because the planner never touches source files. */
function screenDims(kind: string): { width: number; height: number } | undefined {
  if (kind === "html") return { width: 2560 * 2, height: 1440 * 2 };
  if (kind === "url") return { width: 1440 * 2, height: 900 * 2 };
  return undefined;
}

/** The source kind an input names; the first input decides, since only image runs can carry several. */
export function inputKind(first: string): "url" | "html" | "image" | "take" {
  if (/^https?:\/\//.test(first)) return "url";
  try { if (statSync(first).isDirectory()) return "take"; } catch { void 0; }
  return /\.html?$/i.test(first) ? "html" : "image";
}

/** The footage an existing take offers a film: its rendered out/<id>.mp4, else the raw screen.webm. */
export function takeFootage(dir: string): { file: string; d: number } {
  const root = resolve(dir);
  if (!existsSync(join(root, "take.json"))) throw new Error(`${dir} is not a take (take.json is missing)`);
  const id = (JSON.parse(readFileSync(join(root, "take.json"), "utf8")) as { id?: unknown }).id;
  const file = [join(root, "out", `${typeof id === "string" ? id : basename(root)}.mp4`), join(root, "screen.webm")].find(existsSync);
  if (!file) throw new Error(`${dir} has no footage (out/<id>.mp4 or screen.webm); run takeone make on it first`);
  const d = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8", timeout: 30000 }).trim());
  if (!(d >= 0.25)) throw new Error(`${file}: no playable video`);
  return { file, d: Math.floor(Math.min(d, MAX_DURATION_S) * 60) / 60 };
}

/** The local plan for an existing take: a title, the take's footage edge to edge, a closing line. No planner. */
function planTake(a: MotionArgs, id: string): unknown {
  if (a.inputs.length > 1) throw new Error("a take-dir source takes one input");
  const dir = resolve(a.inputs[0]!);
  const { file, d } = takeFootage(dir);
  const statement = (title: string, extra: Partial<Scene>): Scene => {
    const scene: Scene = { pattern: "statement", d: 0, title, ...extra };
    scene.d = minSceneDuration(scene);
    return scene;
  };
  return {
    version: 1, id,
    output: { ...(a.workers !== undefined ? { workers: a.workers } : {}), ...(a.blur !== undefined ? { motion_blur: a.blur } : {}) },
    theme: { name: a.theme ?? "midnight", overrides: {} },
    source: { kind: "take", dir }, screens: Object.create(null), regions: [],
    clips: { footage: { files: [file], start: 0, d } },
    layout: { kind: "single" },
    scenes: [
      statement(a.title ?? "See it in motion.", a.subtitle ? { subtitle: a.subtitle } : {}),
      { pattern: "clip", d, clip: "footage", fill: true },
      statement(a.cta ?? "Try it today", { invert: true, ...(a.url ? { note: a.url } : {}) }),
    ],
    planner: { by: "local", abstained: [] },
  };
}

/** The local planner: pattern defaults, regions in the order given, copy from flags. */
export function planStoryboard(a: MotionArgs, id: string): unknown {
  validateStateNames(a.states.map(([name]) => name));
  const first = a.inputs[0]!;
  const kind = inputKind(first);
  if (kind === "take") return planTake(a, id);
  if (kind !== "image" && a.inputs.length > 1) throw new Error("html and url sources take one input; use --state for more screens");
  const screens = kind === "image" ? a.inputs.map((_, i) => `S${i + 1}`) : a.states.length ? a.states.map(([n]) => n) : ["S1"];
  const dsf = kind === "image" ? 1 : 2; // html/url capture at 2x so settled close-ups stay sharp
  const wideRegions = a.regions.map((r, i) => parseRegion(r, i, screens[0]!, dsf));
  const regions = wideRegions.flatMap((r) => splitWide(r, dsf));
  if (a.recipe && a.patterns) throw new Error("--recipe and --pattern are exclusive; a recipe names its own patterns");
  const recipe = a.recipe && a.recipe !== "editorial" && a.recipe !== "bento" ? a.recipe : undefined;
  const patterns: readonly PatternName[] = a.patterns ?? (recipe ? RECIPES[recipe] : ["hero-reveal", "zoom-tour", "end-card"]);
  const [outW, outH] = ASPECTS[a.aspect ?? (recipe === "social" ? "portrait" : "landscape")];
  const title = a.title ?? "See it in motion.";
  const minShot = motionTokens(a.theme ?? "midnight").min_shot;
  const tourOne = (screen: string, captioned: boolean, single = false, invert = false): Scene => {
    let stops = regions.filter(r => r.screen === screen).map(r => ({ region: r.id, ...(captioned && r.label ? { caption: r.label } : {}) }));
    if (single) {
      // Closing detail: one tight stop on the first thirds window (the landing), not a pan.
      const r = wideRegions.find(r => r.screen === screen);
      if (r) {
        const w = r.rect[2]! > 1100 * dsf ? r.rect[2]! / 3 : r.rect[2]!;
        const id = `${r.id}c`;
        regions.push({ id, rect: [r.rect[0]!, r.rect[1]!, w, r.rect[3]!], screen, from: "user" });
        stops = [{ region: id }];
      }
    }
    if (recipe === "launch") stops = stops.slice(0, 3);
    const dims = screenDims(kind);
    // Exact duration from the same segment math the renderer enforces when the screen
    // dims are known; images keep the legacy estimate because planning never reads files.
    // Either way the duration also clears every reading hold of the finished scene.
    const scene: Scene = { pattern: "zoom-tour", d: 0, screen, stops, device: a.device ?? "browser", ...(invert ? { invert } : {}) };
    const need = dims ? tourSegments(dims, outW, outH, stops.map(s => {
      const r = regions.find(r => r.id === s.region)!;
      return { rect: r.rect, caption: s.caption, hold: undefined };
    }), minShot).need : 3 + 3.5 * Math.max(1, stops.length);
    scene.d = Math.max(Math.ceil(need * 60) / 60, minSceneDuration(scene));
    return scene;
  };
  const typeBeat = (beatTitle: string, subtitle?: string): Scene => {
    const scene: Scene = { pattern: "kinetic-type", d: 0, title: beatTitle, ...(subtitle ? { subtitle } : {}) };
    scene.d = minSceneDuration(scene);
    return scene;
  };
  const plan = (p: PatternName): Scene[] => {
    if (p === "hero-reveal") return [{ pattern: p, d: 5, screen: regions[0]?.screen ?? screens[0]!, title, ...(a.subtitle ? { subtitle: a.subtitle } : {}),
      ...(regions[0] ? { focus: regions[0].id } : {}), device: a.device ?? "browser" }];
    if (p === "zoom-tour") {
      const owners = regions.length ? [...new Set(regions.map(r => r.screen))] : [screens.at(-1)!];
      return owners.map(screen => tourOne(screen, true));
    }
    if (p === "end-card") return [{ pattern: p, d: 3.5, screen: screens.at(-1)!, cta: a.cta ?? "Try it today", ...(a.url ? { url: a.url } : {}),
      logo: a.logo ?? "TakeOne" }];
    if (p === "kinetic-type") return [typeBeat(title, a.subtitle)];
    if (p === "logo-sting") return [{ pattern: p, d: 2.5, logo: a.logo ?? "TakeOne" }];
    if (p === "device-orbit") return [{ pattern: p, d: 4, screen: screens[0]!, device: a.device ?? "browser" }];
    if (p === "before-after") {
      if (screens.length < 2) throw new Error("before-after needs two screens: pass two images, or two --state names");
      const scene: Scene = { pattern: p, d: 0, screen: screens[0]!, after: screens[1]!, device: a.device ?? "browser", ...(a.subtitle ? { title: a.subtitle } : {}) };
      scene.d = Math.max(5.5, minSceneDuration(scene));
      return [scene];
    }
    if (p === "spotlight" || p === "feature-callouts") {
      // Lit regions are the wide ones whole (never split into halves) on the first region's screen, in the order given.
      const lit = wideRegions.filter(r => r.screen === wideRegions[0]?.screen);
      const need = p === "spotlight" ? 1 : 2;
      if (lit.length < need || (p === "feature-callouts" && (lit.length > 5 || lit.some(r => !r.label)))) throw new Error(`--pattern ${p} needs ${p === "spotlight" ? "at least one --region" : "2 to 5 labelled --region x,y,w,h:label"} on one screen`);
      for (const r of lit) if (!regions.some(x => x.id === r.id)) regions.push(r); // wide ones were split for tours; the lit window is the whole region
      const stops = lit.map(r => ({ region: r.id, ...(r.label ? { caption: r.label } : {}) }));
      const caps = stops.map(x => x.caption ?? ""), { end } = stopTimes(caps);
      const scene: Scene = { pattern: p, d: 0, screen: lit[0]!.screen, stops, device: a.device ?? "browser" };
      scene.d = Math.max(Math.ceil((p === "spotlight" ? end + .6 : end + .8 + readingFloor(caps.join(" "))) * 60) / 60, minSceneDuration(scene));
      return [scene];
    }
    throw new Error(`--pattern ${p} needs a storyboard (patterns planned from flags: hero-reveal, zoom-tour, end-card, kinetic-type, logo-sting, spotlight, feature-callouts, before-after, device-orbit)`);
  };
  // Launch film: no --pattern and three or more screens. The title opens on bare type, every
  // labelled screen gets its label as a full-type beat before a clean (captionless) tour, and
  // the end card closes. Beats strictly alternate cream and black by scene order. The first
  // announce beat also mounts a phone frame over a close-up crop of its own region, and with
  // three or more labels the last announce beat becomes a bento recap grid of real cropped
  // screen states. Crops are aspect-fitted top-anchored windows of regions (thirds of wide
  // ones, so three-column boards crop to whole columns), clamped to the CSS viewport.
  const launch = !a.patterns && !recipe && screens.length >= 3;
  const TILE_A = 886 / 486, PHONE_A = 367 / 756;
  const viewport = kind === "html" ? [2560, 1440] : kind === "url" ? [1440, 900] : undefined;
  const crops: Record<string, { screen: string; rect: [number, number, number, number] }> = {};
  // Crops stay exactly on thirds/regions (padding lives in the tile matte, never in the
  // crop: padded windows drag neighbour-column slivers behind the pills). Narrow regions
  // are dialog-like overlays: crop inside the dialog chrome (Tidewater: 16 px sides, 44 px
  // top puts the window just inside the modal), never the dimmed page around it.
  // Every crop window ends mid-gap, never mid-element, so no tile cuts a half label at
  // its edge: column thirds keep the header plus exactly the first card (Tidewater: lane
  // background runs to ~198, first card 200..332, gap centre ~340), dialog windows trim
  // 32 px to the whitespace above the lower labels (Tidewater: Priority label top ~724).
  // Tiles letterbox the remainder, which the matte absorbs. These are plans: ingest snaps
  // each window to whole UI on the captured pixels before cutting it (cutCrops).
  const COL_TRIM = 91, DIALOG_TRIM = 32;
  const cropWindow = (r: Region, aspect: number, third = 0): [number, number, number, number] => {
    const css: [number, number, number, number] = [r.rect[0]! / dsf, r.rect[1]! / dsf, r.rect[2]! / dsf, r.rect[3]! / dsf];
    const wide = css[2] > 1100;
    const w = wide ? css[2] / 3 : css[2] - 32;
    const w2 = w;
    let x = css[0] + (wide ? third * (css[2] / 3) : 16), y = css[1] + (wide ? 0 : 44), h = Math.max(16, w2 / aspect - (wide ? COL_TRIM : DIALOG_TRIM));
    if (viewport) {
      if (x < 0) x = 0;
      if (y < 0) y = 0;
      if (x + w2 > viewport[0]!) x = Math.max(0, viewport[0]! - w2);
      if (y + h > viewport[1]!) y = Math.max(0, viewport[1]! - h);
    }
    return [x, y, w2, h];
  };
  const crop = (id: string, screen: string, rect: [number, number, number, number]): string => {
    // Crop rects arrive in CSS px like --region inputs; screens capture at dsf.
    crops[id] = { screen, rect: rect.map(v => Math.round(v * dsf)) as [number, number, number, number] };
    return id;
  };
  const labels = screens.map(screen => regions.find(r => r.screen === screen && r.label)?.label);
  const labelled = screens.filter((_, i) => labels[i]);
  const regionOf = (screen: string) => wideRegions.find(r => r.screen === screen && r.label)!;
  const stateOps = Object.fromEntries(a.states);
  // Tour the change: screens whose states do nothing show no tour (their content already
  // rides in announce beats and the recap); with no states at all, tour every screen.
  const hasOps = (screen: string) => !a.states.length || (stateOps[screen] ?? []).length > 0;
  const bento = launch && labelled.length >= 3;
  // Phone crop: the open rail right of the first labelled region (activity feed on the demo
  // board), phone-aspect and top-anchored, starting one text inset past the rail edge;
  // thirds of the region when no usable rail exists.
  const phoneCrop = (() => {
    if (!launch || !labelled.length) return undefined;
    const s0 = labelled[0]!, r = regionOf(s0);
    const vw = viewport?.[0] ?? r.rect[0]! / dsf + r.rect[2]! / dsf;
    const vh = viewport?.[1] ?? r.rect[1]! / dsf + r.rect[3]! / dsf;
    const railX = r.rect[0]! / dsf + r.rect[2]! / dsf, railW = vw - railX, y = r.rect[1]! / dsf;
    let rect: [number, number, number, number];
    if (railW >= 300) {
      const w = Math.min(railW - 16, (vh - y) * PHONE_A), h = w / PHONE_A;
      rect = [railX + 16, y, w, h];
    } else rect = cropWindow(r, PHONE_A);
    return crop(`${s0}phone`, s0, rect.map(v => Math.round(v)) as [number, number, number, number]);
  })();
  const announce = (screen: string, i: number): Scene[] => {
    const label = labels[i];
    if (!label) return [];
    if (bento && i === screens.length - 1) return [];
    // Type words pair with their own line or none: bare announcements, never borrowed copy.
    const beat: Scene = screen === labelled[0] && phoneCrop
      ? { pattern: "kinetic-type", d: 0, title: label, device: "phone", screen: phoneCrop }
      : { pattern: "kinetic-type", d: 0, title: label };
    beat.d = minSceneDuration(beat);
    return [beat];
  };
  const recap = (): Scene[] => {
    if (!bento) return [];
    const [s0, s1, s2] = [labelled[0]!, labelled[1]!, labelled[labelled.length - 1]!];
    // Each labelled state's tile wears its label pill; the second board tile repeats s0's.
    const title = (s: string) => labels[screens.indexOf(s)]!;
    const tiles = [
      { title: title(s0), screen: crop(`${s0}c0`, s0, cropWindow(regionOf(s0), TILE_A)) },
      { title: title(s1), screen: crop(`${s1}c0`, s1, cropWindow(regionOf(s1), TILE_A)) },
      { title: title(s2), screen: crop(`${s2}c0`, s2, cropWindow(regionOf(s2), TILE_A, 2)) },
      { title: "", screen: crop(`${s0}c1`, s0, cropWindow(regionOf(s0), TILE_A, 1)) },
    ];
    const scene: Scene = { pattern: "bento", d: 0, tiles };
    scene.d = minSceneDuration(scene);
    return [scene];
  };
  const tourFor = (screen: string, i: number): Scene[] => {
    if (!hasOps(screen)) return [];
    return [tourOne(screen, false, i === screens.length - 1)];
  };
  // No two adjacent beats share a tone: alternate from the cream title, through the
  // checkered bento (neutral) to the black end card.
  const alternate = (list: Scene[]): Scene[] => {
    let tone = true; // the title opens cream, then every cut flips
    return list.map(s => {
      if (s.pattern === "bento") return { ...s, invert: false };
      if (s.pattern === "end-card") { tone = true; return { ...s, invert: true }; }
      tone = !tone;
      return tone ? { ...s, invert: true } : s;
    });
  };
  const scenes: Scene[] = !launch ? patterns.flatMap(plan).map((s, i) => (i % 2 ? { ...s, invert: true } : s)) : alternate([
    typeBeat(title, a.subtitle),
    ...screens.flatMap((screen, i) => [...(bento && i === screens.length - 1 ? recap() : []), ...announce(screen, i), ...tourFor(screen, i)]),
    ...plan("end-card"),
  ]);
  const source = kind === "image" ? { kind, files: a.inputs.map((f) => resolve(f)) }
    : kind === "html" ? { kind, file: resolve(first), viewport: [2560, 1440], dsf, states: Object.fromEntries(a.states.map(([n, ops]) => [n, splitStateOps(ops)])) }
    : { kind, url: first, viewport: [1440, 900], dsf: 2, states: Object.fromEntries(a.states.map(([n, ops]) => [n, splitStateOps(ops)])) };
  return {
    version: 1, id,
    output: { out_w: outW, out_h: outH, ...(a.workers !== undefined ? { workers: a.workers } : {}), ...(a.blur !== undefined ? { motion_blur: a.blur } : {}) },
    theme: { name: a.theme ?? "midnight", overrides: {} },
    source, screens: Object.create(null), regions, ...(Object.keys(crops).length ? { crops } : {}),
    layout: { kind: "single" }, scenes,
    planner: { by: "local", abstained: [] },
  };
}

export interface PlanOptions {
  /** Warning sink; defaults to stderr. */
  warn?: (line: string) => void;
}

/** The storyboard for a motion run. AI image planning is off until screenshots can be redacted, so an
 *  image-only run makes no planner call and every run gets the local plan. */
export async function planMotion(a: MotionArgs, id: string, o: PlanOptions = {}): Promise<unknown> {
  const local = planStoryboard(a, id);
  if (a.noAi || !a.inputs.length || inputKind(a.inputs[0]!) !== "image") return local;
  const warn = o.warn ?? ((line: string) => console.error(line));
  warn("motion: AI image planning is OFF until screenshots can be redacted; this film uses the local rules " +
    "and no screenshot is sent to a planner.");
  return local;
}

export async function runMotion(argv: string[], takesDir: string, o: PlanOptions = {}): Promise<number> {
  if (argv[0] === "install-shell") {
    const shell = await installShell();
    console.log(`chrome-headless-shell ${shell.version} sha256 ${shell.sha256}\n${shell.path}`);
    return 0;
  }
  if (argv[0] === "install-hyperframes") {
    const hf = await installHyperframes();
    console.log(`hyperframes ${hf.version}\n${hf.cli}\n${hf.browserVersion} sha256 ${hf.browserSha256}\n${hf.browser}`);
    return 0;
  }
  if (argv[0] === "film") return await runFilm(argv.slice(1), takesDir, o.warn);
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) { console.error(MOTION_USAGE); return argv.length ? 0 : 2; }
  const a = parseMotionArgs(argv);
  if (a.publicDomains.length && !a.redactionDryRun) throw new Error("--public-domain applies only to --redaction-dry-run");
  if (a.redactionDryRun) {
    if (!a.out || !a.inputs.length || a.storyboard || a.inputs.some(f => inputKind(f) !== "image"))
      throw new Error("--redaction-dry-run needs PNG image inputs and --out DIR; no storyboard or URL");
    for (const f of a.inputs) if (!existsSync(f)) throw new Error("redaction input missing; image not sent");
    const dir = resolve(a.out);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const report = a.inputs.map((f, i) => redactScreenshot(f, join(dir, `screen-${i + 1}.png`), a.publicDomains));
    writeFileSync(join(dir, "redaction-report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    const failed = report.flatMap(r => r.scanClean ? [] : r.residual.filter(h => h.pass === 3));
    if (failed.length) {
      const counts = [...new Set(failed.map(h => h.kind))].map(k => `${k}:${failed.filter(h => h.kind === k).length}`).join(", ");
      throw new Error(`redaction still detects ${counts} after 3 passes; image not sent. Inspect redaction-report.json`);
    }
    console.log(join(dir, "redaction-report.json"));
    return 0;
  }
  let storyboard: unknown;
  let id: string;
  if (a.storyboard) {
    storyboard = JSON.parse(readFileSync(a.storyboard, "utf8"));
    id = String((storyboard as { id?: unknown }).id ?? basename(a.storyboard, extname(a.storyboard)));
  } else {
    if (!a.inputs.length) throw new Error("motion needs an input (image, .html or URL) or --storyboard");
    for (const f of a.inputs) if (!/^https?:\/\//.test(f) && !existsSync(f)) throw new Error(`no such input ${f}`);
    id = "motion";
    if (a.recipe === "editorial" || a.recipe === "bento") {
      if (a.noAi) throw new Error(`--recipe ${a.recipe} is planned by the AI engine; there is no --no-ai plan for it`);
      const plan = a.recipe === "bento" ? planBento : planEditorial;
      storyboard = await plan(a, id, o.warn ?? ((line: string) => console.error(line)));
    } else storyboard = await planMotion(a, id, o);
  }
  const sb = validateStoryboard(storyboard); // refuse bad plans before touching the disk
  const dir = newTakeDir(a.out, takesDir);
  writeFileSync(join(dir, "storyboard.json"), JSON.stringify(sb, null, 2) + "\n");
  writeFileSync(join(dir, "take.json"), JSON.stringify({ id: basename(dir), theme: sb.theme.name,
    motion: { pattern: sb.scenes.map((s) => s.pattern).join("+"), storyboard: "storyboard.json" } }, null, 2) + "\n");
  if (a.planOnly) { console.log(join(dir, "storyboard.json")); return 0; }
  const { out, manifest } = await renderMotion(dir, { engine: a.engine, alpha: a.alpha });
  console.error(`motion: ${manifest.frames} frames ${manifest.width}x${manifest.height}@${manifest.fps} on ${manifest.workers} workers in ${manifest.render_s} s`);
  console.log(out);
  return 0;
}

/** True when a take dir is a motion take (rerendered by renderMotion, not the recording renderer). */
export function isMotionTake(dir: string): boolean {
  try { return !!(JSON.parse(readFileSync(join(dir, "take.json"), "utf8")) as { motion?: unknown }).motion; } catch { return false; }
}
