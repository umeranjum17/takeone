// `takeone motion` argument parsing and the local planner: a complete storyboard from flags alone.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { renderMotion } from "./motion.ts";
import { validateStateNames } from "./ingest.ts";
import { installShell } from "./shell.ts";
import { minSceneDuration, validateStoryboard } from "./storyboard.ts";
import type { Device, PatternName, Region, Scene } from "./types.ts";

export const MOTION_USAGE = `takeone motion <image.png|page.html|https://url>... [--out DIR] [--pattern hero-reveal,zoom-tour,end-card,kinetic-type,before-after]
  [--theme midnight|paper|aurora|mono|neon|brutalist|sand|terminal|editorial]
  [--title TEXT] [--subtitle TEXT] [--line TEXT]... [--cta TEXT] [--url TEXT] [--logo WORD] [--device browser|phone|laptop|none]
  [--region x,y,w,h[:label][@SCREEN]]... [--state NAME='click #id; type #id "text"; drag #a #b; wait 300']...
  [--workers N] [--blur 0|1] [--storyboard file.json] [--plan-only]
takeone motion install-shell     download the pinned chrome-headless-shell (sha256 checked)

  motion writes a take-shaped directory (take.json, sources/, storyboard.json, out/<id>.mp4, render.json);
  takeone render <dir> rerenders it. With no --pattern it plans hero-reveal, zoom-tour and end-card; from three
  screens up it plans a launch film instead: kinetic title, every screen followed by a close-up of each --region on
  it, each --line as a type beat between screens, a before/after of the first and last screen (zoomed to the last
  screen's last region) and the end card, alternating light and dark.`;

interface MotionArgs {
  inputs: string[]; out?: string; patterns?: PatternName[]; theme?: string; title?: string;
  subtitle?: string; lines: string[]; cta?: string; url?: string; logo?: string; device?: Device; regions: string[]; states: [string, string][];
  workers?: number; blur?: number; storyboard?: string; planOnly: boolean;
}

export function parseMotionArgs(argv: string[]): MotionArgs {
  const a: MotionArgs = { inputs: [], lines: [], regions: [], states: [], planOnly: false };
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
    else if (s === "--line") a.lines.push(v);
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

/** "x,y,w,h[:label][@SCREEN]" -> Region. */
export function parseRegion(spec: string, index: number, screen: string): Region {
  const m = /^(-?[\d.]+),(-?[\d.]+),([\d.]+),([\d.]+)(?::([^@]*))?(?:@([A-Za-z0-9_-]+))?$/.exec(spec);
  if (!m) throw new Error(`--region expects x,y,w,h[:label][@SCREEN], got ${spec}`);
  return { id: `r${index + 1}`, rect: [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])], screen: m[6] ?? screen,
    ...(m[5] ? { label: m[5] } : {}), from: "user" };
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

/** The local planner: pattern defaults, regions in the order given, copy from flags. */
export function planStoryboard(a: MotionArgs, id: string): unknown {
  validateStateNames(a.states.map(([name]) => name));
  const first = a.inputs[0]!;
  const kind = /^https?:\/\//.test(first) ? "url" : /\.html?$/i.test(first) ? "html" : "image";
  if (kind !== "image" && a.inputs.length > 1) throw new Error("html and url sources take one input; use --state for more screens");
  const screens = kind === "image" ? a.inputs.map((_, i) => `S${i + 1}`) : a.states.length ? a.states.map(([n]) => n) : ["S1"];
  const regions = a.regions.map((r, i) => parseRegion(r, i, screens[0]!));
  const launch = !a.patterns && screens.length >= 3;
  for (const r of regions) if (!screens.includes(r.screen)) throw new Error(`--region ${r.id}: unknown screen ${r.screen}; choose ${screens.join(", ")}`);
  if (a.lines.length && !launch && !a.patterns?.includes("kinetic-type")) throw new Error("--line needs three or more screens or --pattern kinetic-type");
  const crops: Record<string, { screen: string; rect: Region["rect"] }> = {};
  const crop = (screen: string, r: Region, id = `${screen}-${r.id}`) => { crops[id] = { screen, rect: r.rect }; return id; };
  const changed = launch ? regions.filter(r => r.screen === screens.at(-1)).at(-1) : undefined;
  const patterns = a.patterns ?? (["hero-reveal", "zoom-tour", "end-card"] as PatternName[]);
  const title = a.title ?? "See it in motion.";
  const fit = (s: Scene, min: number): Scene => ({ ...s, d: Math.max(min, minSceneDuration(s)) });
  const beat = (line: string): Scene => fit({ pattern: "kinetic-type", d: 0, title: line }, 2.2);
  const plan = (p: PatternName): Scene[] => {
    if (p === "hero-reveal") return [{ pattern: p, d: 5, screen: regions[0]?.screen ?? screens[0]!, title, ...(a.subtitle ? { subtitle: a.subtitle } : {}),
      ...(regions[0] ? { focus: regions[0].id } : {}), device: a.device ?? "browser" }];
    if (p === "zoom-tour") {
      const owners = regions.length ? [...new Set(regions.map(r => r.screen))] : [screens.at(-1)!];
      return owners.map(screen => {
        const stops = regions.filter(r => r.screen === screen).map(r => ({ region: r.id, ...(r.label ? { caption: r.label } : {}) }));
        return { pattern: p, d: 3 + 3.5 * Math.max(1, stops.length), screen, stops, device: a.device ?? "browser" };
      });
    }
    if (p === "end-card") return [{ pattern: p, d: 3.5, screen: screens.at(-1)!, cta: a.cta ?? "Try it today", ...(a.url ? { url: a.url } : {}),
      logo: a.logo ?? "TakeOne" }];
    if (p === "kinetic-type") return [fit({ pattern: p, d: 0, title, ...(a.subtitle ? { subtitle: a.subtitle } : {}) }, 2.4), ...a.lines.map(beat)];
    if (p !== "before-after") throw new Error(`--pattern ${p} needs a storyboard (core patterns: hero-reveal, zoom-tour, end-card, kinetic-type, before-after)`);
    if (screens.length < 2) throw new Error("--pattern before-after needs two screens");
    return [fit(changed ? { pattern: p, d: 0, before: crop(screens[0]!, changed, `${screens[0]}-${changed.id}-before`), screen: crop(screens.at(-1)!, changed), device: "none" }
      : { pattern: p, d: 0, before: screens[0]!, screen: screens.at(-1)!, device: a.device ?? "browser" }, 4.2)];
  };
  const scenes: Scene[] = !launch ? patterns.flatMap(plan) : [
    ...plan("kinetic-type").slice(0, 1),
    ...screens.flatMap((screen, i) => [...(i && a.lines[i - 1] ? [beat(a.lines[i - 1]!)] : []),
      fit({ pattern: "hero-reveal", d: 0, screen, device: a.device ?? "browser" }, 2.4),
      ...regions.filter(r => r.screen === screen).map(r => fit({ pattern: "hero-reveal", d: 0, screen: crop(screen, r), device: "none" }, 1.6))]),
    ...plan("before-after"),
    ...a.lines.slice(screens.length - 1).map(beat),
    ...plan("end-card"),
  ].map((s, i) => (i % 2 ? { ...s, invert: true } : s));
  const source = kind === "image" ? { kind, files: a.inputs.map((f) => resolve(f)) }
    : kind === "html" ? { kind, file: resolve(first), viewport: [2560, 1440], states: Object.fromEntries(a.states.map(([n, ops]) => [n, splitStateOps(ops)])) }
    : { kind, url: first, viewport: [1440, 900], dsf: 2, states: Object.fromEntries(a.states.map(([n, ops]) => [n, splitStateOps(ops)])) };
  return {
    version: 1, id,
    output: { ...(a.workers !== undefined ? { workers: a.workers } : {}), ...(a.blur !== undefined ? { motion_blur: a.blur } : {}) },
    theme: { name: a.theme ?? "midnight", overrides: {} },
    source, ...(Object.keys(crops).length ? { crops } : {}), screens: Object.create(null), regions, layout: { kind: "single" }, scenes,
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
