// Planner request building, token estimation and the 4,000-token chunk cap.
// Pure functions over plain data: no Node imports.

import type { Answer, Question } from "@byokit/decide";
import type { Beat, Decision } from "../types.ts";

export const JEV_MODEL = "jev-latest";
/** One planner call asks for up to CHUNK_BEATS beats, capped at CHUNK_TOKEN_CAP estimated tokens. */
export const CHUNK_TOKEN_CAP = 4000;
export const CHUNK_BEATS = 8;
export const CHARS_PER_TOKEN = 3.5;
/** Estimate for one keyframe thumbnail (512 px long side, JPEG). Providers bill
 * images by their own tile formulas; this is the planner's budget figure. */
export const IMAGE_TOKENS = 255;
/** Actions per beat described to the planner. */
export const ACTIONS_PER_BEAT = 6;

/** Kit floor on our questions. Zero: takeone's own mapping (mapAnswers) is the
 * single validator in slice 1, so a merely unsure answer still widens through
 * the uncertainty rules instead of dropping the whole beat. Malformed answers
 * still abstain at any floor. Kit floors engage with per-field fallback later. */
export const QUESTION_FLOOR = 0;

export class RequestTooLarge extends Error {}

/** What the fallback rules would do for one beat, shown to the planner as advice. */
export interface BeatHint {
  suggest_shot: { start: string; end: string; tightness: string; rule: string };
  /** whether the rule's start zone fits the shot before the beat */
  fits_current_shot: "yes" | "no";
}

export interface ChunkCtx {
  /** what the demo is for, from --goal (alias --about) */
  goal?: string;
  /** style hint, from --style; carried for the film call, unused by beats */
  style?: string;
  /** description of the shot the viewer is looking at when the chunk's first beat starts */
  currentShot: string;
  /** the beat after the chunk, for what_happened lookahead */
  nextBeat?: Beat;
  /** one hint per beat, in chunk order */
  hints: BeatHint[];
  /** attached thumbnail ids per beat, in chunk order; absent for text-only models */
  images?: string[][];
}

type ZoneNotes = Record<string, { shows: string; size: string; where: string; activity: string; text?: string }>;

export interface ChunkState {
  goal?: string;
  style?: string;
  rubric: Record<string, string>;
  current_shot: string;
  beats: Record<string, { length: string; what_happened: string; zones: ZoneNotes; hint: BeatHint }>;
  after_chunk: string;
}

export const TIGHTNESS_LEVELS = ["entire screen", "window or area", "zone with room", "zone tightly"];
const KEY_LEVELS = ["routine", "useful step", "key moment"];

export function estimateTokens(body: string): number {
  return Math.ceil(body.length / CHARS_PER_TOKEN);
}

const MODIFIERS: Record<string, string> = { ctrl: "Ctrl", control: "Ctrl", alt: "Alt", shift: "Shift", super: "Super", meta: "Super" };
const KEYS = new Set([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "ENTER", "TAB", "ESC", "SPACE", "BACKSPACE", "LEFT", "RIGHT", "UP", "DOWN"]);

function shortcutWords(combo: string): string {
  const parts = combo.split("+").map((part) => part.trim().toLowerCase());
  const key = parts.pop()?.toUpperCase();
  if (!key || !KEYS.has(key) || parts.length === 0 || parts.some((part) => !Object.hasOwn(MODIFIERS, part))) return "a keyboard shortcut";
  return `the ${parts.map((part) => MODIFIERS[part]).join("+")}+${key} shortcut`;
}

/** Words describing what happened in a beat, from its actions and zones. Digit-free. */
export function whatHappened(beat: Beat): string {
  const parts: string[] = [];
  for (const a of beat.actions.slice(0, ACTIONS_PER_BEAT)) {
    switch (a.k) {
      case "click":
        parts.push(a.double ? "The user double-clicked a control" : "The user clicked a control");
        break;
      case "type":
        parts.push("The user typed text");
        break;
      case "drag":
        parts.push("The user dragged a control");
        break;
      case "scroll":
        parts.push("The user scrolled the view");
        break;
      case "shortcut":
        parts.push(`The user pressed ${shortcutWords(a.combo)}`);
        break;
      case "dwell":
        parts.push("The user pointed at a control");
        break;
      case "travel":
        parts.push("The user moved the pointer across the screen");
        break;
      case "focus":
        parts.push("A different window came into focus");
        break;
      case "cut":
        parts.push("The screen changed at once");
        break;
    }
  }
  if (parts.length === 0) parts.push(beat.kind === "change"
    ? "The app view changed; no input events were recorded"
    : beat.kind === "cut" ? "The screen changed at once; no input events were recorded"
    : "Nothing happened; the screen was idle");
  let s = parts.join(", then ") + ".";
  const res = beat.zones.find((z) => z.kind === "res");
  if (res) {
    const adj = res.desc.size.split(",")[0]!; // "medium", "small", ...
    s += ` Then a ${adj} region appeared ${res.desc.where === "center" ? "in the center" : `at the ${res.desc.where}`}.`;
  }
  return s;
}

/** The shared rubric: every judgement's full wording, once per chunk. */
function rubric(goal: string | undefined, withImages: boolean): Record<string, string> {
  return {
    focus_start:
      "At the START of the beat, which zone should the viewer be looking at to see the action the user takes? Pick the zone where the user's action happens.",
    focus_end:
      "At the END of the beat, which zone should the viewer be looking at to understand the result of the action? Pick the zone that shows what changed because of the action; pick the same zone as the action if nothing else changed.",
    tightness:
      "How closely should the camera frame the zone the viewer should look at, so a viewer on a laptop screen can follow the beat? " +
      "entire screen: the beat is about the overall layout or a big change; window or area: the context matters as much as the detail; " +
      "zone with room: the detail matters and the surroundings help; zone tightly: small text or a small control is the whole point.",
    new_subject:
      "Yes when the viewer's attention must move to a different part of the screen than the shot before the beat shows: what matters is outside or much smaller than that shot. " +
      "No when it is already comfortably visible. Before the first beat that shot is current_shot; before a later beat it is the shot the previous beat ends on - the focus_end and tightness you chose for that beat.",
    key_moment:
      `How important is the beat ${goal ? "to the story of `goal`" : "to the demo as a whole"}? ` +
      "routine: navigation or setup a viewer can skim; useful step: a normal step of the workflow; key moment: the payoff or the step the demo exists to show.",
    hints:
      "Each beat's hint is what the fallback rules would pick: suggest_shot names the rule's start zone, end zone and tightness, and fits_current_shot says whether that start zone already fits the shot before the beat (current_shot for the first beat, the rule's shot for the previous beat after it). " +
      "fits_current_shot assumes the previous beat took its suggest_shot; if you chose differently for it, judge new_subject against the shot you chose. " +
      "Hints are advice: overrule them when the beat calls for something else.",
    ...(withImages ? {
      images:
        "Thumbnails <beat>_act (at the action) and <beat>_res (at the result) show the screen with every zone outlined and labelled by its name. Outside the zones whose text is read the screen is blurred; black boxes are redacted text.",
    } : {}),
  };
}

/** Per-beat questions: short pointers into the shared rubric. Choice criteria
 * keep the planner's null descriptions (cast: the wire passes values through
 * verbatim). */
function beatQuestions(id: string, zones: ZoneNotes, images: string[] | undefined): Record<string, Question> {
  const options = Object.fromEntries(Object.keys(zones).map((n) => [n, null])) as unknown as Record<string, string>;
  const pointer = (rule: string) => `Apply rubric.${rule} to beats.${id}.`;
  const seen = images?.length ? { images } : {};
  return {
    [`${id}_focus_start`]: { kind: "choice", floor: QUESTION_FLOOR, options, instructions: pointer("focus_start"), ...seen },
    [`${id}_focus_end`]: { kind: "choice", floor: QUESTION_FLOOR, options, instructions: pointer("focus_end"), ...seen },
    [`${id}_tightness`]: { kind: "score", floor: QUESTION_FLOOR, levels: TIGHTNESS_LEVELS, instructions: pointer("tightness"), ...seen },
    [`${id}_new_subject`]: { kind: "yesno", floor: QUESTION_FLOOR, question: pointer("new_subject") },
    [`${id}_key_moment`]: { kind: "score", floor: QUESTION_FLOOR, levels: KEY_LEVELS, instructions: pointer("key_moment") },
  };
}

/** One beat's answers out of a chunk's, keyed by the bare question name. */
export function beatAnswers(answers: Record<string, Answer>, id: string): Record<string, Answer> {
  const prefix = `${id}_`;
  return Object.fromEntries(Object.entries(answers).filter(([k]) => k.startsWith(prefix)).map(([k, a]) => [k.slice(prefix.length), a]));
}

/** Mirror of @byokit/decide's internal wire(): Question -> planner JSON, used
 *  only for the token estimate. The kit floors (floor: 0 here) stay kit-side
 *  and never enter the body. */
function toWire(questions: Record<string, Question>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([k, q]) => {
      if (q.kind === "choice")
        return [k, { type: "choice", instructions: q.instructions ?? "Which option fits the state?", criteria: q.options }];
      if (q.kind === "yesno")
        return [k, { type: "noul", instructions: q.question, ...(q.yes && q.no ? { criteria: { true: q.yes, false: q.no } } : {}) }];
      if (q.kind === "score")
        return [k, { type: "score", instructions: q.instructions ?? "Where does the state fall on this scale?", criteria: q.levels }];
      throw new Error(`unsupported planner question kind: ${q.kind}`);
    }),
  );
}

function zoneNotes(beat: Beat): ZoneNotes {
  const zones: ZoneNotes = {};
  for (const z of beat.zones) {
    zones[z.name] = {
      shows: z.desc.shows,
      size: z.desc.size,
      where: z.desc.where,
      activity: z.desc.activity,
      ...(z.desc.text ? { text: z.desc.text } : {}),
    };
  }
  return zones;
}

/**
 * Build one chunk request: up to CHUNK_BEATS beats sharing one rubric, capped
 * at CHUNK_TOKEN_CAP estimated tokens (thumbnails included). Over the cap,
 * screen words are dropped first; a single beat then shortens style and goal.
 * Still over: RequestTooLarge, and planChunks splits the chunk in half.
 * `state`/`questions` go to decide() as they are.
 */
export function buildChunk(
  beats: Beat[],
  ctx: ChunkCtx,
): { body: string; tokens: number; state: ChunkState; questions: Record<string, Question>; trimmed: boolean } {
  const imageCount = (ctx.images ?? []).reduce((n, ids) => n + ids.length, 0);
  const state: ChunkState = {
    ...(ctx.goal ? { goal: ctx.goal } : {}),
    ...(ctx.style ? { style: ctx.style } : {}),
    rubric: rubric(ctx.goal, imageCount > 0),
    current_shot: ctx.currentShot,
    beats: {},
    after_chunk: ctx.nextBeat ? whatHappened(ctx.nextBeat) : "The take ends after these beats.",
  };
  beats.forEach((b, k) => {
    state.beats[b.id] = {
      length: `${((b.t1 - b.t0) / 1000).toFixed(1)} seconds`,
      what_happened: whatHappened(b),
      zones: zoneNotes(b),
      hint: ctx.hints[k]!,
    };
  });
  const questions = () => Object.assign({}, ...beats.map((b, k) => beatQuestions(b.id, state.beats[b.id]!.zones, ctx.images?.[k])));
  const measure = () => {
    const body = JSON.stringify({ model: JEV_MODEL, state, questions: toWire(questions()) });
    return { body, tokens: estimateTokens(body) + imageCount * IMAGE_TOKENS };
  };
  let m = measure();
  // drop screen words, word by word, until under the cap
  for (const beat of Object.values(state.beats)) {
    for (const z of Object.values(beat.zones)) {
      if (!z.text) continue;
      const words = z.text.split(" ");
      while (words.length > 0 && m.tokens > CHUNK_TOKEN_CAP) {
        words.pop();
        z.text = words.join(" ");
        m = measure();
      }
      if (!z.text) delete z.text;
    }
  }
  let trimmed = false;
  if (beats.length === 1) {
    for (const field of ["style", "goal"] as const) {
      const words = state[field]?.split(/\s+/) ?? [];
      while (words.length && m.tokens > CHUNK_TOKEN_CAP) {
        words.pop();
        if (words.length) state[field] = words.join(" ");
        else delete state[field];
        trimmed = true;
        state.rubric = rubric(state.goal, imageCount > 0);
        m = measure();
      }
    }
  }
  if (m.tokens > CHUNK_TOKEN_CAP) throw new RequestTooLarge(`request exceeds ${CHUNK_TOKEN_CAP} estimated tokens`);
  return { ...m, state, questions: questions(), trimmed };
}

/**
 * Group items into ordered chunks of at most CHUNK_BEATS, sized evenly (ten
 * beats ask as five and five, not eight and two). A chunk the builder refuses
 * as too large splits in half; a single item that is still too large goes to
 * `tooLarge` and keeps the rules.
 */
export function planChunks<T, C>(items: T[], build: (group: T[]) => C, tooLarge: (item: T) => void): { items: T[]; chunk: C }[] {
  const out: { items: T[]; chunk: C }[] = [];
  const place = (group: T[]): void => {
    try {
      out.push({ items: group, chunk: build(group) });
    } catch (e) {
      if (!(e instanceof RequestTooLarge)) throw e;
      if (group.length === 1) return tooLarge(group[0]!);
      const half = Math.ceil(group.length / 2);
      place(group.slice(0, half));
      place(group.slice(half));
    }
  };
  const n = Math.ceil(items.length / CHUNK_BEATS);
  for (let k = 0; k < n; k++) {
    place(items.slice(Math.round((k * items.length) / n), Math.round(((k + 1) * items.length) / n)));
  }
  return out;
}

export type { Decision };
