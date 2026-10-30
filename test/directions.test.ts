// The direction model, the judge-refine polish loop and its builder, and the judge's feedback and gaps options. Every
// model answer here is a recorded reply served by a fake fetch: the Jev wire for the planner, the Anthropic Messages wire
// for the judge.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answer } from "@byokit/decide";
import { mapDirections, directionsRequest, directionSet } from "../src/directions/directions.ts";
import { runPolish, type Candidate, type Critique, type Feedback, type PolishHooks } from "../src/polish/loop.ts";
import { builderRequest, KNOBS, mapBuilder } from "../src/polish/builder.ts";
import { judgeRound, JudgeUnavailable } from "../src/score/judge.ts";
import { resolvePlanner, type ResolvedPlanner } from "../src/decide/planner.ts";
import { DEFAULTS } from "../src/camera/defaults.ts";
import type { MeasuredFacts } from "../src/score/rubric.ts";

const choice = (answer: string, extra: Partial<Answer> = {}): Answer => ({ answer, probabilities: { [answer]: 1 }, confidence: 1, abstained: false, ...extra } as unknown as Answer);

test("directions stay distinct: a repeated theme takes the next most probable one and a repeated pace and motion moves", () => {
  const answers: Record<string, Answer> = {
    theme_a: choice("aurora", { personReason: "bold colour suits a launch" }),
    pace_a: choice("quick"), motion_a: choice("follow"),
    theme_b: choice("aurora", { probabilities: { aurora: 0.6, paper: 0.3, mono: 0.1 } }),
    pace_b: choice("quick"), motion_b: choice("follow"),
    theme_c: { abstained: true, reason: "no answer" } as Answer,
    pace_c: choice("fast-ish"), motion_c: choice("close"),
  };
  const [a, b, c] = mapDirections(answers, 3);
  assert.equal(a!.theme, "aurora");
  assert.equal(a!.why, "bold colour suits a launch");
  assert.deepEqual(a!.by, { theme: "ai", pace: "ai", motion: "ai" });
  assert.equal(b!.theme, "paper", "the repeat takes the next most probable unused theme");
  assert.equal(b!.by.theme, "rule");
  assert.equal(b!.motion, "hold", "the same pace and motion moves to the first unused motion");
  assert.equal(b!.by.motion, "rule");
  assert.equal(c!.theme, "midnight", "an abstained theme falls to the fixed table");
  assert.equal(c!.pace, "brisk", "an unknown pace falls to the fixed table");
  assert.equal(new Set([a, b, c].map((d) => d!.theme)).size, 3);
  assert.deepEqual(c!.set, directionSet("brisk", "close"));
  assert.ok(c!.set.includes("camera_path=solver") && c!.set.includes("l1_pad=1.9"));
});

test("a planner that abstains on everything gets the fixed table, distinct on theme, pacing and motion; the request asks three questions per option", () => {
  const d = mapDirections({}, 3);
  assert.deepEqual(d.map((x) => [x.theme, x.pace, x.motion]), [["midnight", "quick", "follow"], ["paper", "calm", "hold"], ["aurora", "brisk", "close"]]);
  assert.ok(d.every((x) => x.by.theme === "rule" && x.by.pace === "rule" && x.by.motion === "rule"));
  const req = directionsRequest({ seconds: 20, device: "desktop browser", timeline: Array.from({ length: 50 }, (_, i) => `b${i}`) }, 2);
  assert.deepEqual(Object.keys(req.questions), ["theme_a", "pace_a", "motion_a", "theme_b", "pace_b", "motion_b"]);
  assert.equal((req.state.timeline as string[]).length, 41, "a long timeline is cut to its first and last 20 beats");
});

/** A scripted judge: one score per round, every feedback item kept unless a round is listed as missing it. */
function scripted(scores: number[], o: { missing?: number[]; addFeedbackDuring?: number; buildNullAt?: number; failAt?: number } = {}) {
  const feedback: Feedback[] = [];
  const builds: { round: number; seed: string | null; gaps: string[] }[] = [];
  const saved: string[] = [];
  const hooks: PolishHooks = {
    maxRounds: 5,
    build: async (round, seed, gaps) => {
      builds.push({ round, seed: seed?.film ?? null, gaps });
      if (round === o.buildNullAt) return null;
      return { film: `round-${round}.mp4`, set: [`pace=${round}`], meta: {}, changes: round ? [`change ${round}`] : [] } satisfies Candidate;
    },
    judge: async (_c, round, given) => {
      if (round === o.failAt) throw new JudgeUnavailable("recorded outage");
      if (round === o.addFeedbackDuring) feedback.push({ id: `f${feedback.length}`, at: "", text: "late note", source: "cli" });
      return {
        score: scores[round]!, items: [], gaps: [`gap ${round}`], directionKept: true, judge: "recorded",
        feedback: given.map((f) => ({ id: f.id, kept: !(o.missing ?? []).includes(round), reason: "checked" })),
      } satisfies Critique;
    },
    feedbackAt: () => [...feedback],
    save: (s) => saved.push(s.status),
  };
  return { hooks, feedback, builds, saved };
}

test("polish stops at 9/10: the first-draft run's scores 8.2, 8.7, 8.5, 8.6, 9", async () => {
  const s = scripted([8.2, 8.7, 8.5, 8.6, 9]);
  const state = await runPolish(s.hooks);
  assert.equal(state.stop_reason, "target_reached");
  assert.deepEqual(state.rounds.map((r) => r.score), [8.2, 8.7, 8.5, 8.6, 9]);
  assert.deepEqual(state.final, { round: 4, film: "round-4.mp4", score: 9 });
  assert.equal(s.builds[2]!.seed, "round-1.mp4");
  assert.equal(s.builds[3]!.seed, "round-2.mp4", "the seed is the latest accepted round, as in first-draft");
  assert.ok(s.builds[1]!.gaps.includes("gap 0"));
});

test("polish stops after two rounds without a better accepted score and ships the best one", async () => {
  const state = await runPolish(scripted([8, 8.4, 8.3, 8.2, 9.5]).hooks);
  assert.equal(state.stop_reason, "no_improvement_two_rounds");
  assert.equal(state.rounds.length, 4);
  assert.deepEqual(state.final, { round: 1, film: "round-1.mp4", score: 8.4 });
});

test("polish stops at the round cap and reports the best round below target", async () => {
  const s = scripted([7, 7.5, 8]);
  s.hooks.maxRounds = 2;
  const state = await runPolish(s.hooks);
  assert.equal(state.stop_reason, "round_cap");
  assert.equal(state.final!.score, 8);
  await assert.rejects(runPolish({ ...s.hooks, maxRounds: 6 }), /from 1 to 5/);
});

test("a round that misses the owner's feedback is rejected and the next builds on the last accepted one", async () => {
  const s = scripted([8, 9.2, 8.8, 9.1], { missing: [1] });
  s.feedback.push({ id: "f0", at: "", text: "hold the result longer", source: "cli" });
  const state = await runPolish(s.hooks);
  assert.equal(state.rounds[1]!.accepted, false);
  assert.equal(s.builds[2]!.seed, "round-0.mp4");
  assert.ok(s.builds[2]!.gaps.some((g) => g.startsWith("Owner feedback not met: hold the result longer")));
  assert.equal(state.stop_reason, "target_reached");
  assert.equal(state.final!.round, 3);
});

test("feedback that arrives while a round is judged keeps the run going even at 9/10", async () => {
  const s = scripted([9.3, 9.4], { addFeedbackDuring: 0 });
  const state = await runPolish(s.hooks);
  assert.equal(state.rounds[0]!.feedback_pending, true);
  assert.equal(state.rounds.length, 2);
  assert.equal(state.rounds[1]!.feedback.length, 1, "the next round is judged against the late note");
  assert.equal(state.stop_reason, "target_reached");
});

test("polish stops when no build input is left, and a judge failure records the round and fails the run", async () => {
  assert.equal((await runPolish(scripted([8, 8.5], { buildNullAt: 2 }).hooks)).stop_reason, "no_change_left");
  const failing = scripted([8, 8.5], { failAt: 1 });
  await assert.rejects(runPolish(failing.hooks), JudgeUnavailable);
  assert.equal(failing.saved.at(-1), "failed");
});

test("the builder maps its answers to bounded camera keys and keeps a knob it cannot move", () => {
  const camera = { ...DEFAULTS, stage_margin: 0.12, ripple_ms: 450, ripple_r: 90, motion_blur: 0 };
  const out = mapBuilder({
    pacing: choice("calm", { personReason: "the owner asked for longer holds" }),
    zoom: choice("closer"),
    clicks: choice("stronger"),
    blur: choice("none"),
    page: { abstained: true } as Answer,
    cursor: choice("enormous"),
  }, camera);
  assert.equal(out.change.pace, 1.4);
  assert.equal(out.change.idle_speed, 2);
  assert.ok(out.change.l2_pad! < camera.l2_pad);
  assert.equal(out.change.ripple_ms, 700);
  assert.equal(out.change.motion_blur, undefined, "no motion blur is already the default: no change");
  assert.equal(out.change.stage_margin, undefined);
  assert.equal(out.change.cursor_size, undefined);
  assert.match(out.changes[0]!, /^pacing: longer holds between moves \(pace .* -> pace 1.4.*\) - the owner asked for longer holds$/);
  assert.equal(KNOBS.some((k) => k.id === "theme" || k.id === "camera_path"), false, "the picked look is never a knob");
});

test("the builder sees the score against the target and every item under it, and can end the film sooner", () => {
  // The real proof run stopped at 8.4 when the builder, shown only the judge's prose, kept every knob.
  const { state, questions } = builderRequest({
    direction: { name: "Midnight", theme: "midnight" }, camera: DEFAULTS, feedback: [], gaps: ["Purposeful pacing (7/10): the closing shot holds about 3 seconds"],
    history: [], ruleChanges: [], target: 9, score: 8.4,
    items: [
      { label: "Real page size in frame", score: 9, note: "page covers at least 97% of the frame" },
      { label: "Purposeful pacing", score: 7, note: "41.1s across 10 beats; longest actionless span 3.3s" },
    ],
  });
  assert.equal(state.score, "8.4/10 against a target of 9/10");
  assert.deepEqual(state.items_below_target, ["Purposeful pacing: 7/10 - 41.1s across 10 beats; longest actionless span 3.3s"]);
  assert.match(String(state.task), /below the target, move the knobs that address its lowest items/);
  const ending = questions.ending!;
  assert.ok(ending.kind === "choice" && Object.hasOwn(ending.options, "shorter"));
  assert.deepEqual(mapBuilder({ ending: choice("shorter") }, { ...DEFAULTS, outro_s: 1.6 }).change, { outro_s: 1 });
  assert.deepEqual(mapBuilder({ ending: choice("shorter") }, { ...DEFAULTS, outro_s: 0.6 }).change, {}, "already at its shortest");
  assert.deepEqual(mapBuilder({ ending: choice("shorter") }, { ...DEFAULTS, outro_s: 0 }).change, {}, "no outro to shorten");
});

function facts(): MeasuredFacts {
  return {
    film: "f.mp4", duration: 12, frameCount: 360, pageShare: 0.98, stageMargin: 0, pointerSamples: 40, cursorFree: true,
    cursorDrawn: true, clickOverlay: true, clickCount: 2, zoomAtClick: 1.6, captionSize: 34, captions: 1, title: true,
    safeAreaFailures: 0, beats: 4, longestHold: 1.5, determinism: { frames: 360, identical: 360, tolerance: 0.995 }, frames: [],
  };
}

/**
 * A recorded reply for whatever a request asks, on the wire it came in: the Jev planner wire or the Anthropic
 * Messages wire the judge uses (with person reasons). Scores, yes/no feedback checks and choices come from a table.
 */
function recorded(table: { score?: number; yes?: number; choices?: Record<string, string> }): typeof fetch {
  const pickFor = (k: string, options: string[]) => table.choices?.[k]
    ?? (options.includes("keep") ? "keep" : k.startsWith("theme_") ? options[["a", "b", "c"].indexOf(k.slice(-1))]! : options[0]!);
  return (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as { tools?: { input_schema: { properties: Record<string, { properties: { probabilities: { required: string[] } } }> } }[]; questions?: Record<string, { type: string; criteria?: unknown }> };
    if (body.tools) {
      const input = Object.fromEntries(Object.entries(body.tools[0]!.input_schema.properties).map(([k, q]) => {
        const keys = q.properties.probabilities.required;
        const pick = keys.includes("true") ? ((table.yes ?? 1) > 0.5 ? "true" : "false") : keys.includes("10") ? String(table.score ?? 9) : pickFor(k, keys);
        const probabilities = Object.fromEntries(keys.map((key) => [key, key === pick ? 1 : 0]));
        if (keys.includes("true") && table.yes === 0.5) Object.assign(probabilities, { true: 0.5, false: 0.5 });
        return [k, { probabilities, pick, rationale: `recorded ${k}`, personReason: `recorded reason for ${k}` }];
      }));
      return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "decisions", input }], stop_reason: "tool_use", usage: { input_tokens: 900, output_tokens: 120 } }), { status: 200 });
    }
    const answers = Object.fromEntries(Object.entries(body.questions!).map(([k, q]) => {
      if (q.type === "score") return [k, { probabilities: Array.from({ length: 11 }, (_, i) => i === (table.score ?? 9) ? 1 : 0), confidence: 1 }];
      if (q.type === "noul") return [k, { noul: table.yes ?? 1 }];
      const options = Object.keys(q.criteria as object);
      const pick = pickFor(k, options);
      return [k, { choice: pick, probabilities: Object.fromEntries(options.map((o) => [o, o === pick ? 1 : 0])), confidence: 1 }];
    }));
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 900 } }), { status: 200 });
  }) as typeof fetch;
}

async function jevRoutes(dir: string): Promise<{ planner: ResolvedPlanner; judge: ResolvedPlanner }> {
  const planner = await resolvePlanner({ configDir: join(dir, "cfg"), apiKeyOverride: "test-key-000", env: { HOME: dir, PATH: "", TAKEONE_NO_KEYRING: "1" } });
  assert.equal(planner.active, true, planner.refusal ?? "");
  // The judge is another model on another wire, as the shipped default is (Haiku beside the planner).
  const judge = { ...planner, label: "recorded judge", config: { backend: "anthropic", auth: "apiKey", model: "claude-judge-recorded" } } as ResolvedPlanner;
  return { planner, judge };
}

test("the judge checks each piece of owner feedback in the same call and names the gaps under 9", async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-judge-"));
  try {
    const { judge } = await jevRoutes(dir);
    const cache = { get: async () => undefined, set: async () => undefined };
    const card = await judgeRound(judge, facts(), { cache, fetchImpl: recorded({ score: 8, yes: 0.9 }) }, {
      gaps: true, feedback: [{ id: "x", text: "make the click easier to see" }],
    });
    assert.equal(card.score, 8);
    assert.deepEqual(card.feedback.map((f) => [f.id, f.kept]), [["x", true]]);
    assert.equal(card.gaps.length, card.items.length, "every item under 9 is a gap");
    assert.match(card.gaps[0]!, /^Real page size in frame \(8\/10\): recorded reason for page$/);
    assert.equal(card.feedback[0]!.reason, "recorded reason for feedback_1");
    await assert.rejects(judgeRound(judge, facts(), { cache, fetchImpl: recorded({ score: 9, yes: 0.5 }) }, {
      feedback: [{ id: "x", text: "a split answer is not a yes" }],
    }), JudgeUnavailable);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
