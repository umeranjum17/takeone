// The screenshot planner's decision vocabulary: the film shapes it picks between, the focus third of a
// screen, the questions it would be asked and the answers mapped back onto them. Image planning is off
// until screenshots can be redacted, so nothing here reads a user image or calls a provider.
import type { Answer, Question } from "@byokit/decide";
import { THEME_NOTES } from "../decide/film.ts";
import type { PatternName } from "./types.ts";

/** The film shapes the planner picks between: the patterns each one plans. */
export const SHAPES: Record<string, { label: string; patterns: PatternName[] }> = {
  hero: { label: "open on a title over the first screen, tour each screen, then the end card", patterns: ["hero-reveal", "zoom-tour", "end-card"] },
  tour: { label: "tour each screen straight into the end card, no title", patterns: ["zoom-tour", "end-card"] },
};

/** Thirds of a screen, row by row, then the whole screen. */
export const FOCUS = ["top-left", "top-centre", "top-right", "middle-left", "middle-centre", "middle-right", "bottom-left", "bottom-centre", "bottom-right", "whole"];

export interface ScreenInfo { id: string; width: number; height: number }

/** Fields a flag fixed: the planner is not asked about them. `orderFree` is true when no region flag fixed the screen order. */
export interface Pins { theme: boolean; shape: boolean; orderFree: boolean; focus: ReadonlySet<string> }

export interface ScreenAsk { state: Record<string, unknown>; questions: Record<string, Question> }

export interface ScreenDecision {
  theme?: string;
  shape?: string;
  order: string[];
  /** Focus key per screen the planner decided; a screen it abstained on keeps the local framing, with no region of its own. */
  focus: Record<string, string>;
  abstained: string[];
  /** How many fields the planner decided; zero means the film is the local plan. */
  decided: number;
}

/** The questions for these screens, minus the pinned fields. The screen images ride on the questions that use them. */
export function screenAsk(screens: ScreenInfo[], pins: Pins): ScreenAsk {
  const ids = screens.map((s) => s.id);
  const questions: Record<string, Question> = {};
  if (!pins.theme) {
    questions.theme = { kind: "choice", options: THEME_NOTES, images: ids,
      instructions: "Which look fits these screens? Match light app screens to a light theme, dark screens to a dark one." };
  }
  if (!pins.shape) {
    questions.shape = { kind: "choice", options: Object.fromEntries(Object.entries(SHAPES).map(([k, v]) => [k, v.label])), images: ids,
      instructions: "Which film shape tells this product's story best? hero opens on a title; tour goes straight to the screens." };
  }
  if (pins.orderFree && screens.length > 1) {
    questions.order = { kind: "rank", candidates: Object.fromEntries(screens.map((s, i) => [s.id, `screenshot ${i + 1} of ${screens.length}`])), images: ids,
      instructions: "Order the screens for the film: the first opens the story, the last is the result to leave the viewer with." };
  }
  const focusOptions = Object.fromEntries(FOCUS.map((k) => [k, k === "whole" ? "the whole screen" : `the ${k} third of the screen`]));
  for (const s of screens) {
    if (pins.focus.has(s.id)) continue;
    questions[`focus_${s.id}`] = { kind: "choice", options: focusOptions, images: [s.id],
      instructions: "Which part of this screen should the film zoom into? Pick the part that shows what this screen is for; whole when the whole screen matters." };
  }
  return { state: { screens: screens.map((s) => ({ id: s.id, width: s.width, height: s.height })) }, questions };
}

/** Map the planner's answers onto the asked fields. Malformed or abstained answers fall back and are listed. */
export function screenDecision(answers: Record<string, Answer>, screens: ScreenInfo[], pins: Pins): ScreenDecision {
  const abstained: string[] = [];
  let decided = 0;
  const choice = (k: string, options: string[]): string | undefined => {
    const a = answers[k];
    const v = a && !a.abstained && typeof a.answer === "string" && options.includes(a.answer) ? a.answer : undefined;
    if (v === undefined) abstained.push(k);
    else decided++;
    return v;
  };
  const theme = pins.theme ? undefined : choice("theme", Object.keys(THEME_NOTES));
  const shape = pins.shape ? undefined : choice("shape", Object.keys(SHAPES));
  const ids = screens.map((s) => s.id);
  let order = ids;
  if (pins.orderFree && ids.length > 1) {
    const a = answers["order"];
    const ranking = a && !a.abstained && Array.isArray(a.answer) ? a.answer : undefined;
    if (ranking && ranking.length === ids.length && new Set(ranking).size === ids.length && ids.every((id) => ranking.includes(id))) {
      order = ranking;
      decided++;
    } else abstained.push("order");
  }
  const focus: Record<string, string> = {};
  for (const s of screens) {
    if (pins.focus.has(s.id)) continue;
    const key = choice(`focus_${s.id}`, FOCUS);
    if (key !== undefined) focus[s.id] = key;
  }
  return { theme, shape, order, focus, abstained, decided };
}
