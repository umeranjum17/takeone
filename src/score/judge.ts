import type { Answer, DecideCache, ImageInput, Question } from "@byokit/decide";
import { blurredStill } from "../decide/ocr.ts";
import type { CallBudget } from "../decide/budget.ts";
import { askChunk, seesImages, type ResolvedPlanner } from "../decide/planner.ts";
import { RUBRIC, scoreCard, type MeasuredFacts, type RubricId, type ScoreCard } from "./rubric.ts";

export class JudgeUnavailable extends Error {
  constructor(reason: string) {
    super(`score judge: ${reason}`);
    this.name = "JudgeUnavailable";
  }
}

export const LEVELS = [
  "0 - absent or broken",
  "1 - barely present",
  "2 - weak",
  "3 - below the bar",
  "4 - below the bar, some value",
  "5 - adequate",
  "6 - adequate, visible gaps",
  "7 - good",
  "8 - good, one clear gap",
  "9 - strong",
  "10 - at the reference bar",
];

const MAX_IMAGES = 3;
export const JUDGE_TIMEOUT_MS = 180000;

/** Where the longest actionless span sits: an opening establishing shot reads differently from dead air mid-film. */
function holdWhere(f: MeasuredFacts): string {
  if (f.longestHoldAt === undefined || f.longestHold <= 0) return "";
  const end = f.longestHoldAt + f.longestHold;
  const where = f.longestHoldAt < 0.05 ? "the opening shot, before the first action" : end > f.duration - 0.05 ? "the closing shot, after the last action" : "between two actions";
  return ` (${f.longestHoldAt.toFixed(2)}-${end.toFixed(2)}s, ${where})`;
}

function factsText(f: MeasuredFacts): string {
  return [
    `${f.duration.toFixed(2)}s, ${f.frameCount} frames`,
    `page area share ${(f.pageShare * 100).toFixed(1)}% (stage margin ${(f.stageMargin * 100).toFixed(1)}%)`,
    `beats ${f.beats}; longest actionless span ${f.longestHold.toFixed(2)}s${holdWhere(f)}`,
    f.pointerSamples === 0 ? "no pointer samples" : `${f.pointerSamples} pointer samples`,
    f.cursorDrawn ? "drawn cursor present" : "no drawn cursor",
    f.clickOverlay ? `${f.clickCount} click(s) drawn` : "no click emphasis",
    `camera zoom at the click ${f.zoomAtClick.toFixed(2)}x`,
    ...(f.resultInFrame === undefined ? [] : [`${Math.round(f.resultInFrame * 100)}% of the click's result region in the last frame`]),
    `${f.captions} caption(s), ${f.title ? "title present" : "no title"}, caption type ${f.captionSize}px`,
    f.safeAreaFailures === 0 ? "safe-area check passed" : `${f.safeAreaFailures} safe-area failures`,
    `determinism ${f.determinism.identical}/${f.determinism.frames} identical frames (tolerance ${(f.determinism.tolerance * 100).toFixed(1)}%)`,
    f.baseline === undefined ? "baseline: this round is the baseline" : `baseline round ${f.baseline.round}: score ${f.baseline.score.toFixed(1)}, page ${(f.baseline.pageShare * 100).toFixed(1)}%, cursor ${f.baseline.cursorDrawn ? "yes" : "no"}, click ${f.baseline.clickOverlay ? "yes" : "no"}, zoom ${f.baseline.zoomAtClick.toFixed(2)}x${f.baseline.resultInFrame === undefined ? "" : `, click result ${Math.round(f.baseline.resultInFrame * 100)}% in the last frame`}`,
  ].join("; ");
}

function questions(f: MeasuredFacts, extras: JudgeExtras): Record<string, Question> {
  const out: Record<string, Question> = {};
  for (const item of RUBRIC) {
    if (item.id === "baseline" && f.baseline === undefined) continue;
    out[item.id] = {
      kind: "score",
      levels: LEVELS,
      floor: 0,
      instructions: `${item.what}\nMeasured for this film: ${factsText(f)}`,
      // Below 9, the reason is the gap the next round works on: name what to change, not that it is weak.
      ...(extras.gaps ? { personReason: true } : {}),
    };
  }
  for (const [i, item] of (extras.feedback ?? []).entries()) {
    out[`feedback_${i + 1}`] = {
      kind: "yesno",
      question: `The owner asked: "${item.text}". Is that request visibly met in this round's film, judged from the stills, the measured facts and the build settings listed? `
        + "Yes only when it is met, not merely attempted.",
      personReason: true,
    };
  }
  return out;
}

/** Optional asks beside the rubric in the same single call: actionable gaps and the owner's cumulative feedback. */
export interface JudgeExtras {
  /** Ask a one-line reason with each item score; items under 9 become the round's gaps. */
  gaps?: boolean;
  /** The owner's requests so far, each checked as met or not met with a reason. */
  feedback?: { id: string; text: string }[];
  /** Extra state the judge reads: the picked direction, this round's build settings and changes, earlier scores. */
  context?: Record<string, unknown>;
}

export interface FeedbackCheck {
  id: string;
  kept: boolean;
  reason: string;
}

export interface JudgedCard extends ScoreCard {
  /** Actionable gaps: every item under 9 with the judge's reason, or the measured note when it gave none. */
  gaps: string[];
  feedback: FeedbackCheck[];
  /** "cache" when the answers came from judge-cache.jsonl and no model call was made. */
  source: "api" | "cache";
  inputTokens?: number;
  outputTokens?: number;
}

/** A yes/no answer as a boolean; an abstained or missing one makes the judge unavailable (a check is never assumed met). */
export function answerYes(id: string, answer: Answer | undefined): boolean {
  if (!answer || answer.abstained || typeof answer.answer !== "boolean") throw new JudgeUnavailable(`${id}: ${answer?.reason ?? "no answer"}`);
  return answer.answer;
}

/** The judged frames show the recorded screen, so they go out blurred whole: the judge sees layout, framing and zoom, not words. */
async function imageInputs(f: MeasuredFacts): Promise<ImageInput[] | undefined> {
  const frames = f.frames.slice(0, MAX_IMAGES);
  if (frames.length === 0) return undefined;
  return Promise.all(frames.map(async (frame) => ({ id: frame.label, mime: "image/png", bytes: await blurredStill(frame.path) })));
}

/** A score the judge split evenly between levels abstains as a tie; the strict reading is the lower tied level. */
export function lowerOfTie(a: Answer): number | undefined {
  if (!a.abstained || a.reason !== "tie" || !a.probabilities) return undefined;
  const top = Math.max(...Object.values(a.probabilities));
  const levels = Object.entries(a.probabilities).filter(([, p]) => p === top).map(([level]) => Number(level));
  return levels.every(Number.isFinite) ? Math.min(...levels) : undefined;
}

/** One score answer as a number: a tie takes the lower level; an abstained, empty or non-numeric answer makes the judge unavailable. */
export function answerScore(id: string, answer: Answer | undefined): number {
  const tied = answer ? lowerOfTie(answer) : undefined;
  if (tied === undefined && (!answer || answer.abstained || answer.answer === null || answer.answer === undefined)) {
    throw new JudgeUnavailable(`${id}: ${answer?.reason ?? "no answer"}`);
  }
  const value = tied ?? (typeof answer!.answer === "number" ? answer!.answer : Number(answer!.answer));
  if (!Number.isFinite(value)) throw new JudgeUnavailable(`${id}: non-numeric answer`);
  if (!Number.isInteger(value) || value < 0 || value > 10) {
    throw new JudgeUnavailable(`${id}: score must be an integer from 0 to 10`);
  }
  return value;
}

export interface JudgeOptions {
  cache: DecideCache;
  budget: CallBudget;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export async function judgeRound(
  planner: ResolvedPlanner,
  facts: MeasuredFacts,
  o: JudgeOptions,
  extras: JudgeExtras = {},
): Promise<JudgedCard> {
  if (!planner.active) throw new JudgeUnavailable(`${planner.label} is not available${planner.refusal ? `: ${planner.refusal}` : ""}`);
  const vision = await seesImages(planner);
  const images = vision ? await imageInputs(facts) : undefined;
  const state = {
    task: "Score a 15-second-scale SaaS product film against a written rubric. Be strict: a film that only scrolls is not an interaction film.",
    scale: "Each item is an integer from 0 (absent or broken) to 10 (at the reference bar).",
    frameNote: vision
      ? "The attached stills are single frames from this round's film, in the order listed, blurred so no screen text is readable; judge layout, framing and zoom from them and the measured facts."
      : "Single frames were extracted from this round's film and measured; this route is text-only, so score the measured facts.",
    measured: {
      duration: facts.duration,
      frameCount: facts.frameCount,
      pageShare: facts.pageShare,
      stageMargin: facts.stageMargin,
      pointerSamples: facts.pointerSamples,
      cursorFree: facts.cursorFree,
      cursorDrawn: facts.cursorDrawn,
      clickOverlay: facts.clickOverlay,
      clickCount: facts.clickCount,
      zoomAtClick: facts.zoomAtClick,
      captionSize: facts.captionSize,
      captions: facts.captions,
      title: facts.title,
      safeAreaFailures: facts.safeAreaFailures,
      beats: facts.beats,
      longestHold: facts.longestHold,
      ...(facts.longestHoldAt === undefined ? {} : { longestHoldAt: facts.longestHoldAt }),
      ...(facts.resultInFrame === undefined ? {} : { resultInFrame: facts.resultInFrame }),
      determinism: facts.determinism,
      baseline: facts.baseline ?? null,
      frames: facts.frames.map(({ label, t, shows }) => ({ label, t: Number(t.toFixed(2)), shows })),
    },
    rubric: RUBRIC.map(({ id, label, weight, what }) => ({ id, label, weight, what })),
    ...(extras.context ?? {}),
  };
  const outcome = await askChunk(state, questions(facts, extras), planner, o.cache, {
    timeoutMs: JUDGE_TIMEOUT_MS,
    keepAnswers: true,
    budget: o.budget,
    workflow: "judge",
    ...(images ? { images } : {}),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
  });
  if (!outcome.answers) throw new JudgeUnavailable(outcome.failure ?? "the judge returned no answers");
  const scores: Partial<Record<RubricId, number>> = {};
  for (const item of RUBRIC) {
    if (item.id === "baseline" && facts.baseline === undefined) continue;
    const value = answerScore(item.id, outcome.answers[item.id]);
    scores[item.id] = value;
  }
  const card = scoreCard(scores, facts, planner.label, 1);
  const said = (id: string) => { const a = outcome.answers![id]; return (a?.personReason ?? a?.rationale)?.trim(); };
  const gaps = extras.gaps
    ? card.items.filter((item) => item.score < 9).map((item) => `${item.label} (${item.score}/10): ${said(item.id) || item.note}`)
    : [];
  const feedback = (extras.feedback ?? []).map((item, i) => {
    const id = `feedback_${i + 1}`;
    return { id: item.id, kept: answerYes(id, outcome.answers![id]), reason: said(id) || "no reason given" };
  });
  return {
    ...card, gaps, feedback, source: outcome.decisionSource === "cache" ? "cache" : "api",
    ...(outcome.inputTokens === undefined ? {} : { inputTokens: outcome.inputTokens }),
    ...(outcome.outputTokens === undefined ? {} : { outputTokens: outcome.outputTokens }),
  };
}
