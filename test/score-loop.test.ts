import test from "node:test";
import assert from "node:assert/strict";
import { runScoreLoop, type BuildOutput, type LoopHooks } from "../src/score/loop.ts";
import { DETERMINISM_TOLERANCE, RUBRIC, scoreCard, type MeasuredFacts, type ScoreCard } from "../src/score/rubric.ts";

function facts(round: number, overrides: Partial<MeasuredFacts> = {}): MeasuredFacts {
  return {
    film: `/tmp/round-${round}.mp4`,
    duration: 7,
    frameCount: 420,
    pageShare: 0.98,
    stageMargin: 0.005,
    pointerSamples: 420,
    cursorFree: true,
    cursorDrawn: true,
    clickOverlay: true,
    clickCount: 1,
    zoomAtClick: 2,
    captionSize: 38,
    captions: 0,
    title: false,
    safeAreaFailures: 0,
    beats: 2,
    longestHold: 1.5,
    determinism: { frames: 420, identical: 420, tolerance: DETERMINISM_TOLERANCE },
    frames: [],
    ...(round === 1 ? {} : { baseline: { round: 1, score: 6, pageShare: 0.85, cursorDrawn: false, clickOverlay: true, zoomAtClick: 1 } }),
    ...overrides,
  };
}

function card(score: number, round: number): ScoreCard {
  return {
    score,
    model: "fake judge",
    calls: 1,
    items: RUBRIC.filter((item) => item.id !== "baseline" || round > 1).map((item) => ({
      id: item.id, label: item.label, weight: item.weight, score, max: 10, note: "fake",
    })),
  };
}

function hooks(scores: number[], o: { target?: number; maxRounds?: number; actions?: (round: number) => string[]; throwAt?: number } = {}): LoopHooks {
  let round = 0;
  return {
    target: o.target ?? 9,
    maxRounds: o.maxRounds ?? 4,
    async build(): Promise<BuildOutput> {
      round++;
      return { film: `/tmp/round-${round}.mp4`, determinism: { frames: 420, identical: 420, tolerance: DETERMINISM_TOLERANCE } };
    },
    async measure(film, r) { return facts(r, { film }); },
    async judge(measured) {
      if (o.throwAt === round) throw new Error("provider refused");
      const score = scores[round - 1];
      if (score === undefined) throw new Error(`no fake score for round ${round}`);
      return card(score, round);
    },
    async improve() { return (o.actions ?? (() => ["tune"]))(round); },
  };
}

test("stops when the target is reached and reports the best round", async () => {
  const result = await runScoreLoop(hooks([6.2, 9.4]));
  assert.equal(result.stop, "target");
  assert.equal(result.reached, true);
  assert.equal(result.belowTarget, false);
  assert.equal(result.rounds.length, 2);
  assert.equal(result.best?.round, 2);
  assert.equal(result.calls, 2);
  assert.deepEqual(result.rounds[1]?.actions, []);
});

test("stops when a round gains less than the epsilon", async () => {
  const result = await runScoreLoop(hooks([8.8, 8.9]));
  assert.equal(result.stop, "no-gain");
  assert.equal(result.belowTarget, true);
  assert.equal(result.rounds.length, 2);
  assert.match(result.remaining.join(" "), /Real page size in frame: 8\.9\/10/);
});

test("stops at the max-rounds cap and flags below target", async () => {
  const result = await runScoreLoop(hooks([6, 6.6], { target: 10, maxRounds: 2 }));
  assert.equal(result.stop, "max-rounds");
  assert.equal(result.reached, false);
  assert.equal(result.belowTarget, true);
  assert.equal(result.rounds.length, 2);
});

test("stops when the improve step has no capability left to change", async () => {
  const result = await runScoreLoop(hooks([6], { actions: () => [] }));
  assert.equal(result.stop, "no-improvement");
  assert.equal(result.rounds.length, 1);
  assert.equal(result.belowTarget, true);
});

test("a failing judge stops the loop honestly without inventing a score", async () => {
  const result = await runScoreLoop(hooks([6, 7], { throwAt: 1 }));
  assert.equal(result.stop, "judge-unavailable");
  assert.equal(result.best, null);
  assert.equal(result.belowTarget, true);
  assert.match(result.judgeError ?? "", /provider refused/);
  assert.equal(result.rounds.length, 0);
});

test("measured caps limit an over-generous judge", () => {
  const f = facts(1, {
    pageShare: 0.857,
    pointerSamples: 0,
    cursorDrawn: false,
    clickOverlay: false,
    zoomAtClick: 0,
    determinism: { frames: 100, identical: 90, tolerance: DETERMINISM_TOLERANCE },
  });
  const card = scoreCard({
    page: 10, interaction: 10, legibility: 10, pacing: 10, determinism: 10,
  }, f, "fake judge", 1);
  const byId = Object.fromEntries(card.items.map((item) => [item.id, item.score]));
  assert.equal(byId.page, 6);
  assert.equal(byId.interaction, 2);
  assert.equal(byId.determinism, 3);
  assert.ok(card.score < 7);
  assert.match(card.items.find((item) => item.id === "interaction")!.note, /no pointer track/);
});
