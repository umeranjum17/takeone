// Directions: two or three distinct cuts of one take before any polishing. A
// direction is a look (theme), a pacing and a camera motion, rendered from the
// same plan with `--set` pairs; it never re-plans the take's beats. One planner
// call proposes the directions; the rules below keep them distinct, and a
// field the planner abstained on takes the fixed table's value.

import type { Answer, Question } from "@byokit/decide";
import { PACE_LEVELS, PACE_VALUES, THEME_NOTES } from "../decide/film.ts";
import { THEMES, type ThemeName } from "../themes.ts";

export const DIRECTION_IDS = ["a", "b", "c"] as const;
export type DirectionId = (typeof DIRECTION_IDS)[number];
export type PaceLevel = "brisk" | "quick" | "steady" | "calm";

/** How the camera moves in a direction. Each is a handful of camera keys, solved by the same composer. */
export const MOTIONS = {
  follow: { label: "the camera follows the action", set: { camera_path: "solver" } },
  hold: { label: "the camera holds each framing and moves only between them", set: { camera_path: "hold" } },
  // Tighter context and medium padding with quicker moves; the tight level and the text guards are unchanged.
  close: { label: "the camera pushes in closer and moves quicker", set: { camera_path: "solver", l1_pad: 1.9, l2_pad: 1.55, move_t_max: 1.1 } },
} as const;
export type MotionStyle = keyof typeof MOTIONS;

/** Pacing per level: the hold multiplier the film call uses, how fast idle footage plays and the opening hold. */
/** Idle footage plays at most this many times faster in a direction or a polish round. On the 43 s 4K proof take the
 * camera solve took 192-220 s at 4x and 5x and ran past an hour at 6x (its text guard decodes far more source windows). */
export const IDLE_SPEED_MAX = 5;

const PACING: Record<PaceLevel, { idle_speed: number; establish_s: number }> = {
  brisk: { idle_speed: IDLE_SPEED_MAX, establish_s: 0.8 },
  quick: { idle_speed: 4, establish_s: 1.2 },
  steady: { idle_speed: 3, establish_s: 1.6 },
  calm: { idle_speed: 2, establish_s: 2 },
};

export interface Direction {
  id: DirectionId;
  /** Plain words a person reads: theme, pacing and motion. */
  name: string;
  theme: ThemeName;
  pace: PaceLevel;
  motion: MotionStyle;
  /** Why the planner chose it, when it said; the rule that made it otherwise. */
  why: string;
  /** Per field: the planner's own choice, or a rule (an abstention, or a duplicate made distinct). */
  by: { theme: "ai" | "rule"; pace: "ai" | "rule"; motion: "ai" | "rule" };
  /** The `--set` pairs this direction renders with, on top of its theme. */
  set: string[];
}

/** The direction `takeone pick` saved on the take; render and make honour it like a typed --theme and --set. */
export interface PickedDirection {
  id: DirectionId;
  name: string;
  theme: ThemeName;
  set: string[];
  /** Set when a polish run's final round replaced the picked pairs. */
  polished?: { run: string; round: number; score: number };
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function directionName(theme: ThemeName, pace: PaceLevel, motion: MotionStyle): string {
  return `${titleCase(theme)}, ${pace} pacing, ${MOTIONS[motion].label}`;
}

/** The camera keys of one pacing level: the hold multiplier, idle footage speed and opening hold. */
export function pacingValues(pace: PaceLevel): { pace: number; idle_speed: number; establish_s: number } {
  return { pace: PACE_VALUES[PACE_LEVELS.indexOf(pace)]!, ...PACING[pace] };
}

/** The `--set` pairs of a theme-less direction: its pacing and its motion. */
export function directionSet(pace: PaceLevel, motion: MotionStyle): string[] {
  const pairs: Record<string, number | string> = { ...pacingValues(pace), ...MOTIONS[motion].set };
  return Object.entries(pairs).map(([k, v]) => `${k}=${v}`);
}

function direction(id: DirectionId, theme: ThemeName, pace: PaceLevel, motion: MotionStyle, why: string, by: Direction["by"]): Direction {
  return { id, name: directionName(theme, pace, motion), theme, pace, motion, why, by, set: directionSet(pace, motion) };
}

/** The fixed table for fields the planner abstained on: a dark, a light and a bold direction that differ on every axis. */
const PRESETS: [ThemeName, PaceLevel, MotionStyle][] = [
  ["midnight", "quick", "follow"],
  ["paper", "calm", "hold"],
  ["aurora", "brisk", "close"],
];

export interface DirectionsCtx {
  seconds: number;
  device: string;
  goal?: string;
  style?: string;
  /** One short line per beat: its length and what happened in it. */
  timeline: string[];
}

/** Lines of the take's timeline the request carries; a longer take is summarised by its first and last beats. */
const TIMELINE_LINES = 40;

/** The one planner call: a theme, a pacing and a motion for each option, told to make them distinct. */
export function directionsRequest(ctx: DirectionsCtx, count: number): { state: Record<string, unknown>; questions: Record<string, Question> } {
  const timeline = ctx.timeline.length <= TIMELINE_LINES ? ctx.timeline
    : [...ctx.timeline.slice(0, TIMELINE_LINES / 2), `(${ctx.timeline.length - TIMELINE_LINES} beats in between)`, ...ctx.timeline.slice(-TIMELINE_LINES / 2)];
  const state = {
    task: `Propose ${count} clearly different directions for one product demo film cut from the same screen recording. `
      + "Each direction is a look (theme), a pacing and a camera motion. They are rendered side by side and the owner picks one, "
      + "so make them genuinely different: a different theme each, and a different pacing or camera motion between any two.",
    ...(ctx.goal ? { goal: ctx.goal } : {}),
    ...(ctx.style ? { style: ctx.style } : {}),
    take: { length: `${ctx.seconds.toFixed(1)} seconds`, device: ctx.device },
    timeline,
  };
  const questions: Record<string, Question> = {};
  for (const id of DIRECTION_IDS.slice(0, count)) {
    const letter = id.toUpperCase();
    questions[`theme_${id}`] = {
      kind: "choice",
      options: Object.fromEntries(Object.entries(THEME_NOTES)),
      instructions: `Direction ${letter}: which theme? Use a different theme for each direction.`,
      personReason: true,
    };
    questions[`pace_${id}`] = {
      kind: "choice",
      options: { brisk: "quick moves and short holds", quick: "a little brisker than usual", steady: "even holds", calm: "longer holds between moves" },
      instructions: `Direction ${letter}: how should it be paced?`,
    };
    questions[`motion_${id}`] = {
      kind: "choice",
      options: Object.fromEntries(Object.entries(MOTIONS).map(([k, v]) => [k, v.label])),
      instructions: `Direction ${letter}: how should the camera move?`,
    };
  }
  return { state, questions };
}

const picked = (a: Answer | undefined): string | undefined =>
  a && !a.abstained && typeof a.answer === "string" ? a.answer : undefined;

/** The options of a choice answer, most probable first; the picked one leads. */
function ranked(a: Answer | undefined): string[] {
  const p = a?.probabilities ?? {};
  return [...new Set([...(picked(a) ? [picked(a)!] : []), ...Object.keys(p).sort((x, y) => (p[y] ?? 0) - (p[x] ?? 0))])];
}

/**
 * Map the planner's answers to directions, keeping them distinct: a repeated theme takes the next most probable
 * unused theme (then the fixed table's), and two directions with the same pacing and motion get the first unused
 * motion. An abstained field falls to the fixed table. Every replacement is marked "rule".
 */
export function mapDirections(answers: Record<string, Answer>, count: number): Direction[] {
  const out: Direction[] = [];
  const themes = Object.keys(THEMES) as ThemeName[];
  for (const [i, id] of DIRECTION_IDS.slice(0, count).entries()) {
    const [presetTheme, presetPace, presetMotion] = PRESETS[i]!;
    const used = new Set(out.map((d) => d.theme));
    const themeAnswer = answers[`theme_${id}`];
    const fromAi = ranked(themeAnswer).filter((t): t is ThemeName => themes.includes(t as ThemeName));
    const aiTheme = picked(themeAnswer) as ThemeName | undefined;
    const theme = [...fromAi, presetTheme, ...PRESETS.map(([t]) => t), ...themes].find((t) => !used.has(t))!;
    const paceAnswer = picked(answers[`pace_${id}`]);
    const pace = (paceAnswer !== undefined && Object.hasOwn(PACING, paceAnswer) ? paceAnswer : presetPace) as PaceLevel;
    const motionAnswer = picked(answers[`motion_${id}`]);
    let motion = (motionAnswer !== undefined && Object.hasOwn(MOTIONS, motionAnswer) ? motionAnswer : presetMotion) as MotionStyle;
    let motionBy: "ai" | "rule" = motion === motionAnswer ? "ai" : "rule";
    if (out.some((d) => d.pace === pace && d.motion === motion)) {
      const free = (Object.keys(MOTIONS) as MotionStyle[]).find((m) => !out.some((d) => d.pace === pace && d.motion === m));
      if (free) { motion = free; motionBy = "rule"; }
    }
    const reason = themeAnswer?.personReason ?? themeAnswer?.rationale;
    const by = { theme: theme === aiTheme ? "ai" as const : "rule" as const, pace: pace === paceAnswer ? "ai" as const : "rule" as const, motion: motionBy };
    const why = by.theme === "ai" && reason ? reason : by.theme === "ai" ? "the planner's choice" : "made distinct by rule";
    out.push(direction(id, theme, pace, motion, why, by));
  }
  return out;
}
