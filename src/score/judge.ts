import { readFileSync } from "node:fs";
import type { Answer, DecideCache, ImageInput, Question } from "@byokit/decide";
import { askChunk, seesImages, type ResolvedPlanner } from "../decide/planner.ts";
import { RUBRIC, scoreCard, type MeasuredFacts, type RubricId, type ScoreCard } from "./rubric.ts";

export class JudgeUnavailable extends Error {
  constructor(reason: string) {
    super(`score judge: ${reason}`);
    this.name = "JudgeUnavailable";
  }
}

const LEVELS = [
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

function questions(f: MeasuredFacts): Record<string, Question> {
  const out: Record<string, Question> = {};
  for (const item of RUBRIC) {
    if (item.id === "baseline" && f.baseline === undefined) continue;
    out[item.id] = {
      kind: "score",
      levels: LEVELS,
      floor: 0,
      instructions: `${item.what}\nMeasured for this film: ${factsText(f)}`,
    };
  }
  return out;
}

function imageInputs(f: MeasuredFacts): ImageInput[] | undefined {
  const frames = f.frames.slice(0, MAX_IMAGES);
  if (frames.length === 0) return undefined;
  return frames.map((frame) => ({
    id: frame.label,
    mime: "image/png",
    bytes: new Uint8Array(readFileSync(frame.path)),
  }));
}

/** A score the judge split evenly between levels abstains as a tie; the strict reading is the lower tied level. */
function lowerOfTie(a: Answer): number | undefined {
  if (!a.abstained || a.reason !== "tie" || !a.probabilities) return undefined;
  const top = Math.max(...Object.values(a.probabilities));
  const levels = Object.entries(a.probabilities).filter(([, p]) => p === top).map(([level]) => Number(level));
  return levels.every(Number.isFinite) ? Math.min(...levels) : undefined;
}

export interface JudgeOptions {
  cache: DecideCache;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export async function judgeRound(
  planner: ResolvedPlanner,
  facts: MeasuredFacts,
  o: JudgeOptions,
): Promise<ScoreCard> {
  if (!planner.active) throw new JudgeUnavailable(`${planner.label} is not available${planner.refusal ? `: ${planner.refusal}` : ""}`);
  const vision = await seesImages(planner);
  const images = vision ? imageInputs(facts) : undefined;
  const state = {
    task: "Score a 15-second-scale SaaS product film against a written rubric. Be strict: a film that only scrolls is not an interaction film.",
    scale: "Each item is an integer from 0 (absent or broken) to 10 (at the reference bar).",
    frameNote: vision
      ? "The attached stills are single frames from this round's film, in the order listed."
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
  };
  const outcome = await askChunk(state, questions(facts), planner, o.cache, {
    timeoutMs: JUDGE_TIMEOUT_MS,
    keepAnswers: true,
    ...(images ? { images } : {}),
  });
  if (!outcome.answers) throw new JudgeUnavailable(outcome.failure ?? "the judge returned no answers");
  const scores: Partial<Record<RubricId, number>> = {};
  for (const item of RUBRIC) {
    if (item.id === "baseline" && facts.baseline === undefined) continue;
    const answer: Answer | undefined = outcome.answers[item.id];
    const tied = answer ? lowerOfTie(answer) : undefined;
    if (tied === undefined && (!answer || answer.abstained || answer.answer === null || answer.answer === undefined)) {
      throw new JudgeUnavailable(`${item.id}: ${answer?.reason ?? "no answer"}`);
    }
    const value = tied ?? (typeof answer!.answer === "number" ? answer!.answer : Number(answer!.answer));
    if (!Number.isFinite(value)) throw new JudgeUnavailable(`${item.id}: non-numeric answer`);
    scores[item.id] = value;
  }
  return scoreCard(scores, facts, planner.label, 1);
}
