// The polish builder: one planner call per refinement round turns the owner's feedback and the judge's gaps into a few
// camera and pacing changes on the picked cut. It never re-plans beats and never touches the picked theme or camera
// motion; every knob it may move is listed here with its bounds, and "keep" is always an option.

import type { Answer, Question } from "@byokit/decide";
import type { CameraDefaults } from "../camera/defaults.ts";
import { pacingValues, type PaceLevel } from "../directions/directions.ts";
import type { Feedback } from "./loop.ts";

type Change = Partial<Record<keyof CameraDefaults, number>>;

interface Knob {
  id: string;
  ask: string;
  options: Record<string, string>;
  /** The camera keys a choice sets, from the seed's camera; null when the choice is already at its bound. */
  apply: (c: CameraDefaults, choice: string) => Change | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const clip = (n: number, lo: number, hi: number) => r2(Math.max(lo, Math.min(hi, n)));

/** A change that leaves every key where it was is no change. */
function moved(c: CameraDefaults, change: Change): Change | null {
  const out: Change = {};
  for (const [k, v] of Object.entries(change) as [keyof CameraDefaults, number][]) if (c[k] !== v) out[k] = v;
  return Object.keys(out).length ? out : null;
}

export const KNOBS: Knob[] = [
  {
    id: "pacing",
    ask: "Overall pacing: hold length between moves, idle footage speed and the opening hold together.",
    options: { brisk: "quick moves and short holds", quick: "a little brisker than usual", steady: "even holds", calm: "longer holds between moves" },
    apply: (c, choice) => moved(c, pacingValues(choice as PaceLevel)),
  },
  {
    id: "zoom",
    ask: "How close the camera pushes in on each action.",
    options: { closer: "push in closer (a fifth less padding around each subject)", wider: "frame each shot wider (a fifth more padding)" },
    apply: (c, choice) => {
      const k = choice === "closer" ? 0.8 : 1.2;
      return moved(c, { l1_pad: clip(c.l1_pad * k, 1.2, 3.2), l2_pad: clip(c.l2_pad * k, 1.1, 2.6), l3_pad: clip(c.l3_pad * k, 1.05, 2.2) });
    },
  },
  {
    id: "moves",
    ask: "How long each camera move takes.",
    options: { faster: "quicker camera moves", slower: "slower, smoother camera moves" },
    apply: (c, choice) => moved(c, { move_t_max: clip(c.move_t_max * (choice === "faster" ? 0.8 : 1.25), 0.6, 2.4) }),
  },
  {
    id: "opening",
    ask: "How long the whole page holds before the first move.",
    options: { shorter: "start moving sooner", longer: "hold the whole page longer first" },
    apply: (c, choice) => moved(c, { establish_s: clip(c.establish_s + (choice === "shorter" ? -0.4 : 0.6), 0, 3) }),
  },
  {
    id: "ending",
    ask: "How the film ends.",
    options: {
      wide: "return to the whole page for the last second", close: "stay on the last shot to the end",
      shorter: "end sooner after the last action", longer: "hold the ending longer",
    },
    apply: (c, choice) => moved(c, choice === "wide" ? { outro_s: Math.max(1.2, c.outro_s) } : choice === "close" ? { outro_s: 0 }
      : choice === "shorter" ? { outro_s: c.outro_s > 0 ? clip(c.outro_s - 0.6, 0.6, 3) : 0 } : { outro_s: clip(c.outro_s + 0.8, 0.8, 3) }),
  },
  {
    id: "cursor",
    ask: "The drawn cursor's size.",
    options: { larger: "a larger cursor", smaller: "a smaller cursor" },
    apply: (c, choice) => moved(c, { cursor_size: clip(c.cursor_size * (choice === "larger" ? 1.25 : 0.8), 0.5, 1.8) }),
  },
  {
    id: "clicks",
    ask: "How strongly each click is marked.",
    options: { stronger: "a longer, larger click ripple", softer: "a shorter, smaller click ripple" },
    apply: (c, choice) => choice === "stronger"
      ? moved(c, { ripple_ms: Math.min(1200, Math.max(700, Math.round(c.ripple_ms * 1.3))), ripple_r: Math.min(140, Math.round(c.ripple_r * 1.3)) })
      : moved(c, { ripple_ms: Math.max(300, Math.round(c.ripple_ms * 0.7)), ripple_r: Math.max(30, Math.round(c.ripple_r * 0.75)) }),
  },
  {
    id: "page",
    ask: "How much of the frame the page fills at rest.",
    options: { larger: "a larger page with less margin around it", smaller: "more margin around the page" },
    apply: (c, choice) => moved(c, { stage_margin: choice === "larger" ? r2(c.stage_margin / 2) : clip(c.stage_margin + 0.03, 0, 0.2) }),
  },
  {
    id: "captions",
    ask: "Caption and title type size.",
    options: { larger: "larger captions", smaller: "smaller captions" },
    apply: (c, choice) => moved(c, { caption_size: Math.round(clip(c.caption_size + (choice === "larger" ? 6 : -6), 22, 56)) }),
  },
  {
    id: "blur",
    ask: "Motion blur on camera moves.",
    options: { more: "more motion blur", none: "no motion blur" },
    apply: (c, choice) => moved(c, { motion_blur: choice === "more" ? clip(c.motion_blur + 0.3, 0, 1) : 0 }),
  },
];

export const POLISH_POLICY = "Polish this picked cut, not a new direction. Keep its theme and camera motion. Change only what the owner's "
  + "feedback or the judge's gaps call for; owner feedback is cumulative and takes priority over the judge's gaps, and an earlier request is never undone. "
  + "The cut is judged against the target: every rubric item under it is a gap, however the judge words it. While the cut is below the target, "
  + "move the knobs that address its lowest items; answer keep for every knob that no feedback or gap calls for.";

export interface BuilderContext {
  direction: { name: string; theme: string };
  camera: CameraDefaults;
  feedback: Feedback[];
  gaps: string[];
  /** The seed's judged score and rubric items, against the target. */
  score: number | null;
  items: { label: string; score: number; note: string }[];
  target: number;
  history: { round: number; score: number | null; accepted: boolean; changes: string[] }[];
  ruleChanges: string[];
}

export function builderRequest(ctx: BuilderContext): { state: Record<string, unknown>; questions: Record<string, Question> } {
  const c = ctx.camera;
  const state = {
    task: POLISH_POLICY,
    direction: ctx.direction,
    settings: {
      pace: c.pace, idle_speed: c.idle_speed, establish_s: c.establish_s, outro_s: c.outro_s, move_t_max: c.move_t_max,
      shot_padding: [c.l1_pad, c.l2_pad, c.l3_pad], cursor_size: c.cursor_size, ripple_ms: c.ripple_ms,
      stage_margin: c.stage_margin, caption_size: c.caption_size, motion_blur: c.motion_blur,
    },
    owner_feedback: ctx.feedback.length ? ctx.feedback.map((f) => f.text) : ["(none)"],
    score: ctx.score === null ? "(not judged)" : `${ctx.score}/10 against a target of ${ctx.target}/10`,
    items_below_target: ctx.items.filter((i) => i.score < ctx.target).map((i) => `${i.label}: ${i.score}/10 - ${i.note}`),
    judge_gaps: ctx.gaps.length ? ctx.gaps : ["(initial assessment)"],
    measured_changes_already_made_this_round: ctx.ruleChanges,
    earlier_rounds: ctx.history,
  };
  const questions: Record<string, Question> = {};
  for (const knob of KNOBS) {
    questions[knob.id] = {
      kind: "choice",
      options: { keep: "no change", ...knob.options },
      instructions: `${knob.ask} Pick keep unless the feedback, a gap or an item under the target calls for this change.`,
      personReason: true,
    };
  }
  return { state, questions };
}

/** Map the builder's answers to camera keys and plain-words changes; an abstained or unknown answer keeps the knob. */
export function mapBuilder(answers: Record<string, Answer>, camera: CameraDefaults): { change: Change; changes: string[] } {
  const change: Change = {};
  const changes: string[] = [];
  for (const knob of KNOBS) {
    const a = answers[knob.id];
    const choice = a && !a.abstained && typeof a.answer === "string" ? a.answer : "keep";
    if (choice === "keep" || !Object.hasOwn(knob.options, choice)) continue;
    const set = knob.apply(camera, choice);
    if (!set) continue;
    Object.assign(change, set);
    const from = Object.keys(set).map((k) => `${k} ${camera[k as keyof CameraDefaults]}`).join(", ");
    const to = Object.entries(set).map(([k, v]) => `${k} ${v}`).join(", ");
    const why = (a?.personReason ?? a?.rationale)?.trim();
    changes.push(`${knob.id}: ${knob.options[choice]} (${from} -> ${to})${why ? ` - ${why}` : ""}`);
  }
  return { change, changes };
}
