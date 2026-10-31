// storyboard.json v1 validation at the trust boundary. Errors name the offending field (JSON path).
import { bentoViewport, stopTimes } from "./geometry.ts";
import { motionTokens } from "./theme.ts";
import { allTimelines, layoutDuration, validateLayout } from "./layout.ts";
import { parseStateOp, validateStateNames } from "./ingest.ts";
import { beatTime, lintFonts } from "./lint.ts";
import { PATTERNS, type Rect, type Scene, type Storyboard } from "./types.ts";

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
  if (s.pattern === "hero-reveal" || s.pattern === "kinetic-type" || s.pattern === "statement" || s.pattern === "glow-hero" || s.pattern === "story") return [s.title, s.subtitle].filter((t): t is string => !!t);
  if (s.pattern === "word-swap") return [s.title ?? "", ...(s.swaps ?? [])].filter(Boolean);
  if (s.pattern === "phone-story" || s.pattern === "chip-stack") return [s.title, s.text].filter((t): t is string => !!t);
  if (s.pattern === "bento-reel") return [s.title, s.subtitle, s.label, `$${s.reel!.value.toLocaleString("en-US")}`, "LIVE", ...s.reel!.feed].filter((t): t is string => !!t);
  if (s.pattern === "clip") return clipLabels(s).slice(-1).map(l => l.label);
  if (s.pattern === "bento") return (s.tiles ?? []).map(t => t.title);
  if (s.pattern === "halo-open") return s.title ? [s.title] : [];
  if (s.pattern === "halo-float") return s.title ? [s.title] : [];
  if (s.pattern === "halo-lines") return s.lines ?? [];
  if (s.pattern === "halo-end") return [s.logo, s.credit].filter((t): t is string => !!t);
  if (s.pattern === "logo-sting") return [s.logo].filter((t): t is string => !!t);
  if (s.pattern === "welcome") return [s.label, s.title, s.subtitle, s.cta, ...(s.tree ?? []), s.logo].filter((t): t is string => !!t);
  if (s.pattern === "before-after" || s.pattern === "scroll-through") return [s.title].filter((t): t is string => !!t);
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

/** clip labels in play order: the scene label, then each cut's; each types on at 30 ms a character from its cut. */
function clipLabels(s: Scene): { at: number; label: string; reveal: number }[] {
  return [{ at: 0, label: s.label }, ...(s.cuts ?? []).map(c => ({ at: c.at, label: c.label }))]
    .filter((l): l is { at: number; label: string } => !!l.label).map(l => ({ ...l, reveal: l.at + .03 * l.label.length }));
}

function sceneRevealDuration(s: Scene): number {
  let reveal = 0;
  if (s.pattern === "clip") reveal = clipLabels(s).at(-1)?.reveal ?? 0;
  if (s.pattern === "hero-reveal" || s.pattern === "kinetic-type" || s.pattern === "statement" || s.pattern === "glow-hero") {
    const words = (s.title ?? "").trim().split(/\s+/).filter(Boolean).length;
    reveal = Math.max(words ? .4 + .06 * (words - 1) : 0, s.subtitle ? .6 : 0);
  } else if (s.pattern === "story") { // the headline rises a word every 70 ms; the surface settles beside it (storySettle)
    reveal = .4 + .06 * (sceneTexts(s).join(" ").split(/\s+/).filter(Boolean).length - 1);
  } else if (s.pattern === "word-swap") { // swaps land every 0.9 s from 0.6 s; the last settles in 0.38 s
    reveal = .98 + .9 * Math.max(0, (s.swaps ?? []).length - 1);
  } else if (s.pattern === "phone-story") { // the toast springs in at 2.9 s
    reveal = s.text ? 3.32 : .4;
  } else if (s.pattern === "chip-stack") { // one chip per beat from 0.25 s
    reveal = .67 + .5 * Math.max(0, (s.chips ?? []).length - 1);
  } else if (s.pattern === "bento") {
    reveal = .5 + .3 * Math.max(0, (s.tiles ?? []).length - 1);
  } else if (s.pattern === "halo-open") { // the tagline types in once the pill has grown, done by 1.3 s
    reveal = 1.2;
  } else if (s.pattern === "halo-float") { // the title rises a word every 70 ms, read like any headline; the pieces' landing is the beat's own floor (halo.ts)
    const words = (s.title ?? "").trim().split(/\s+/).filter(Boolean).length;
    reveal = words ? .4 + .06 * (words - 1) : 0;
  } else if (s.pattern === "halo-end") { // the wordmark types on from .4 s
    const glyphs = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s.logo!)].length;
    reveal = .7 + .07 * (glyphs - 1);
  } else if (s.pattern === "logo-sting") { // letters settle by 0.9 s
    reveal = .9;
  } else if (s.pattern === "scroll-through") { // the title pill fades up over 0.6 s
    reveal = .6;
  } else if (s.pattern === "before-after") { // the delta line fades up once the wipe has settled
    reveal = 2.2;
  } else if (s.pattern === "end-card") {
    const glyphs = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s.logo!)].filter(ch => ch.segment.trim()).length;
    reveal = Math.max(glyphs ? .55 + .035 * (glyphs - 1) : 0, s.cta ? .65 : 0, s.url ? .75 : 0);
  } else if (s.pattern === "fragment" && s.kind === "input" && s.state === "typing") {
    reveal = .055 * (s.text ?? "Draft launch announcement").length;
  }
  if (s.pattern === "fragment" && s.kind === "counter") reveal = 1.5;
  return reveal;
}

/** story surface timing (story.js), in seconds from the cut: chips land one per 140 ms, the chat types 35 ms a character then answers a line per 450 ms, cards step 160 ms, stat counters run 1.3 s. */
export function storySettle(s: Scene): number {
  const n = s.tree?.length ?? 0;
  if (s.kind === "sheet") return 1.6 + .1 * n; // rows rise a step apart, then the first row is ringed
  if (s.kind === "fill") return 1 + .9 * (n - 1); // each row fills the card for 0.9 s
  if (s.kind === "grid") return 3.2; // the counter runs 2.6 s from 0.3 s
  return s.kind === "chips" ? 1.1 + .14 * (n - 1) : s.kind === "phone" ? 1.9 + .035 * (s.tree?.[0]?.length ?? 0) + .45 * (n - 2) : s.kind === "cards" ? 1 + .16 * (n - 1) : 1.7 + .22 * (n - 1);
}

/** halo-lines timing (halo.js): one lockup. The lead-in lines rise in a word at a time, one every .45 s; the last line types on
 * a grapheme every 50 ms from .45 s after the last lead-in starts. Every line stays up to the scene end, so the reads overlap. */
export const HALO_LEAD_STEP = .45, HALO_TYPE_LAG = .45, HALO_TYPE_STEP = .05;
export function haloLineHolds(s: Scene): { text: string; reveal: number }[] {
  const lines = s.lines ?? [], leads = lines.slice(0, -1), last = lines.at(-1);
  const typeAt = leads.length ? HALO_LEAD_STEP * (leads.length - 1) + HALO_TYPE_LAG : 0;
  const glyphs = (t: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(t)].length;
  return [...leads.map((text, k) => ({ text, reveal: HALO_LEAD_STEP * k + .4 + .06 * (text.split(/\s+/).length - 1) })),
    ...(last ? [{ text: last, reveal: typeAt + HALO_TYPE_STEP * glyphs(last) }] : [])];
}

/** Every text a scene shows with the time its reveal ends: each needs its reading floor after that. */
function sceneHolds(s: Scene): { text: string; reveal: number }[] {
  // A word-swap reads as its title and the word it settles on; the struck words are beats, not copy.
  if (s.pattern === "bento-reel") { // headline words by 1.2 s; the counter settles by 60% of the reel; the feed adds a row a second from 0.6 s
    return [{ text: `${s.title} ${s.subtitle}`, reveal: 1.2 }, { text: `${s.label} $${s.reel!.value}`, reveal: .6 * s.d }, { text: s.reel!.feed.at(-1)!, reveal: .6 + s.reel!.feed.length - 1 }];
  }
  if (s.pattern === "halo-end") return [{ text: s.logo!, reveal: sceneRevealDuration(s) }, ...(s.credit ? [{ text: s.credit, reveal: 1.5 }] : [])];
  if (s.pattern === "welcome") { // each part is read as it lands (welcome.js): the company by 0.55 s, eyebrow and name by 0.65 s, the line by 1 s, the pill by 1.25 s, a checklist row every 0.7 s from 1.3 s, ticked by 0.55 s after
    const words = (s.title ?? "").trim().split(/\s+/).filter(Boolean).length;
    return [{ text: [s.label, s.title].filter(Boolean).join(" "), reveal: .65 + .06 * Math.max(0, words - 1) }, { text: s.logo ?? "", reveal: .55 },
      { text: s.subtitle ?? "", reveal: 1 }, { text: s.cta ?? "", reveal: 1.25 }, ...(s.tree ?? []).map((t, j) => ({ text: t, reveal: 1.85 + .7 * j }))];
  }
  const text = s.pattern === "word-swap" ? [s.title, s.swaps?.at(-1)].join(" ") : sceneTexts(s).join(" ");
  let holds = s.pattern === "zoom-tour" ? [] : s.pattern === "halo-lines" ? haloLineHolds(s) : [{ text, reveal: sceneRevealDuration(s) }];
  if (s.pattern === "spotlight" || s.pattern === "feature-callouts") {
    // Each stop is read on its own window; the last one, then the numbered summary, are what the scene's end must clear.
    const caps = (s.stops ?? []).map(x => x.caption ?? ""), { starts, end } = stopTimes(caps);
    holds = [{ text: caps.at(-1) ?? "", reveal: starts.at(-1)! + .8 }];
    if (s.pattern === "feature-callouts") holds.push({ text: caps.join(" "), reveal: end + .5 });
  }
  if (s.pattern === "statement" && s.note) holds.push({ text: s.note, reveal: .8 }); // footnote fades up from 0.5 s
  const chromed = ["hero-reveal", "zoom-tour", "spotlight", "feature-callouts", "before-after", "device-orbit", "scroll-through"].includes(s.pattern) || (s.pattern === "kinetic-type" && !!s.device && s.device !== "none");
  if (chromed) {
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
  if (raw["logo_image"] !== undefined) {
    s.logo_image = str(raw["logo_image"], `${path}.logo_image`, 4096);
    if (s.pattern !== "end-card" || !/\.(png|jpe?g|webp|svg)$/i.test(s.logo_image)) throw new StoryboardError(`${path}.logo_image`, "only an end-card takes a logo_image, a png, jpg, webp or svg file");
  }
  for (const k of ["invert", "cut", "fill"] as const) if (raw[k] !== undefined && typeof raw[k] !== "boolean") throw new StoryboardError(`${path}.${k}`, "expected true or false");
  for (const k of ["label", "note"] as const) if (raw[k] !== undefined) s[k] = str(raw[k], `${path}.${k}`, k === "label" ? 60 : 120);
  for (const k of ["scale", "from"] as const) if (raw[k] !== undefined) s[k] = num(raw[k], `${path}.${k}`, 0.1, 1.5);
  if (s.pattern === "statement" && (typeof s.title !== "string" || !s.title.trim())) throw new StoryboardError(`${path}.title`, "statement needs a non-empty title");
  if (s.pattern === "segment" && !ID.test(String(raw["segment"]))) throw new StoryboardError(`${path}.segment`, "expected a segment id");
  if (s.pattern === "clip") {
    if (!ID.test(String(raw["clip"]))) throw new StoryboardError(`${path}.clip`, "expected a clip id");
    const cuts = raw["cuts"] ?? [];
    if (!Array.isArray(cuts) || cuts.length > 8) throw new StoryboardError(`${path}.cuts`, "expected up to 8 cuts");
    let prev = 0;
    s.cuts = cuts.map((c, j) => {
      const p = `${path}.cuts[${j}]`;
      if (!isObj(c)) throw new StoryboardError(p, "expected {at, clip?, label?, scale?}");
      const at = num(c["at"], `${p}.at`, prev + 0.25, s.d);
      prev = at;
      if (c["clip"] !== undefined && !ID.test(String(c["clip"]))) throw new StoryboardError(`${p}.clip`, "expected a clip id");
      return { at, ...(c["clip"] === undefined ? {} : { clip: String(c["clip"]) }), ...(c["label"] === undefined ? {} : { label: str(c["label"], `${p}.label`, 60) }),
        ...(c["scale"] === undefined ? {} : { scale: num(c["scale"], `${p}.scale`, 0.1, 1.5) }) };
    });
    // Every label but the last is replaced by the next: its own window must clear its reading floor.
    const labels = clipLabels(s);
    labels.slice(0, -1).forEach((l, j) => { if (labels[j + 1]!.at - l.reveal < readingFloor(l.label) - 1e-9) throw new StoryboardError(`${path}.cuts`, `label ${JSON.stringify(l.label)} is replaced before its reading-time floor`); });
  }
  if (raw["tiles"] !== undefined) {
    if (s.pattern !== "bento" || !Array.isArray(raw["tiles"]) || raw["tiles"].length !== 4) throw new StoryboardError(`${path}.tiles`, "bento needs exactly four {title} tiles");
    s.tiles = raw["tiles"].map((t, j) => {
      if (typeof t !== "object" || t === null || typeof t["title"] !== "string") throw new StoryboardError(`${path}.tiles[${j}]`, "expected {title}");
      if (t["screen"] !== undefined && !ID.test(String(t["screen"]))) throw new StoryboardError(`${path}.tiles[${j}].screen`, "expected an id");
      return { title: str(t["title"], `${path}.tiles[${j}].title`, 60), ...(t["screen"] === undefined ? {} : { screen: String(t["screen"]) }) };
    });
  } else if (s.pattern === "bento") throw new StoryboardError(`${path}.tiles`, "bento needs exactly four {title} tiles");
  if (s.pattern === "end-card" || s.pattern === "logo-sting") s.logo ??= "TakeOne";
  const stopCount = Array.isArray(raw["stops"]) ? raw["stops"].length : 0;
  if (s.pattern === "spotlight" && !stopCount) throw new StoryboardError(`${path}.stops`, "spotlight needs at least one stop");
  if (s.pattern === "feature-callouts" && (stopCount < 2 || stopCount > 5 || (raw["stops"] as unknown[]).some(x => !isObj(x) || typeof x["caption"] !== "string"))) throw new StoryboardError(`${path}.stops`, "feature-callouts needs 2 to 5 stops, each with a caption");
  if (s.pattern === "before-after" && (typeof s.screen !== "string" || typeof raw["after"] !== "string" || raw["after"] === s.screen)) throw new StoryboardError(`${path}.after`, "before-after needs two different screens: screen (before) and after");
  if (s.pattern === "word-swap") {
    const sw = raw["swaps"];
    if (!s.title?.trim() || !Array.isArray(sw) || sw.length < 1 || sw.length > 4) throw new StoryboardError(`${path}.swaps`, "word-swap needs a title and 1 to 4 swap words");
    s.swaps = sw.map((w, j) => str(w, `${path}.swaps[${j}]`, 24));
  }
  if (s.pattern === "phone-story") {
    const tap = raw["tap"];
    if (typeof s.screen !== "string" || !Array.isArray(tap) || tap.length !== 4 || tap.some(v => typeof v !== "number" || !Number.isFinite(v))) throw new StoryboardError(`${path}.tap`, "phone-story needs a crop screen and tap [x, y, w, h]");
    s.tap = tap as Rect;
    if (raw["lens"] !== undefined && !ID.test(String(raw["lens"]))) throw new StoryboardError(`${path}.lens`, "expected a crop id");
  }
  if (s.pattern === "welcome") {
    if (!s.title?.trim() || !s.logo?.trim()) throw new StoryboardError(path, "welcome needs a title (the name) and a logo (the company, whose initial sits on the accent panel)");
    const tree = raw["tree"] ?? [];
    if (!Array.isArray(tree) || tree.length > 4) throw new StoryboardError(`${path}.tree`, "welcome takes up to 4 checklist rows");
    s.tree = tree.map((t, j) => str(t, `${path}.tree[${j}]`, 40));
  }
  if (s.pattern === "glow-words" && !s.title?.trim()) throw new StoryboardError(`${path}.title`, "glow-words needs a title: its words cut in one at a time");
  if (s.pattern === "glow-tree") {
    const tree = raw["tree"];
    if (!Array.isArray(tree) || tree.length < 2 || tree.length > 8) throw new StoryboardError(`${path}.tree`, "glow-tree needs 2 to 8 rows");
    s.tree = tree.map((t, j) => str(t, `${path}.tree[${j}]`, 40));
  }
  if (s.pattern === "glow-deck") {
    const cards = raw["cards"];
    if (!Array.isArray(cards) || cards.length < 2 || cards.length > 5 || cards.some(c => !isObj(c) || !ID.test(String(c["screen"])) || typeof c["caption"] !== "string" || !c["caption"].trim())) throw new StoryboardError(`${path}.cards`, "glow-deck needs 2 to 5 cards, each {screen: a crop id, caption}");
    s.cards = cards.map((c, j) => ({ screen: String(c["screen"]), caption: str(c["caption"], `${path}.cards[${j}].caption`, 32) }));
  }
  if (s.pattern === "glow-screen") {
    const tap = raw["tap"];
    if (typeof s.screen !== "string" || !Array.isArray(tap) || tap.length !== 4 || tap.some(v => typeof v !== "number" || !Number.isFinite(v))) throw new StoryboardError(`${path}.tap`, "glow-screen needs a crop screen and tap [x, y, w, h]");
    s.tap = tap as Rect;
  }
  if (s.pattern === "chip-stack") {
    const chips = raw["chips"];
    if (!Array.isArray(chips) || chips.length < 1 || chips.length > 8 || chips.some(c => !ID.test(String(c)))) throw new StoryboardError(`${path}.chips`, "chip-stack needs 1 to 8 screen ids");
    s.chips = chips.map(String);
  }
  if (s.pattern === "bento-reel") {
    const r = raw["reel"], feed = isObj(r) ? r["feed"] : undefined, shots = isObj(r) ? r["shots"] : undefined;
    if (!isObj(r) || !Number.isInteger(r["value"]) || !Array.isArray(feed) || feed.length < 1 || feed.length > 6 || !Array.isArray(shots) || shots.length < 1 || shots.length > 3 || shots.some(c => !ID.test(String(c)))) {
      throw new StoryboardError(`${path}.reel`, "bento-reel needs {value, feed: 1 to 6 rows, shots: 1 to 3 screen ids}");
    }
    if (typeof s.title !== "string" || !s.title.trim() || !s.subtitle?.trim() || !s.label?.trim()) throw new StoryboardError(path, "bento-reel needs title, subtitle and label");
    s.reel = { value: Number(r["value"]), feed: feed.map((f, j) => str(f, `${path}.reel.feed[${j}]`, 32)), shots: shots.map(String) };
  }
  if (s.pattern === "halo-open" || s.pattern === "halo-end") {
    if (!ID.test(String(raw["mark"]))) throw new StoryboardError(`${path}.mark`, `${s.pattern} needs the logo crop id as mark`);
    s.mark = String(raw["mark"]);
    if (s.pattern === "halo-end") { s.logo ??= "TakeOne"; if (raw["credit"] !== undefined) s.credit = str(raw["credit"], `${path}.credit`, 80);
      const items = raw["items"];
      if (items !== undefined) {
        if (!Array.isArray(items) || items.length > 4 || items.some(c => !ID.test(String(c)))) throw new StoryboardError(`${path}.items`, "halo-end keeps up to 4 crop ids in view");
        s.items = items.map(String);
      }
    }
    else if (!s.title?.trim()) throw new StoryboardError(`${path}.title`, "halo-open needs a tagline as title");
  }
  if (s.pattern === "halo-float") {
    const items = raw["items"];
    if (!Array.isArray(items) || items.length < 1 || items.length > 6 || items.some(c => !ID.test(String(c)))) throw new StoryboardError(`${path}.items`, "halo-float needs 1 to 6 crop ids");
    s.items = items.map(String);
    if (!["row", "stack", "card", "chips"].includes(String(s.kind))) throw new StoryboardError(`${path}.kind`, "halo-float kind is row, stack, card or chips");
  }
  if (s.pattern === "halo-lines") {
    const lines = raw["lines"];
    if (!Array.isArray(lines) || lines.length < 1 || lines.length > 3) throw new StoryboardError(`${path}.lines`, "halo-lines needs 1 to 3 lines");
    s.lines = lines.map((l, j) => {
      const text = str(l, `${path}.lines[${j}]`, 60);
      if (!text.trim()) throw new StoryboardError(`${path}.lines[${j}]`, "expected non-empty text");
      return text;
    });
    const items = raw["items"];
    if (items !== undefined) {
      if (!Array.isArray(items) || items.length > 4 || items.some(c => !ID.test(String(c)))) throw new StoryboardError(`${path}.items`, "halo-lines keeps up to 4 crop ids in view");
      s.items = items.map(String);
    }
  }
  if (s.pattern === "story") {
    const [lo, hi] = ({ chips: [3, 8], phone: [2, 5], cards: [2, 5], stats: [2, 4], sheet: [3, 9], fill: [3, 5], grid: [3, 9] } as Record<string, number[]>)[String(s.kind)] ?? [];
    if (lo === undefined) throw new StoryboardError(`${path}.kind`, "story kind is chips, phone, cards, stats, sheet, fill or grid");
    const tree = raw["tree"];
    if (!s.title?.trim() || !Array.isArray(tree) || tree.length < lo! || tree.length > hi!) throw new StoryboardError(path, `story ${s.kind} needs a title and ${lo} to ${hi} tree rows`);
    s.tree = tree.map((t, j) => str(t, `${path}.tree[${j}]`, 80));
  }
  if (s.pattern === "canon") {
    const o = raw["offsets"];
    if (!Array.isArray(o) || o.length !== 4) throw new StoryboardError(`${path}.offsets`, "canon needs four tile offsets");
    s.offsets = o.map((v, j) => num(v, `${path}.offsets[${j}]`, 0, MAX_DURATION_S));
  }
  for (const k of ["screen", "focus", "after"] as const) if (raw[k] !== undefined && !ID.test(String(raw[k]))) throw new StoryboardError(`${path}.${k}`, "expected an id");
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
  if (!isObj(source) || !["image", "html", "url", "take"].includes(String(source["kind"]))) throw new StoryboardError("source.kind", "choose image, html, url, take");
  if (source["kind"] === "take" && (typeof source["dir"] !== "string" || !source["dir"])) throw new StoryboardError("source.dir", "expected the take directory path");

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

  const crops = raw["crops"] ?? {};
  if (!isObj(crops)) throw new StoryboardError("crops", "expected an object");
  for (const [k, c] of Object.entries(crops)) {
    if (!ID.test(k) || !isObj(c) || !ID.test(String(c["screen"])) || !Array.isArray(c["rect"]) || c["rect"].length !== 4 || c["rect"].some(v => typeof v !== "number" || !Number.isFinite(v))) throw new StoryboardError(`crops.${k}`, "expected {screen, rect: [x, y, w, h]}");
    const sc = (screens as Record<string, { width: number; height: number }>)[String(c["screen"])];
    if (Object.keys(screens).length && !sc) throw new StoryboardError(`crops.${k}.screen`, `unknown screen ${c["screen"]}`);
    const [x, y, w, h] = c["rect"] as number[];
    if (w! <= 0 || h! <= 0) throw new StoryboardError(`crops.${k}.rect`, "width and height must be positive");
    if (sc && (x! < 0 || y! < 0 || x! + w! > sc.width || y! + h! > sc.height)) throw new StoryboardError(`crops.${k}.rect`, `lies outside screen ${c["screen"]} (${sc.width}x${sc.height})`);
    if (c["exact"] !== undefined && typeof c["exact"] !== "boolean") throw new StoryboardError(`crops.${k}.exact`, "expected true or false");
  }

  const clips = raw["clips"] ?? {};
  if (!isObj(clips)) throw new StoryboardError("clips", "expected an object");
  for (const [k, c] of Object.entries(clips)) {
    if (!ID.test(k) || !isObj(c) || !Array.isArray(c["files"]) || !c["files"].length || c["files"].length > 8 || c["files"].some(f => typeof f !== "string" || !f)) throw new StoryboardError(`clips.${k}`, "expected {files: [video paths], start, d}");
    num(c["start"], `clips.${k}.start`, 0, 3600); num(c["d"], `clips.${k}.d`, 0.25, MAX_DURATION_S);
    if (c["crop"] !== undefined && (!Array.isArray(c["crop"]) || c["crop"].length !== c["files"].length || c["crop"].some(x => x !== null && !/^\d+:\d+:\d+:\d+$/.test(String(x))))) throw new StoryboardError(`clips.${k}.crop`, "expected one w:h:x:y crop (or null) per file");
    if (c["frames"] !== undefined && (!Array.isArray(c["frames"]) || c["frames"].length !== c["files"].length || c["frames"].some((f) => !isObj(f) || typeof f["dir"] !== "string" || !f["dir"] || !["count", "width", "height", "aspect"].every((k) => typeof f[k] === "number" && Number.isFinite(f[k]) && (f[k] as number) > 0)))) throw new StoryboardError(`clips.${k}.frames`, "expected one frame set per file; delete it to re-ingest");
  }

  const segments = raw["segments"] ?? {};
  if (!isObj(segments)) throw new StoryboardError("segments", "expected an object");
  for (const [k, v] of Object.entries(segments)) {
    if (!ID.test(k) || !isObj(v) || typeof v["file"] !== "string" || !v["file"]) throw new StoryboardError(`segments.${k}`, "expected {file: path of an html page, d: seconds}");
    num(v["d"], `segments.${k}.d`, 0.25, MAX_DURATION_S);
    const made = v["made"];
    if (v["video"] !== undefined && (typeof v["video"] !== "string" || !isObj(made) || typeof made["sha256"] !== "string")) throw new StoryboardError(`segments.${k}.video`, "expected a rendered video with its made {sha256, width, height}");
  }

  const rawAudio = raw["audio"];
  let audio: Storyboard["audio"];
  if (rawAudio !== undefined) {
    if (!isObj(rawAudio) || typeof rawAudio["file"] !== "string" || !rawAudio["file"]) throw new StoryboardError("audio", "expected {file, start?, volume?}");
    const start = rawAudio["start"] === undefined ? undefined : num(rawAudio["start"], "audio.start", 0, 3600);
    const volume = rawAudio["volume"] === undefined ? undefined : num(rawAudio["volume"], "audio.volume", 0, 1);
    audio = { file: rawAudio["file"], ...(start === undefined ? {} : { start }), ...(volume === undefined ? {} : { volume }) };
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
    ...(Object.keys(crops).length ? { crops: crops as Storyboard["crops"] } : {}),
    ...(Object.keys(clips).length ? { clips: clips as Storyboard["clips"] } : {}),
    ...(Object.keys(segments).length ? { segments: segments as Storyboard["segments"] } : {}),
    ...(audio ? { audio } : {}),
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
    for (const t of s.tiles ?? []) if (t.screen && Object.keys(screens).length && !Object.hasOwn(screens, t.screen)) throw new StoryboardError(`scenes[${i}].tiles`, "unknown screen");
    if (s.screen && Object.keys(screens).length && !Object.hasOwn(screens, s.screen)) throw new StoryboardError(`scenes[${i}].screen`, "unknown screen");
    if (s.after && Object.keys(screens).length && !Object.hasOwn(screens, s.after)) throw new StoryboardError(`scenes[${i}].after`, "unknown screen");
    for (const c of s.chips ?? []) if (Object.keys(screens).length && !Object.hasOwn(screens, c)) throw new StoryboardError(`scenes[${i}].chips`, `unknown screen ${c}`);
    for (const c of s.reel?.shots ?? []) if (Object.keys(screens).length && !Object.hasOwn(screens, c)) throw new StoryboardError(`scenes[${i}].reel`, `unknown screen ${c}`);
    if ((s.pattern === "phone-story" || s.pattern === "glow-screen") && !Object.hasOwn(crops, s.screen!)) throw new StoryboardError(`scenes[${i}].screen`, `${s.pattern} shows a crop: name one of crops`);
    for (const c of [...(s.items ?? []), ...(s.mark ? [s.mark] : [])]) if (!Object.hasOwn(crops, c)) throw new StoryboardError(`scenes[${i}]`, `halo scenes show crops: ${c} is not one of crops`);
    for (const c of s.cards ?? []) if (!Object.hasOwn(crops, c.screen)) throw new StoryboardError(`scenes[${i}].cards`, `glow-deck shows crops: ${c.screen} is not one of crops`);
    if (s.lens !== undefined && !Object.hasOwn(crops, s.lens)) throw new StoryboardError(`scenes[${i}].lens`, "the lens shows a crop: name one of crops");
    if (s.at! < 0) throw new StoryboardError(`scenes[${i}].at`, "negative scene starts are not supported");
    if (s.pattern === "clip") { // every footage segment must play to its end: a short clip would freeze
      const plays = [{ at: 0, clip: s.clip! }, ...(s.cuts ?? []).filter(c => c.clip).map(c => ({ at: c.at, clip: c.clip! }))]
        .map((x, j, all) => ({ clip: x.clip, d: (all[j + 1]?.at ?? s.d) - x.at }));
      for (const p of plays) {
        const c = (clips as Record<string, { d: number }>)[p.clip];
        if (!c) throw new StoryboardError(`scenes[${i}].clip`, `unknown clip ${p.clip}`);
        if (c.d + 1e-9 < p.d) throw new StoryboardError(`scenes[${i}].clip`, `clip ${p.clip} is ${c.d} s, shorter than the ${p.d.toFixed(2)} s it plays`);
      }
    }
    if (s.pattern === "segment") {
      const seg = (segments as Record<string, { d: number }>)[s.segment!];
      if (!seg) throw new StoryboardError(`scenes[${i}].segment`, `unknown segment ${s.segment}`);
      if (seg.d + 1e-9 < s.d) throw new StoryboardError(`scenes[${i}].segment`, `segment ${s.segment} is ${seg.d} s, shorter than the ${s.d.toFixed(2)} s it plays`);
    }
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
