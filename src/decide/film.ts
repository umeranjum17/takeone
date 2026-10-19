// The film call: one planner call per take picks the theme, pace, opening,
// ending and camera style from the whole take, before the beat chunks. These
// are the pure builders and the answer mapping; make.ts asks and applies.
// A field the planner abstains on keeps the base look (no override).

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

export interface FilmDecision {
  /** Theme tokens, applied under --set; absent keeps the base look. */
  theme?: string;
  pace?: number;
  establish_s?: number;
  camera_path?: CameraDefaults["camera_path"];
  /** The beat the take ends on; the film keeps outro_s after it. */
  end_beat?: string;
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
}

/** The film request, or null when even the whole take is too long for one call. */
export function buildFilm(ctx: FilmCtx): { state: Record<string, unknown>; questions: Record<string, Question>; tokens: number; endings: string[] } | null {
  const endings = ctx.beats.slice(-ENDING_CANDIDATES);
  const state = {
    ...(ctx.goal ? { goal: ctx.goal } : {}),
    ...(ctx.style ? { style: ctx.style } : {}),
    take: { length: `${ctx.seconds.toFixed(1)} seconds`, source: ctx.source, device: ctx.device, app_brightness: ctx.brightness },
    timeline: ctx.beats.map((b) => `${b.id}, ${((b.t1 - b.t0) / 1000).toFixed(1)} seconds: ${whatHappened(b)}`),
  };
  const questions: Record<string, Question> = {
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
    ending: {
      kind: "choice",
      options: Object.fromEntries(endings.map((b) => [b.id, whatHappened(b)])),
      instructions: "Which beat should the film end on? The film keeps a short outro after it.",
    },
    camera_style: {
      kind: "choice",
      options: Object.fromEntries(Object.entries(CAMERA_STYLES).map(([k, v]) => [k, v.label])),
      instructions: "Calm: hold each framing and move only between them. Lively: the camera follows the action.",
    },
  };
  const tokens = estimateTokens(JSON.stringify({ model: JEV_MODEL, state, questions: toWire(questions) }));
  const endingIds = endings.map((b) => b.id);
  return tokens > CHUNK_TOKEN_CAP ? null : { state, questions, tokens, endings: endingIds };
}

/** Map the film answers to bounded values. Anything missing, abstained or outside
 * its choices is left out (the base look) and marked "rule". */
export function mapFilm(answers: Record<string, Answer>, endings: string[]): FilmDecision {
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
  return {
    ...(theme !== undefined ? { theme } : {}),
    ...(pace !== undefined ? { pace: PACE_VALUES[pace]! } : {}),
    ...(opening !== undefined ? { establish_s: OPENINGS[opening]!.establish_s } : {}),
    ...(end !== undefined ? { end_beat: end } : {}),
    ...(style !== undefined ? { camera_path: CAMERA_STYLES[style]!.camera_path } : {}),
    by,
  };
}

/** The camera field or saved key each film question sets. */
const FIELD_OF_QUESTION: Record<string, string> = { theme: "theme", pace: "pace", opening: "establish_s", ending: "end_beat", camera_style: "camera_path" };

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
