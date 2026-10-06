// `takeone motion` argument parsing and the local planner: a complete storyboard from flags alone.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { renderMotion } from "./motion.ts";
import { tourSegments } from "./camera.ts";
import { validateStateNames } from "./ingest.ts";
import { motionTokens } from "./theme.ts";
import { installShell } from "./shell.ts";
import { minSceneDuration, validateStoryboard } from "./storyboard.ts";
import type { Device, PatternName, Region, Scene } from "./types.ts";

export const MOTION_USAGE = `takeone motion <image.png|page.html|https://url>... [--out DIR] [--pattern hero-reveal,zoom-tour,end-card,kinetic-type]
  [--theme midnight|paper|aurora|mono|sand|editorial]
  [--title TEXT] [--subtitle TEXT] [--cta TEXT] [--url TEXT] [--logo WORD] [--device browser|phone|laptop|none]
  [--region x,y,w,h[:label][@SCREEN]]... [--state NAME='click #id; type #id "text"; drag #a #b; wait 300']...
  [--workers N] [--blur 0|1] [--storyboard file.json] [--plan-only]
takeone motion install-shell     download the pinned chrome-headless-shell (sha256 checked)

  motion writes a take-shaped directory (take.json, sources/, storyboard.json, out/<id>.mp4, render.json);
  takeone render <dir> rerenders it. With no --pattern it plans hero-reveal, zoom-tour and end-card;
  with three or more screens it plans a launch film instead: a kinetic-type title, each labelled
  screen announced by its own full-type beat ahead of a clean tour, and the end card, with
  black and cream beats alternating by scene order.`;

interface MotionArgs {
  inputs: string[]; out?: string; patterns?: PatternName[]; theme?: string; title?: string;
  subtitle?: string; cta?: string; url?: string; logo?: string; device?: Device; regions: string[]; states: [string, string][];
  workers?: number; blur?: number; storyboard?: string; planOnly: boolean;
}

export function parseMotionArgs(argv: string[]): MotionArgs {
  const a: MotionArgs = { inputs: [], regions: [], states: [], planOnly: false };
  const value = (i: number, flag: string) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i]!;
    if (!s.startsWith("--")) { a.inputs.push(s); continue; }
    if (s === "--plan-only") { a.planOnly = true; continue; }
    const v = value(++i, s);
    if (s === "--out") a.out = v;
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
    else throw new Error(`unknown option ${s}`);
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

/** The local planner: pattern defaults, regions in the order given, copy from flags. */
export function planStoryboard(a: MotionArgs, id: string): unknown {
  validateStateNames(a.states.map(([name]) => name));
  const first = a.inputs[0]!;
  const kind = /^https?:\/\//.test(first) ? "url" : /\.html?$/i.test(first) ? "html" : "image";
  if (kind !== "image" && a.inputs.length > 1) throw new Error("html and url sources take one input; use --state for more screens");
  const screens = kind === "image" ? a.inputs.map((_, i) => `S${i + 1}`) : a.states.length ? a.states.map(([n]) => n) : ["S1"];
  const dsf = kind === "image" ? 1 : 2; // html/url capture at 2x so settled close-ups stay sharp
  const wideRegions = a.regions.map((r, i) => parseRegion(r, i, screens[0]!, dsf));
  const regions = wideRegions.flatMap((r) => splitWide(r, dsf));
  const patterns = a.patterns ?? (["hero-reveal", "zoom-tour", "end-card"] as PatternName[]);
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
    const dims = screenDims(kind);
    // Exact duration from the same segment math the renderer enforces when the screen
    // dims are known; images keep the legacy estimate because planning never reads files.
    // Either way the duration also clears every reading hold of the finished scene.
    const scene: Scene = { pattern: "zoom-tour", d: 0, screen, stops, device: a.device ?? "browser", ...(invert ? { invert } : {}) };
    const need = dims ? tourSegments(dims, 1920, 1080, stops.map(s => {
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
    throw new Error(`--pattern ${p} needs a storyboard (core patterns: hero-reveal, zoom-tour, end-card, kinetic-type)`);
  };
  // Launch film: no --pattern and three or more screens. The title opens on bare type, every
  // labelled screen gets its label as a full-type beat before a clean (captionless) tour, and
  // the end card closes. Beats strictly alternate cream and black by scene order. The first
  // announce beat also mounts a phone frame over a close-up crop of its own region, and with
  // three or more labels the last announce beat becomes a bento recap grid of real cropped
  // screen states. Crops are aspect-fitted top-anchored windows of regions (thirds of wide
  // ones, so three-column boards crop to whole columns), clamped to the CSS viewport.
  const launch = !a.patterns && screens.length >= 3;
  const TILE_A = 886 / 486, PHONE_A = 367 / 756;
  const viewport = kind === "html" ? [2560, 1440] : kind === "url" ? [1440, 900] : undefined;
  const crops: Record<string, { screen: string; rect: [number, number, number, number] }> = {};
  // Crops stay exactly on thirds/regions (padding lives in the tile matte, never in the
  // crop: padded windows drag neighbour-column slivers behind the pills). Narrow regions
  // are dialog-like overlays: crop inside the dialog chrome (Tidewater: 16 px sides, 44 px
  // top puts the window just inside the modal), never the dimmed page around it.
  const cropWindow = (r: Region, aspect: number, third = 0): [number, number, number, number] => {
    const css: [number, number, number, number] = [r.rect[0]! / dsf, r.rect[1]! / dsf, r.rect[2]! / dsf, r.rect[3]! / dsf];
    const wide = css[2] > 1100;
    const w = wide ? css[2] / 3 : css[2] - 32;
    const w2 = w;
    let x = css[0] + (wide ? third * (css[2] / 3) : 16), y = css[1] + (wide ? 0 : 44), h = w2 / aspect;
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
    // Only the dialog tile keeps a pill; column tiles are named by their headers already.
    const tiles = [
      { title: "", screen: crop(`${s0}c0`, s0, cropWindow(regionOf(s0), TILE_A)) },
      { title: labels[screens.indexOf(s1)]!, screen: crop(`${s1}c0`, s1, cropWindow(regionOf(s1), TILE_A)) },
      { title: "", screen: crop(`${s2}c0`, s2, cropWindow(regionOf(s2), TILE_A, 2)) },
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
    output: { ...(a.workers !== undefined ? { workers: a.workers } : {}), ...(a.blur !== undefined ? { motion_blur: a.blur } : {}) },
    theme: { name: a.theme ?? "midnight", overrides: {} },
    source, screens: Object.create(null), regions, ...(Object.keys(crops).length ? { crops } : {}),
    layout: { kind: "single" }, scenes,
    planner: { by: "local", abstained: [] },
  };
}

function stamp(): string {
  const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function runMotion(argv: string[], takesDir: string): Promise<number> {
  if (argv[0] === "install-shell") {
    const shell = await installShell();
    console.log(`chrome-headless-shell ${shell.version} sha256 ${shell.sha256}\n${shell.path}`);
    return 0;
  }
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) { console.error(MOTION_USAGE); return argv.length ? 0 : 2; }
  const a = parseMotionArgs(argv);
  let storyboard: unknown;
  let id: string;
  if (a.storyboard) {
    storyboard = JSON.parse(readFileSync(a.storyboard, "utf8"));
    id = String((storyboard as { id?: unknown }).id ?? basename(a.storyboard, extname(a.storyboard)));
  } else {
    if (!a.inputs.length) throw new Error("motion needs an input (image, .html or URL) or --storyboard");
    for (const f of a.inputs) if (!/^https?:\/\//.test(f) && !existsSync(f)) throw new Error(`no such input ${f}`);
    id = "motion";
    storyboard = planStoryboard(a, id);
  }
  const sb = validateStoryboard(storyboard); // refuse bad plans before touching the disk
  let dir: string;
  if (a.out !== undefined) {
    dir = resolve(a.out);
    mkdirSync(dir, { recursive: true });
  } else {
    mkdirSync(takesDir, { recursive: true });
    const name = stamp();
    dir = resolve(takesDir, name);
    for (let suffix = 1; ; suffix++) {
      try { mkdirSync(dir, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        dir = resolve(takesDir, `${name}-${suffix}`);
      }
    }
  }
  writeFileSync(join(dir, "storyboard.json"), JSON.stringify(sb, null, 2) + "\n");
  writeFileSync(join(dir, "take.json"), JSON.stringify({ id: basename(dir), theme: sb.theme.name,
    motion: { pattern: sb.scenes.map((s) => s.pattern).join("+"), storyboard: "storyboard.json" } }, null, 2) + "\n");
  if (a.planOnly) { console.log(join(dir, "storyboard.json")); return 0; }
  const { out, manifest } = await renderMotion(dir);
  console.error(`motion: ${manifest.frames} frames ${manifest.width}x${manifest.height}@${manifest.fps} on ${manifest.workers} workers in ${manifest.render_s} s`);
  console.log(out);
  return 0;
}

/** True when a take dir is a motion take (rerendered by renderMotion, not the recording renderer). */
export function isMotionTake(dir: string): boolean {
  try { return !!(JSON.parse(readFileSync(join(dir, "take.json"), "utf8")) as { motion?: unknown }).motion; } catch { return false; }
}
