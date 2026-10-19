// The film call: one planner call per take picks the theme, pace, opening,
// ending and camera style, plus the title and per-beat captions when the backend
// returns text. A take over one request's cap is planned in chunks: the first
// chunk picks the film-wide look, the last picks the ending, every chunk writes
// the captions of its own beats, and each chunk after the first is given a short
// summary of the chunk before it. These are the pure builders and the answer
// mapping; make.ts asks and applies. A field the planner abstains on keeps the
// base look (no override).

import type { Answer, Question } from "@byokit/decide";
import { type Overrides, type CameraDefaults } from "../camera/defaults.ts";
import { THEMES, type ThemeName } from "../themes.ts";
import type { Beat } from "../types.ts";
import { CHUNK_TOKEN_CAP, JEV_MODEL, estimateTokens, toWire, whatHappened } from "./request.ts";

/** Pace score levels, brisk to calm, and the pace multiplier each one sets. Pace
 * scales the hold before a move, so a higher value makes a calmer film. */
export const PACE_LEVELS = ["brisk", "quick", "steady", "calm"];
export const PACE_VALUES = [0.8, 1.0, 1.2, 1.4];
/** How long the whole stage is held before the first move (establish_s). */
const OPENINGS: Record<string, { label: string; establish_s: number }> = {
  establish: { label: "hold the whole stage for 1.6 seconds first", establish_s: 1.6 },
  short: { label: "hold the whole stage for 0.8 seconds first", establish_s: 0.8 },
  straight: { label: "go straight into the first action", establish_s: 0 },
};
const CAMERA_STYLES: Record<string, { label: string; camera_path: CameraDefaults["camera_path"] }> = {
  calm: { label: "hold each framing and move only between them", camera_path: "hold" },
  lively: { label: "the camera follows the action", camera_path: "solver" },
};
export const THEME_NOTES: Record<ThemeName, string> = {
  midnight: "dark navy stage, the default look",
  paper: "warm paper with serif type, for light app screens",
  aurora: "deep blue and violet gradient, bold and techy",
  mono: "black and white, flat, for code or terminal work",
  sand: "warm sand tones, soft and friendly, for light app screens",
  editorial: "cream and ink, type-led, for documents and text",
};
/** The film's ending can be any of the last few beats. */
const ENDING_CANDIDATES = 3;
/** AI title and caption text limits; longer text is dropped, not cut. The title
 * is drawn at 1.6x caption size with no shrink-to-fit: 61 px at caption_size 38,
 * where 28 of the widest glyphs ink 1236 px (W), 1174 px (ideographs) and
 * 1194 px (em dashes), inside the 1728 px the 1920x1080 stage band allows. */
// ponytail: the bound is calibrated to the default 1080p band; a smaller out_w or
// a larger caption_size can still overflow it and throw. Upgrade path: a title
// that shrinks to fit, in a separate slice.
const TITLE_MAX = 28;
const CAPTION_MAX = 80;
/** On-screen seconds per AI caption: the documented reading time. */
const CAPTION_SECONDS = 3;

export interface FilmDecision {
  /** Theme tokens, applied under --set; absent keeps the base look. */
  theme?: string;
  pace?: number;
  establish_s?: number;
  camera_path?: CameraDefaults["camera_path"];
  /** The beat the take ends on; the film keeps outro_s after it. */
  end_beat?: string;
  /** The film's title, drawn over the opening; absent when the planner gave none. */
  title?: string;
  /** Captions in video-relative seconds, one per beat the planner chose. */
  captions?: { t: number; d: number; text: string }[];
  /** Per field: the planner's own choice, or the rule (base look) when it abstained. */
  by: Record<string, "ai" | "rule">;
}

export interface FilmCtx {
  goal?: string;
  style?: string;
  seconds: number;
  source: string;
  device: string;
  brightness: "light" | "dark";
  beats: Beat[];
  /** Whether the planner can return text; only then is the title and caption question asked. */
  text: boolean;
}

/** One film call: a part of the take's beats with its questions and estimated
 * tokens. `endings` is the ending question's choices, in the part that holds the
 * take's last beats; it is empty for every other part. */
export interface FilmPart {
  state: Record<string, unknown>;
  questions: Record<string, Question>;
  tokens: number;
  endings: string[];
}

/** The film calls for one take, in order, and their total estimated tokens. A
 * chunk that asks nothing (a middle chunk for a planner that returns no text) is
 * not a call: the next chunk's summary covers its beats instead. */
export interface FilmPlan {
  calls: FilmPart[];
  tokens: number;
}

/** One beat on the timeline, in the words every film request uses. */
function timelineLine(b: Beat): string {
  return `${b.id}, ${((b.t1 - b.t0) / 1000).toFixed(1)} seconds: ${whatHappened(b)}`;
}

/** Characters of the previous chunk kept as the short summary the next chunk
 * reads (~170 estimated tokens), counted from its end: the beats just before are
 * what the next chunk continues from. */
// ponytail: a fixed tail budget, not a rolling summary of the whole film. Upgrade
// path: let each chunk write the summary of the next one, in a slice of its own.
const SUMMARY_CHARS = 600;

/** What the film already covered before a part, in a short summary: how many
 * beats came before, then the last of the previous chunk's beats, in the words
 * the timeline uses. */
function beforeChunk(ctx: FilmCtx, beats: Beat[]): string {
  const tail: string[] = [];
  let used = 0;
  for (let i = beats.length - 1; i >= 0; i--) {
    const line = timelineLine(beats[i]!);
    if (used + line.length > SUMMARY_CHARS) break;
    tail.unshift(line);
    used += line.length;
  }
  const from = beats[0]!.id;
  const to = beats.at(-1)!.id;
  const head = `The film planned beats ${from}-${to} of ${ctx.beats.length} before this part`;
  return `${head}. ${tail.length === beats.length ? "They showed, in order" : `The last ${tail.length} of them`}:\n${tail.join("\n")}`;
}

/** One film call over `beats`: the film-wide questions in the first part, the
 * ending in the last, and the title and captions of these beats in every part.
 * Null when this part is over one request's cap. */
function buildFilmPart(ctx: FilmCtx, beats: Beat[], before: string | undefined, first: boolean, last: boolean): FilmPart | null {
  const endings = last ? ctx.beats.slice(-ENDING_CANDIDATES) : [];
  const state = {
    ...(ctx.goal ? { goal: ctx.goal } : {}),
    ...(ctx.style ? { style: ctx.style } : {}),
    take: { length: `${ctx.seconds.toFixed(1)} seconds`, source: ctx.source, device: ctx.device, app_brightness: ctx.brightness },
    ...(before !== undefined ? { before_this_chunk: before } : {}),
    timeline: beats.map(timelineLine),
  };
  const filmWide: Record<string, Question> = {
    theme: {
      kind: "choice",
      options: Object.fromEntries(Object.entries(THEME_NOTES)),
      instructions: "Which theme fits this take? Match a light app to a light theme. Use style and goal when given.",
    },
    pace: {
      kind: "score",
      levels: PACE_LEVELS,
      instructions: "How calm should the film be? brisk: quick moves and short holds; calm: longer holds between moves. Use style when given.",
    },
    opening: {
      kind: "choice",
      options: Object.fromEntries(Object.entries(OPENINGS).map(([k, v]) => [k, v.label])),
      instructions: "How should the film open, before the first move?",
    },
    camera_style: {
      kind: "choice",
      options: Object.fromEntries(Object.entries(CAMERA_STYLES).map(([k, v]) => [k, v.label])),
      instructions: "Calm: hold each framing and move only between them. Lively: the camera follows the action.",
    },
  };
  const captions = `captions: a list of {beat, text} for the beats worth a line, each text in at most ${CAPTION_MAX} characters, ` +
    "plain words, with beat set to an id from the timeline.";
  const questions: Record<string, Question> = {
    ...(first ? filmWide : {}),
    ...(last ? { ending: {
      kind: "choice",
      options: Object.fromEntries(endings.map((b) => [b.id, whatHappened(b)])),
      instructions: "Which beat should the film end on? The film keeps a short outro after it.",
    } } : {}),
    // The title is the film's, so only the first part asks for it; the later
    // parts caption their own beats under the first part's title.
    ...(ctx.text ? { titled: first ? {
      kind: "yesno",
      question: "Does a viewer need a title and captions to follow this film? Answer yes when the subject or a step is not clear from the screen alone. " +
        `When yes, also give title: the film's subject in at most ${TITLE_MAX} characters; and ${captions}`,
      answerFields: ["title", "captions"],
    } as Question : {
      kind: "yesno",
      question: "Does a viewer need a caption on any of these beats? Answer yes when a step or its result is not clear from the screen alone. " +
        `The film's title and the earlier beats are already written. When yes, also give ${captions}`,
      answerFields: ["captions"],
    } as Question } : {}),
  };
  const tokens = estimateTokens(JSON.stringify({ model: JEV_MODEL, state, questions: toWire(questions) }));
  return tokens > CHUNK_TOKEN_CAP ? null : { state, questions, tokens, endings: endings.map((b) => b.id) };
}

/**
 * The film requests for a take: one call when the whole take fits under
 * CHUNK_TOKEN_CAP, else a chain of chunks. Each chunk takes as many beats as fit,
 * and the one after it is told what the beats before it planned, so a long take
 * is split rather than trimmed. Null only when a single beat is over the cap on
 * its own; the caller then keeps the base look.
 */
export function planFilm(ctx: FilmCtx): FilmPlan | null {
  if (ctx.beats.length === 0) return null;
  const calls: FilmPart[] = [];
  let before: string | undefined;
  for (let i = 0; i < ctx.beats.length;) {
    let part: FilmPart | null = null;
    let end = i + 1;
    // Grow the chunk one beat at a time until the next beat would break the cap.
    // ponytail: this re-measures the chunk for every extra beat; a take long
    // enough to notice wants a binary search instead.
    for (let j = i + 1; j <= ctx.beats.length; j++) {
      const next = buildFilmPart(ctx, ctx.beats.slice(i, j), before, i === 0, j === ctx.beats.length);
      if (!next) break;
      part = next;
      end = j;
    }
    if (!part) return null;
    if (Object.keys(part.questions).length > 0) calls.push(part);
    before = beforeChunk(ctx, ctx.beats.slice(i, end));
    i = end;
  }
  return { calls, tokens: calls.reduce((n, c) => n + c.tokens, 0) };
}

/** The film's text answers joined over the calls that asked for them: the first
 * title any call gave, and every call's captions in order. */
function joinText(answers: Answer[]): Answer | undefined {
  const given = answers.filter((a) => !a.abstained && a.answer === true);
  if (given.length === 0) return undefined;
  const fields = given.map((a) => a as unknown as Record<string, unknown>);
  const title = fields.find((f) => f.title !== undefined)?.title;
  const captions = fields.flatMap((f) => (Array.isArray(f.captions) ? f.captions : []));
  return {
    answer: true,
    confidence: Math.max(...given.map((a) => a.confidence)),
    abstained: false,
    by: given[0]!.by,
    ms: given.reduce((n, a) => n + a.ms, 0),
    ...(title !== undefined ? { title } : {}),
    captions,
  } as Answer;
}

/** One answer record from a take's film calls: a film-wide answer comes from the
 * call that asked it, and the title and captions of every call are joined. */
export function joinFilm(parts: (Record<string, Answer> | undefined)[]): Record<string, Answer> {
  const joined: Record<string, Answer> = {};
  const texts: Answer[] = [];
  for (const answers of parts) {
    for (const [key, answer] of Object.entries(answers ?? {})) {
      if (key === "titled") texts.push(answer);
      else if (joined[key] === undefined) joined[key] = answer;
    }
  }
  const text = joinText(texts);
  if (text !== undefined) joined.titled = text;
  // No call gave text: keep the first answer, so the log still shows the field
  // the planner was asked and marked "rule".
  else if (texts.length > 0) joined.titled = texts[0]!;
  return joined;
}

/** Caption timing for each beat: the start in video-relative seconds (`seconds`
 * maps a timeline ms to video seconds, as make does for the take) and a fixed
 * on-screen reading time, in output seconds. */
export function captionSpans(beats: Beat[], seconds: (ms: number) => number): Record<string, { t: number; d: number }> {
  return Object.fromEntries(beats.map((b) => [b.id, { t: seconds(b.t0), d: CAPTION_SECONDS }]));
}

/** Trimmed text within the limit, or undefined. */
function line(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text !== "" && text.length <= max ? text : undefined;
}

/** The title and captions of a yes answer. A caption for a beat outside the
 * timeline, a repeat for a beat, or text over its limit is left out. */
function filmText(answer: Answer | undefined, spans: Record<string, { t: number; d: number }>): { title?: string; captions: { t: number; d: number; text: string }[] } {
  if (!answer || answer.abstained || answer.answer !== true) return { captions: [] };
  const fields = answer as unknown as Record<string, unknown>;
  const title = line(fields.title, TITLE_MAX);
  const beats = new Set<string>();
  const captions: { t: number; d: number; text: string }[] = [];
  for (const c of Array.isArray(fields.captions) ? fields.captions : []) {
    const entry = c && typeof c === "object" ? c as Record<string, unknown> : {};
    const beat = typeof entry.beat === "string" && Object.hasOwn(spans, entry.beat) && !beats.has(entry.beat) ? entry.beat : undefined;
    const text = line(entry.text, CAPTION_MAX);
    if (beat === undefined || text === undefined) continue;
    beats.add(beat);
    captions.push({ ...spans[beat]!, text });
  }
  return { ...(title !== undefined ? { title } : {}), captions: captions.sort((a, b) => a.t - b.t) };
}

/** Map the film answers to bounded values. Anything missing, abstained or outside
 * its choices is left out (the base look) and marked "rule". The title and
 * captions come from the planner's own text, timed by `spans`. */
export function mapFilm(answers: Record<string, Answer>, endings: string[], spans: Record<string, { t: number; d: number }>): FilmDecision {
  const by: FilmDecision["by"] = {};
  const pick = <T>(key: string, valid: (answer: unknown) => T | undefined): T | undefined => {
    const a = answers[key];
    const value = a && !a.abstained ? valid(a.answer) : undefined;
    by[key] = value === undefined ? "rule" : "ai";
    return value;
  };
  const oneOf = (options: string[]) => (answer: unknown) =>
    typeof answer === "string" && options.includes(answer) ? answer : undefined;
  const level = (count: number) => (answer: unknown) =>
    Number.isInteger(answer) && (answer as number) >= 0 && (answer as number) < count ? (answer as number) : undefined;
  const theme = pick("theme", oneOf(Object.keys(THEMES)));
  const pace = pick("pace", level(PACE_LEVELS.length));
  const opening = pick("opening", oneOf(Object.keys(OPENINGS)));
  const end = pick("ending", oneOf(endings));
  const style = pick("camera_style", oneOf(Object.keys(CAMERA_STYLES)));
  const text = filmText(answers.titled, spans);
  if (answers.titled !== undefined) by.titled = text.title !== undefined || text.captions.length > 0 ? "ai" : "rule";
  return {
    ...(theme !== undefined ? { theme } : {}),
    ...(pace !== undefined ? { pace: PACE_VALUES[pace]! } : {}),
    ...(opening !== undefined ? { establish_s: OPENINGS[opening]!.establish_s } : {}),
    ...(end !== undefined ? { end_beat: end } : {}),
    ...(style !== undefined ? { camera_path: CAMERA_STYLES[style]!.camera_path } : {}),
    ...(text.title !== undefined ? { title: text.title } : {}),
    ...(text.captions.length > 0 ? { captions: text.captions } : {}),
    by,
  };
}

/** The camera field or saved key each film question sets. */
const FIELD_OF_QUESTION: Record<string, string> = { theme: "theme", pace: "pace", opening: "establish_s", ending: "end_beat", camera_style: "camera_path", titled: "titled" };

/** The choices make applies. A field the user pinned with --set, a theme the user
 * picked, and an ending a trim already bounds are left out, so the saved film and
 * its log match what the render used. */
export function appliedFilm(film: FilmDecision, skip: { pinned: string[]; themeFree: boolean; endFree: boolean }): FilmDecision {
  const dropped = (field: string) => skip.pinned.includes(field) || (field === "theme" && !skip.themeFree) || (field === "end_beat" && !skip.endFree);
  return {
    ...(film.theme !== undefined && !dropped("theme") ? { theme: film.theme } : {}),
    ...(film.pace !== undefined && !dropped("pace") ? { pace: film.pace } : {}),
    ...(film.establish_s !== undefined && !dropped("establish_s") ? { establish_s: film.establish_s } : {}),
    ...(film.end_beat !== undefined && !dropped("end_beat") ? { end_beat: film.end_beat } : {}),
    ...(film.camera_path !== undefined && !dropped("camera_path") ? { camera_path: film.camera_path } : {}),
    ...(film.title !== undefined ? { title: film.title } : {}),
    ...(film.captions !== undefined ? { captions: film.captions } : {}),
    by: Object.fromEntries(Object.entries(film.by).filter(([question]) => !dropped(FIELD_OF_QUESTION[question]!))),
  };
}

/** The film's settings as camera overrides. Theme tokens sit under the film's own
 * choices, and both sit under every key the user pinned with --set (or a theme
 * the user picked, which the film never replaces). */
export function filmOverrides(film: FilmDecision, themeFree: boolean, pinned: string[]): Overrides {
  const o: Overrides = {
    ...(themeFree && film.theme !== undefined ? THEMES[film.theme as ThemeName] : {}),
    ...(film.pace !== undefined ? { pace: film.pace } : {}),
    ...(film.establish_s !== undefined ? { establish_s: film.establish_s } : {}),
    ...(film.camera_path !== undefined ? { camera_path: film.camera_path } : {}),
  };
  for (const key of pinned) delete (o as Record<string, unknown>)[key];
  return o;
}

/** The take's text for a render: its own title and captions when it sets them
 * (an empty title keeps none), else the film's AI text. */
export function withFilmText<T extends { title?: string; captions?: { t: number; d?: number; text: string; position?: "top" | "bottom" }[]; film?: FilmDecision }>(meta: T): T {
  const film = meta.film;
  if (film?.title === undefined && film?.captions === undefined) return meta;
  return { ...meta, title: meta.title ?? film.title, captions: meta.captions ?? film.captions };
}

/** Mean luma of the grey analysis frames, sampled every tenth frame: "light" or "dark". */
export function appBrightness(frames: { data: Uint8Array }[]): "light" | "dark" {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < frames.length; i += 10) {
    for (const v of frames[i]!.data) sum += v;
    count += frames[i]!.data.length;
  }
  return count > 0 && sum / count >= 128 ? "light" : "dark";
}
