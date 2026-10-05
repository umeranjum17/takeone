// storyboard.json v1 validation at the trust boundary. Errors name the offending field (JSON path).
import { bentoViewport } from "./geometry.ts";
import { motionTokens } from "./theme.ts";
import { allTimelines, layoutDuration, validateLayout } from "./layout.ts";
import { parseStateOp, validateStateNames } from "./ingest.ts";
import { beatTime, lintFonts } from "./lint.ts";
import { PATTERNS, type Scene, type Storyboard } from "./types.ts";

export class StoryboardError extends Error {
  path: string;
  constructor(path: string, message: string) { super(`${path}: ${message}`); this.path = path; }
}

export const MAX_DURATION_S = 120;
const DEVICES = ["browser", "phone", "laptop", "none"];
const PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"];
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, path: string, lo: number, hi: number): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new StoryboardError(path, `expected a number in [${lo}, ${hi}]`);
  return v;
};
const str = (v: unknown, path: string, max = 200): string => {
  if (typeof v !== "string" || v.length > max || /[\x00-\x1f\x7f]/.test(v)) throw new StoryboardError(path, `expected text of at most ${max} characters with no control characters`);
  return v;
};

/** Reading-time floor: 0.3 s per word plus 0.8 s. */
export function readingFloor(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words ? 0.3 * words + 0.8 : 0;
}

/** Scene reading copy; the glyph gate also checks emitted literals in their actual font roles. */
export function sceneTexts(s: Scene): string[] {
  if (s.pattern === "hero-reveal" || s.pattern === "kinetic-type") return [s.title, s.subtitle].filter((t): t is string => !!t);
  if (s.pattern === "end-card") return [s.logo, s.cta, s.url].filter((t): t is string => !!t);
  if (s.pattern === "fragment") {
    if (s.kind === "counter") return ["60"];
    if (s.kind === "browser-chrome") return ["Design preview"];
    if (s.kind === "phone-chrome") return ["9:41"];
    const defaults: Record<string, string> = { button: "Create task", input: s.state === "empty" ? "Task title" : "Draft launch announcement", chip: "High priority", toast: "Task created" };
    if (s.kind === "feed-row") return ["Umer", s.text ?? "moved Draft launch announcement", "Just now"];
    return [s.kind === "input" && s.state === "empty" ? "Task title" : s.text ?? defaults[s.kind ?? ""] ?? ""].filter(Boolean);
  }
  return (s.stops ?? []).map(x => x.caption ?? "").filter(Boolean);
}

function sceneRevealDuration(s: Scene): number {
  let reveal = 0;
  if (s.pattern === "hero-reveal" || s.pattern === "kinetic-type") {
    const words = (s.title ?? "").trim().split(/\s+/).filter(Boolean).length;
    reveal = Math.max(words ? .4 + .06 * (words - 1) : 0, s.subtitle ? .6 : 0);
  } else if (s.pattern === "end-card") {
    const glyphs = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s.logo!)].filter(ch => ch.segment.trim()).length;
    reveal = Math.max(glyphs ? .55 + .035 * (glyphs - 1) : 0, s.cta ? .65 : 0, s.url ? .75 : 0);
  } else if (s.pattern === "fragment" && s.kind === "input" && s.state === "typing") {
    reveal = .055 * (s.text ?? "Draft launch announcement").length;
  }
  if (s.pattern === "fragment" && s.kind === "counter") reveal = 1.5;
  return reveal;
}

/** Every text a scene shows with the time its reveal ends: each needs its reading floor after that. */
function sceneHolds(s: Scene): { text: string; reveal: number }[] {
  const holds = s.pattern === "zoom-tour" ? [] : [{ text: sceneTexts(s).join(" "), reveal: sceneRevealDuration(s) }];
  if (s.pattern === "hero-reveal" || s.pattern === "zoom-tour") {
    const device = s.device ?? "browser";
    const text = device === "browser" ? "Design preview" : device === "phone" ? "9:41" : "";
    holds.push({ text, reveal: s.pattern === "zoom-tour" ? 0 : .6 });
  }
  return holds;
}

/** Shortest whole-frame duration that clears every reveal and reading hold of a scene played in full. */
export function minSceneDuration(s: Scene, fps = 60): number {
  return Math.ceil(Math.max(0, ...sceneHolds(s).map(x => x.reveal + readingFloor(x.text))) * fps + 1) / fps;
}

function validateVisibleScene(s: Scene, start: number, duration: number, fps: number, path: string): void {
  const end = start + Math.round(duration * fps) / fps;
  if (s.pattern === "zoom-tour") {
    if (s.at! < start - 1e-9 || s.at! + s.d > end + 1e-9) throw new StoryboardError(path, "visible window truncates camera moves and reading holds");
  }
  const holds = sceneHolds(s);
  const lastFrame = Math.min(Math.round(duration * fps) - 1, Math.ceil((s.at! + s.d - start) * fps - 1e-9) - 1);
  for (const { text, reveal } of holds) {
    const reading = readingFloor(text);
    if (!reading) continue;
    const readableAt = Math.max(start, s.at! + reveal);
    const firstFrame = Math.ceil((readableAt - start) * fps - 1e-9);
    if (lastFrame / fps + 1e-9 < firstFrame / fps + reading) throw new StoryboardError(path, "visible window is under reveal and reading-time floor");
  }
}

function scene(raw: unknown, path: string): Scene {
  if (!isObj(raw)) throw new StoryboardError(path, "expected an object");
  const pattern = raw["pattern"];
  if (!PATTERNS.includes(pattern as never)) throw new StoryboardError(`${path}.pattern`, `unknown pattern ${String(pattern)}; choose ${PATTERNS.join(", ")}`);
  const s: Scene = { ...(raw as unknown as Scene) };
  s.d = num(raw["d"], `${path}.d`, 0.25, MAX_DURATION_S);
  if (raw["at"] !== undefined) s.at = num(raw["at"], `${path}.at`, 0, MAX_DURATION_S);
  for (const k of ["title", "subtitle", "cta", "url", "logo", "text", "kind", "state"] as const) if (raw[k] !== undefined) s[k] = str(raw[k], `${path}.${k}`, k === "text" ? 400 : 120);
  if (raw["invert"] !== undefined && typeof raw["invert"] !== "boolean") throw new StoryboardError(`${path}.invert`, "expected true or false");
  if (s.pattern === "end-card") s.logo ??= "TakeOne";
  for (const k of ["screen", "focus"] as const) if (raw[k] !== undefined && !ID.test(String(raw[k]))) throw new StoryboardError(`${path}.${k}`, "expected an id");
  if (raw["device"] !== undefined && !DEVICES.includes(String(raw["device"]))) throw new StoryboardError(`${path}.device`, `choose ${DEVICES.join(", ")}`);
  if (raw["push"] !== undefined) s.push = num(raw["push"], `${path}.push`, 0, 0.1);
  if (s.pattern === "fragment") {
    const kinds = ["button", "input", "chip", "toast", "feed-row", "counter", "line-chart", "bar-chart", "spinner", "browser-chrome", "phone-chrome"];
    if (!s.kind || !kinds.includes(s.kind)) throw new StoryboardError(`${path}.kind`, `choose ${kinds.join(", ")}`);
    if (s.kind === "button" && s.state && !["idle", "hover", "pressed"].includes(s.state)) throw new StoryboardError(`${path}.state`, "choose idle, hover, pressed");
    if (s.kind === "input" && s.state && !["empty", "typing", "filled"].includes(s.state)) throw new StoryboardError(`${path}.state`, "choose empty, typing, filled");

  }
  if (raw["stops"] !== undefined) {
    if (!Array.isArray(raw["stops"]) || raw["stops"].length > 8) throw new StoryboardError(`${path}.stops`, "expected up to 8 stops");
    s.stops = raw["stops"].map((x, j) => {
      if (!isObj(x) || !ID.test(String(x["region"]))) throw new StoryboardError(`${path}.stops[${j}].region`, "expected a region id");
      return { region: String(x["region"]), ...(x["caption"] === undefined ? {} : { caption: str(x["caption"], `${path}.stops[${j}].caption`, 60) }),
        ...(x["hold"] === undefined ? {} : { hold: num(x["hold"], `${path}.stops[${j}].hold`, 0.6, 10) }) };
    });
  }
  return s;
}

/** Parse, default and check a storyboard. Throws StoryboardError naming the field. */
export function validateStoryboard(raw: unknown): Storyboard {
  if (!isObj(raw)) throw new StoryboardError("$", "expected an object");
  if (raw["version"] !== 1) throw new StoryboardError("version", "expected 1");
  const id = raw["id"] ?? "motion";
  if (typeof id !== "string" || !ID.test(id)) throw new StoryboardError("id", "expected [A-Za-z0-9_-]{1,64}");
  const o = isObj(raw["output"]) ? raw["output"] : {};
  if (o["aspect"] !== undefined || o["quality"] !== undefined) throw new StoryboardError("output", "aspect and quality options are not supported");
  if (o["fps"] !== undefined && o["fps"] !== 60) throw new StoryboardError("output.fps", "expected 60");
  const out_w = o["out_w"] === undefined ? 1920 : num(o["out_w"], "output.out_w", 16, 7680);
  const out_h = o["out_h"] === undefined ? 1080 : num(o["out_h"], "output.out_h", 16, 4320);
  if (out_w % 2 || out_h % 2 || !Number.isInteger(out_w) || !Number.isInteger(out_h)) throw new StoryboardError("output", "out_w and out_h must be even integers");
  const fps = 60;
  const workers = o["workers"] === undefined ? 8 : num(o["workers"], "output.workers", 1, 64);
  if (!Number.isInteger(workers)) throw new StoryboardError("output.workers", "expected an integer");
  const preset = o["preset"] ?? "medium";
  if (!PRESETS.includes(String(preset))) throw new StoryboardError("output.preset", `choose ${PRESETS.join(", ")}`);
  const motion_blur = o["motion_blur"] === undefined ? 1 : num(o["motion_blur"], "output.motion_blur", 0, 1);

  const theme = isObj(raw["theme"]) ? raw["theme"] : {};
  const themeName = theme["name"] ?? "midnight";
  if (typeof themeName !== "string") throw new StoryboardError("theme.name", "expected a theme name");
  const overrides = theme["overrides"] ?? {};
  if (!isObj(overrides)) throw new StoryboardError("theme.overrides", "expected an object");

  const source = raw["source"];
  if (!isObj(source) || !["image", "html", "url"].includes(String(source["kind"]))) throw new StoryboardError("source.kind", "choose image, html, url");

  if (source["kind"] === "html" && (typeof source["file"] !== "string" || !source["file"])) throw new StoryboardError("source.file", "expected HTML file path");
  if (source["kind"] === "url" && (typeof source["url"] !== "string" || !/^https?:\/\//.test(source["url"]))) throw new StoryboardError("source.url", "expected http(s) URL");
  if (source["files"] !== undefined && (!Array.isArray(source["files"]) || source["files"].some(f => typeof f !== "string" || !f))) throw new StoryboardError("source.files", "expected image paths");
  if (source["viewport"] !== undefined) {
    const viewport = source["viewport"];
    if (!Array.isArray(viewport) || viewport.length !== 2 || viewport.some(v => typeof v !== "number" || !Number.isInteger(v) || v < 16 || v > 16384)) throw new StoryboardError("source.viewport", "expected [width, height] integers in 16..16384");
  }
  if (source["dsf"] !== undefined) num(source["dsf"], "source.dsf", 1, 4);
  if (source["states"] !== undefined) {
    if (!isObj(source["states"])) throw new StoryboardError("source.states", "expected state operations object");
    try { validateStateNames(Object.keys(source["states"])); } catch (e) { throw new StoryboardError("source.states", (e as Error).message); }
    for (const [id, ops] of Object.entries(source["states"])) {
      if (!Array.isArray(ops)) throw new StoryboardError(`source.states.${id}`, "expected named operations array");
      for (const op of ops) { try { parseStateOp(op); } catch (e) { throw new StoryboardError(`source.states.${id}`, String(e)); } }
    }
  }

  const rawScreens = raw["screens"] ?? {};
  if (!isObj(rawScreens)) throw new StoryboardError("screens", "expected an object");
  const screens = Object.assign(Object.create(null), rawScreens);
  for (const [k, v] of Object.entries(screens)) {
    if (!ID.test(k) || !isObj(v) || typeof v["file"] !== "string") throw new StoryboardError(`screens.${k}`, "expected {file, width, height}");
    num(v["width"], `screens.${k}.width`, 1, 16384); num(v["height"], `screens.${k}.height`, 1, 16384);
  }

  const regions = raw["regions"] ?? [];
  if (!Array.isArray(regions)) throw new StoryboardError("regions", "expected an array");
  const regionIds = new Set<string>();
  regions.forEach((r, i) => {
    const p = `regions[${i}]`;
    if (!isObj(r) || !ID.test(String(r["id"]))) throw new StoryboardError(`${p}.id`, "expected an id");
    if (regionIds.has(String(r["id"]))) throw new StoryboardError(`${p}.id`, `duplicate region ${r["id"]}`);
    regionIds.add(String(r["id"]));
    if (r["label"] !== undefined) str(r["label"], `${p}.label`, 60);
    const scr = String(r["screen"] ?? Object.keys(screens)[0] ?? Object.keys((source["states"] ?? {}) as object)[0] ?? "S1");
    r["screen"] = scr;
    const rect = r["rect"];
    const sc = (screens as Record<string, { width: number; height: number }>)[scr];
    if (Array.isArray(rect)) {
      if (rect.length !== 4 || rect.some((v) => typeof v !== "number" || !Number.isFinite(v))) throw new StoryboardError(`${p}.rect`, "expected [x, y, w, h]");
      const [x, y, rw, rh] = rect as number[];
      if (rw! <= 0 || rh! <= 0) throw new StoryboardError(`${p}.rect`, "width and height must be positive");
      if (sc && (x! < 0 || y! < 0 || x! + rw! > sc.width || y! + rh! > sc.height)) throw new StoryboardError(`${p}.rect`, `lies outside screen ${scr} (${sc.width}x${sc.height})`);
    } else if (typeof r["selector"] !== "string") throw new StoryboardError(`${p}.rect`, "expected [x, y, w, h] or a selector (html/url sources)");
    if (Object.keys(screens).length && !sc) throw new StoryboardError(`${p}.screen`, `unknown screen ${scr}`);
  });

  if (!Array.isArray(raw["scenes"]) || !raw["scenes"].length) throw new StoryboardError("scenes", "expected at least one scene");
  let t = 0;
  const scenes = raw["scenes"].map((x, i) => {
    const s = scene(x, `scenes[${i}]`);
    s.at ??= t;
    if (s.at < t) throw new StoryboardError(`scenes[${i}].at`, "overlapping scenes");
    t = Math.max(t, s.at + s.d);
    return s;
  });
  if (t > MAX_DURATION_S) throw new StoryboardError("scenes", `total duration ${t.toFixed(2)} s exceeds ${MAX_DURATION_S} s`);
  let layout: Storyboard["layout"];
  try { layout = validateLayout(raw["layout"] ?? { kind: "single" }, scene); } catch (e) {
    if (e instanceof StoryboardError) throw e;
    const m = /^([^:]+): (.*)$/s.exec((e as Error).message);
    throw new StoryboardError(m?.[1] ?? "layout", m?.[2] ?? (e as Error).message);
  }

  const result: Storyboard = {
    version: 1, id,
    output: { out_w, out_h, fps, workers, motion_blur, preset: String(preset) },
    theme: { name: themeName, overrides: overrides as Storyboard["theme"]["overrides"] },
    ...(raw["tempo"] === undefined ? {} : { tempo: raw["tempo"] as Storyboard["tempo"] }),
    source: source as Storyboard["source"],
    screens: screens as unknown as Storyboard["screens"],
    regions: regions as Storyboard["regions"],
    layout,
    scenes,
    planner: (isObj(raw["planner"]) ? raw["planner"] : { by: "user", abstained: [] }) as Storyboard["planner"],
  };
  if (layout.kind === "bento") {
    const tokens = motionTokens(themeName, result.theme.overrides);
    for (let list = 0; list < 4; list++) bentoViewport(out_w, out_h, tokens, layout.grid, list);
  }
  if (result.tempo) {
    const tempo = result.tempo;
    num(tempo.bpm, "tempo.bpm", 20, 300);
    num(tempo.phase_s, "tempo.phase_s", -120, 120);
    if (!["beat", "half"].includes(tempo.snap)) throw new StoryboardError("tempo.snap", "choose beat or half");
    if (layout.kind === "bento" && layout.grid === "2x2") for (const tile of layout.tiles) tile.offset_s = beatTime(tile.offset_s, { ...tempo, phase_s: 0 }, fps, `layout.tiles.${tile.id}.offset_s`);
    for (const list of allTimelines(layout, scenes)) for (const [i, s] of list.entries()) {
      const end = beatTime(s.at! + s.d, tempo, fps, `scenes[${i}].end`);
      s.at = beatTime(s.at!, tempo, fps, `scenes[${i}].at`);
      s.d = end - s.at;
    }
  }
  for (const list of allTimelines(layout, scenes)) for (const [i, s] of list.entries()) {
    if (s.focus && !regionIds.has(s.focus)) throw new StoryboardError(`scenes[${i}].focus`, "unknown region");
    if (s.screen && Object.keys(screens).length && !Object.hasOwn(screens, s.screen)) throw new StoryboardError(`scenes[${i}].screen`, "unknown screen");
    if (s.at! < 0) throw new StoryboardError(`scenes[${i}].at`, "negative scene starts are not supported");
    for (const stop of s.stops ?? []) if (!regionIds.has(stop.region)) throw new StoryboardError(`scenes[${i}].stops`, "unknown region");
    const owner = s.screen ?? Object.keys(screens)[0] ?? Object.keys((source["states"] ?? {}) as object)[0] ?? "S1";
    for (const id of [s.focus, ...(s.stops ?? []).map(stop => stop.region)].filter(Boolean)) {
      const region = (regions as Storyboard["regions"]).find(r => r.id === id)!;
      if (region.screen !== owner) throw new StoryboardError(`scenes[${i}]`, "regions must belong to the scene screen");
    }
  }
  if (layout.kind === "bento" && layout.grid === "2x2") {
    for (const tile of layout.tiles) for (const [i, s] of layout.master.scenes.entries()) {
      const end = tile.offset_s + Math.round(layout.master.d * fps) / fps;
      if (s.at! + s.d <= tile.offset_s || s.at! >= end) continue;
      validateVisibleScene(s, tile.offset_s, layout.master.d, fps, `layout.tiles.${tile.id}.scenes[${i}]`);
    }
  } else {
    const duration = layoutDuration(layout, scenes);
    for (const list of allTimelines(layout, scenes)) for (const [i, s] of list.entries()) validateVisibleScene(s, 0, duration, fps, `scenes[${i}].d`);
  }
  lintFonts(result);
  return result;
}

/** Film length in seconds. */
export function filmDuration(sb: Storyboard): number {
  return layoutDuration(sb.layout, sb.scenes);
}
