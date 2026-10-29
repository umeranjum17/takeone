import test from "node:test";
import assert from "node:assert/strict";
import { runScoreLoop, type BuildOutput, type LoopHooks } from "../src/score/loop.ts";
import { DETERMINISM_TOLERANCE, RUBRIC, scoreCard, type MeasuredFacts, type ScoreCard } from "../src/score/rubric.ts";
import { improveRound } from "../src/score/improve.ts";
import { DEFAULTS } from "../src/camera/defaults.ts";
import { planCamera } from "../src/render/render.ts";
import { clickShot } from "../src/score/measure.ts";
import type { TakeMeta } from "../src/camera/types.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("a dead opening the warp cannot squeeze is trimmed so the take starts just ahead of its first action", async () => {
  const dir = await mkdtemp(join(tmpdir(), "takeone-opening-"));
  try {
    // The shape of a real page take: a focus, a long rest while the pointer travels, then the click at 3.683 s.
    const beats = [
      { id: "b1", kind: "click", t0: 0, t1: 1.45, anchor_t: 0, zones: [], actions: [{ k: "focus", t: 0 }, { k: "dwell", t0: 0, t1: 1.45 }] },
      { id: "b2", kind: "click", t0: 2.767, t1: 3.7, anchor_t: 2.767, zones: [{ type: "res", bbox: [2400, 1200, 1600, 900], t_change: 3.7 }],
        actions: [{ k: "dwell", t0: 2.767, t1: 3.6 }, { k: "click", t: 3.683, x: 3188, y: 1385 }] },
    ];
    await mkdir(join(dir, "analysis"));
    await writeFile(join(dir, "analysis/beats.json"), JSON.stringify(beats));
    const meta = { id: "opening", width: 4800, height: 2700, duration: 4.2, stream: { w: 4800, h: 2700 } } as unknown as TakeMeta;
    const hold = facts(1, { longestHold: 3.683, longestHoldAt: 0, duration: 6 });
    const pacing = { ...card(9, 1), items: card(9, 1).items.map((i) => i.id === "pacing" ? { ...i, score: 3 } : { ...i, score: 10 }) };
    const limitations: string[] = [];
    const actions = await improveRound(pacing, hold, {
      dir, camera: { ...DEFAULTS }, meta, writeMeta: () => writeFileSync(join(dir, "take.json"), JSON.stringify(meta)), singlePass: () => true, solve: async () => [], limitations,
    });
    const lead = DEFAULTS.establish_s / 2 + DEFAULTS.anchor_early + DEFAULTS.move_t_max;
    assert.deepEqual(limitations, []);
    assert.match(actions[0] ?? "", /^trim the dead opening: start 0s -> [\d.]+s; longest actionless span 3\.68s -> [\d.]+s$/);
    const saved = JSON.parse(readFileSync(join(dir, "take.json"), "utf8")) as TakeMeta;
    assert.ok(Math.abs(saved.trim_start! - (3.683 - lead)) < 1e-6, `trim_start ${saved.trim_start}`);

    // A take that ends soon after its action keeps the 3 s the rubric asks of a film.
    const short = { id: "short", width: 4800, height: 2700, duration: 4.2, stream: { w: 4800, h: 2700 } } as unknown as TakeMeta;
    await improveRound(pacing, facts(1, { longestHold: 3.683, longestHoldAt: 0, duration: 3.9 }), {
      dir, camera: { ...DEFAULTS }, meta: short, writeMeta: () => {}, singlePass: () => true, solve: async () => [], limitations,
    });
    assert.equal(short.trim_start, 0.9);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A page take's saved analysis: an opening rest, then a click on `act` whose result appears in `res` at 3.7 s. */
async function clickTake(act: [number, number, number, number], res: [number, number, number, number]): Promise<{ dir: string; meta: TakeMeta }> {
  const dir = await mkdtemp(join(tmpdir(), "takeone-widen-"));
  const beats = [
    { id: "b1", kind: "idle", t0: 0, t1: 1.45, anchor_t: 0, zones: [{ name: "all", type: "all", bbox: [0, 0, 4800, 2700] }],
      actions: [{ k: "focus", t: 0 }, { k: "dwell", t0: 0, t1: 1.45 }] },
    { id: "b2", kind: "click", t0: 2.767, t1: 4.2, anchor_t: 2.767,
      zones: [{ name: "control", type: "act", bbox: act }, { name: "result", type: "res", bbox: res, t_change: 3.7 }],
      actions: [{ k: "dwell", t0: 2.767, t1: 3.6 }, { k: "click", t: 3.683, x: act[0] + act[2] / 2, y: act[1] + act[3] / 2 }] },
  ];
  const decisions = [
    { beat: "b1", A: "all", L: 0, p: 0, K: 1, conf: {}, decided_by: "ai" },
    { beat: "b2", A: "control", L: 2, p: 1, K: 1, conf: {}, decided_by: "ai" },
  ];
  await mkdir(join(dir, "analysis"));
  await writeFile(join(dir, "analysis/beats.json"), JSON.stringify(beats));
  await writeFile(join(dir, "analysis/decisions.jsonl"), decisions.map((d) => JSON.stringify(d)).join("\n") + "\n");
  const meta = { id: "widen", width: 4800, height: 2700, duration: 5.4, stream: { w: 4800, h: 2700 }, cursor_free: true } as unknown as TakeMeta;
  await writeFile(join(dir, "take.json"), JSON.stringify(meta));
  return { dir, meta };
}

function interactionCard(): ScoreCard {
  const base = card(9, 2);
  return { ...base, items: base.items.map((i) => ({ ...i, score: i.id === "interaction" ? 5 : i.id === "pacing" ? 6 : 10 })) };
}

test("a wider push-in that the solved camera path shows no differently is not spent; the next-best item's change is", async () => {
  // A small control: its padded push-in asks for more than the 2.5x a 4800 px source allows into 1920 px, so a third more
  // padding still solves to the same capped shot (the landing-page take spent a round on exactly this).
  const { dir, meta } = await clickTake([3100, 1340, 180, 90], [2400, 1600, 2000, 1000]);
  try {
    const camera = { ...DEFAULTS, stage_margin: 0 };
    const frames = (await planCamera(dir, camera, meta)).frames;
    const before = clickShot(dir, meta, camera, frames);
    assert.ok(before.resultInFrame !== undefined && before.resultInFrame < 0.5, `result ${before.resultInFrame}`);
    const limitations: string[] = [];
    const actions = await improveRound(interactionCard(), facts(2, { resultInFrame: before.resultInFrame, zoomAtClick: before.zoomAtClick, longestHold: 3.683, longestHoldAt: 0, duration: 6 }), {
      dir, camera, meta, writeMeta: () => writeFileSync(join(dir, "take.json"), JSON.stringify(meta)), singlePass: () => true, limitations,
      solve: async (c, m) => (await planCamera(dir, c, m)).frames,
    });
    assert.equal(camera.l2_pad, DEFAULTS.l2_pad, "the padding is left as it was");
    assert.match(limitations.join("\n"), /no change: shot padding 1\.8 -> 2\.4 leaves \d+% of the click's result in the last frame \(was \d+%; needs 5% more\)/);
    assert.equal(actions.length, 1, actions.join("; "));
    assert.match(actions[0]!, /^trim the dead opening/, "the round goes to the next-best item, pacing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a wider push-in that shows more of the click's result is kept, with the solved before and after", async () => {
  // A wide control under the upscale cap: a third more padding pulls the shot out over the result below it.
  const { dir, meta } = await clickTake([1800, 900, 1200, 500], [1600, 1500, 1800, 1000]);
  try {
    const camera = { ...DEFAULTS, stage_margin: 0 };
    const before = clickShot(dir, meta, camera, (await planCamera(dir, camera, meta)).frames);
    const limitations: string[] = [];
    const actions = await improveRound(interactionCard(), facts(2, { resultInFrame: before.resultInFrame, zoomAtClick: before.zoomAtClick }), {
      dir, camera, meta, writeMeta: () => {}, singlePass: () => true, limitations,
      solve: async (c, m) => (await planCamera(dir, c, m)).frames,
    });
    const widened = actions.find((a) => a.startsWith("widen the push-in"));
    assert.ok(widened, `${actions.join("; ")} | ${limitations.join("; ")}`);
    const [, from, to] = /result in the last frame (\d+)% -> (\d+)%$/.exec(widened)!;
    assert.ok(Number(to) - Number(from) >= 5, widened);
    assert.equal(camera.l2_pad, 2.4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a round with no change left that measurably changes the film stops with no gain", async () => {
  const lines: string[] = [];
  const result = await runScoreLoop({ ...hooks([6], { actions: () => [] }), log: (line) => lines.push(line) });
  assert.equal(result.stop, "no-improvement");
  assert.match(lines.join("\n"), /score: stop after round 1 - no gain left: no remaining build-input change measurably changes the film/);
});
