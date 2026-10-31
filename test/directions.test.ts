// Directions (A/B/C cuts of one take), the pick, and the judge-refine polish loop. Every model answer here is a
// recorded Jev-wire reply served by a fake fetch; the sign-off board is a fake binary that records its arguments.

import { CallBudget, CallBudgetExceeded } from "../src/decide/budget.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Answer } from "@byokit/decide";
import { mapDirections, directionsRequest, directionSet } from "../src/directions/directions.ts";
import { pickDirection, runDirections, type DirectionsFile } from "../src/directions/run.ts";
import { runPolish, type Candidate, type Critique, type Feedback, type PolishHooks } from "../src/polish/loop.ts";
import { latestRun, pickRound, polishFeedback, runPolishCommand } from "../src/polish/run.ts";
import { builderRequest, KNOBS, mapBuilder } from "../src/polish/builder.ts";
import { judgeRound as judgeWith, JudgeUnavailable, type JudgeOptions } from "../src/score/judge.ts";
import { resolvePlanner, type ResolvedPlanner } from "../src/decide/planner.ts";
import { cutPage } from "../src/board/page.ts";
import { litSpotlights, litWindow } from "../src/perceive/lit.ts";
import { cardNotes, freeKey } from "../src/board/board.ts";
import { resolveCamera } from "../src/cli.ts";
import { DEFAULTS } from "../src/camera/defaults.ts";
import type { MeasuredFacts } from "../src/score/rubric.ts";
import { hasFfmpeg } from "./helpers.ts";

/** A judge call with a take budget of its own, for the tests that judge one round and nothing else. */
const judgeRound = (...[planner, facts, o, extras]: [Parameters<typeof judgeWith>[0], Parameters<typeof judgeWith>[1], Omit<JudgeOptions, "budget">, Parameters<typeof judgeWith>[3]?]) =>
  judgeWith(planner, facts, { ...o, budget: new CallBudget() }, extras);

const needsFfmpeg = hasFfmpeg() ? undefined : "requires system ffmpeg and ffprobe on PATH";
const FAST = ["preset=veryfast", "out_w=320", "out_h=180", "fade_s=0"];

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

test("directions refuses --no-ai: every option is judged", () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-no-ai-"));
  try {
    writeFileSync(join(dir, "take.json"), "{}\n");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "src/cli.ts", "directions", dir, "--no-ai"], { encoding: "utf8" });
    assert.equal(result.status, 2, "directions --no-ai is a usage error");
    assert.match(result.stderr, /--no-ai is not offered: directions needs the planner and the independent judge/);
    assert.doesNotMatch(result.stdout + result.stderr, /--no-ai\]/, "the usage no longer lists --no-ai");
    assert.ok(!existsSync(join(dir, "directions")), "nothing was planned or rendered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("polish refuses --no-ai: every round is built and judged", () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-no-ai-"));
  try {
    writeFileSync(join(dir, "take.json"), "{}\n");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "src/cli.ts", "polish", dir, "--no-ai"], { encoding: "utf8" });
    assert.equal(result.status, 2, "polish --no-ai is a usage error");
    assert.match(result.stderr, /--no-ai is not offered: polish needs the planner and the independent judge/);
    assert.ok(!existsSync(join(dir, "polish")), "nothing was planned or rendered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("a card goes up under a key the board does not hold yet", () => {
  // The real proof board refused a re-captured take's first card: the archived card of the earlier take held its key.
  const root = mkdtempSync(join(tmpdir(), "takeone-board-key-"));
  try {
    const board = join(root, "decisions.json");
    writeFileSync(board, JSON.stringify({ schema: 2, items: [{ key: "takeone-t-directions-1" }, { key: "takeone-t-directions-1-2" }] }));
    assert.equal(freeKey(board, "takeone-t-directions-2"), "takeone-t-directions-2");
    assert.equal(freeKey(board, "takeone-t-directions-1"), "takeone-t-directions-1-3");
    writeFileSync(board, "{}");
    assert.equal(freeKey(board, "takeone-t-polish-1-r1"), "takeone-t-polish-1-r1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
      // The judge's scores run 0 to 10; the planner's own score questions (tightness, key moment) carry their levels.
      if (q.type === "score") {
        const levels = Array.isArray(q.criteria) ? q.criteria : undefined;
        const at = levels ? Math.min(1, levels.length - 1) : table.score ?? 9;
        return [k, { probabilities: Array.from({ length: levels?.length ?? 11 }, (_, i) => i === at ? 1 : 0), confidence: 1 }];
      }
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

test("the cut page plays the video in place and escapes every field", () => {
  const html = cutPage({
    badge: "B", badgeLabel: "Option B", title: "Paper <calm>", score: 8.7, target: 9, pill: "Recommended cut", status: ["Round 1 of 5"],
    items: [{ label: "Pacing", score: 8, note: "a & b" }], feedback: [{ text: "x", kept: false, reason: "not yet" }], changes: ["pace 1 -> 1.4"],
    cost: "1 judge call", video: "b.mp4", poster: "b.jpg",
  });
  assert.match(html, /<video class="video" controls playsinline preload="metadata" src="b.mp4" poster="b.jpg"/);
  assert.match(html, /Paper &lt;calm&gt;/);
  assert.match(html, /a &amp; b/);
  assert.match(html, /is-unmet/);
  assert.doesNotMatch(html, /https?:\/\//, "the page loads nothing from the network");
  assert.deepEqual(cardNotes({ answer: "a", note: " slower please ", rounds: [{ note: "" }, { note: "bigger cursor" }] }), ["slower please", "bigger cursor"]);
});

/** A 10 s synthetic take with two clicks and a scroll, as make.test.ts builds it. */
function buildTake(dir: string): string {
  execFileSync("ffmpeg", ["-nostdin", "-f", "lavfi", "-i", "color=c=gray:s=320x180:d=10:r=30", "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska", "-frames:v", "300", "-y", join(dir, "screen.webm")], { stdio: "ignore" });
  writeFileSync(join(dir, "frames.tsv"), Array.from({ length: 300 }, (_, i) => `${i * 3000}\t${i * 33333333}`).join("\n") + "\n");
  const events = [
    { t: 100, k: "win", cls: "chromium", title: "Quarterly report", rect: [0, 0, 320, 180] },
    { t: 400, k: "ptr", x: 200, y: 90 }, { t: 500, k: "btn", b: "left", down: true }, { t: 560, k: "btn", b: "left", down: false },
    { t: 2200, k: "wheel", dx: 0, dy: 1 }, { t: 2400, k: "wheel", dx: 0, dy: 1 },
    { t: 6400, k: "ptr", x: 80, y: 60 }, { t: 6500, k: "btn", b: "left", down: true }, { t: 6560, k: "btn", b: "left", down: false },
  ];
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(dir, "take.json"), JSON.stringify({ id: "t1", stream: { w: 320, h: 180 }, scale: 1, offset_ms: 0, pointer: "hyprland" }));
  return dir;
}

/** A fake sign-off CLI: records every call and answers `answers` from answers.json beside it. */
function fakeSignOff(root: string): { board: string; calls: () => string[][] } {
  const bin = join(root, "sign-off");
  const log = join(root, "sign-off.log");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\0' "$@" >> '${log}'; printf '\\n' >> '${log}'\nif [ "$1" = answers ]; then cat '${join(root, "answers.json")}' 2>/dev/null || echo '{}'; fi\n`);
  chmodSync(bin, 0o755);
  mkdirSync(join(root, ".sign-off"), { recursive: true });
  const board = join(root, ".sign-off", "decisions.json");
  writeFileSync(board, "{}");
  process.env.TAKEONE_SIGN_OFF = bin;
  return { board, calls: () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split("\0").filter(Boolean)) : [] };
}

test("directions render real cuts, post one board pick, and polish refines the picked cut with recorded answers", { skip: needsFfmpeg, timeout: 600_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "takeone-directions-"));
  const was = process.env.TAKEONE_SIGN_OFF;
  try {
    const dir = buildTake(mkdtempSync(join(root, "take-")));
    const sign = fakeSignOff(root);
    const { planner, judge } = await jevRoutes(root);
    const warnings: string[] = [];
    const quiet = { log: () => {}, warn: (l: string) => { warnings.push(l); } };
    const camera = (d: string, pairs: string[], theme?: string) => resolveCamera(d, pairs, theme, true);
    // Every request any phase sends passes here, to compare with the take's own count at the end.
    let sent = 0;
    const counted = (inner: typeof fetch): typeof fetch => (async (url: unknown, init?: unknown) => { sent++; return inner(url as string, init as RequestInit); }) as typeof fetch;
    const file: DirectionsFile = await runDirections({
      dir, count: 2, replan: false, set: FAST, board: sign.board, planner, judge, configDir: join(root, "cfg"),
      fetchImpl: counted(recorded({ score: 8 })), resolveCamera: camera, ...quiet,
    });
    assert.equal(file.directions.length, 2);
    assert.deepEqual(file.directions.map((d) => d.by.theme), ["ai", "ai"], warnings.join("\n"));
    assert.notEqual(file.directions[0]!.theme, file.directions[1]!.theme);
    for (const d of file.directions) {
      assert.ok(existsSync(join(dir, d.film)), `${d.id} is a real rendered cut`);
      assert.ok(d.score !== null && d.score <= 8, "the judge's 8s, under the measured caps");
      assert.equal(d.items.length, 5, "no baseline item: every direction is judged on its own");
      assert.ok(existsSync(join(root, ".sign-off", "mocks", file.board!.key, `${d.id}.mp4`)));
      assert.match(readFileSync(join(root, ".sign-off", "mocks", file.board!.key, `${d.id}.html`), "utf8"), new RegExp(`src="${d.id}.mp4"`));
    }
    assert.equal(file.calls.judge, 2);
    assert.ok(file.determinism.frames > 0 && file.determinism.identical === file.determinism.frames);
    const post = sign.calls().find((c) => c[0] === "post")!;
    assert.deepEqual(post.slice(0, 6), ["post", sign.board, "--type", "design", "--key", "takeone-t1-directions-1"]);

    // The owner picks B on the board with a note; pick reads it, and polish takes the note as feedback.
    writeFileSync(join(root, "answers.json"), JSON.stringify({ "takeone-t1-directions-1": { answer: "b", note: "hold the result a bit longer" } }));
    const picked = pickDirection(dir, undefined, quiet.log);
    assert.equal(picked.picked.id, "b");
    assert.equal(picked.from, "board");
    assert.equal(picked.note, "hold the result a bit longer");
    assert.equal(JSON.parse(readFileSync(join(dir, "take.json"), "utf8")).direction.theme, file.directions[1]!.theme);
    assert.ok(readFileSync(join(dir, "out", "t1.mp4")).equals(readFileSync(join(dir, file.directions[1]!.film))), "out/ is the picked cut");

    const result = await runPolishCommand({
      dir, maxRounds: 2, feedback: [], set: FAST, board: sign.board, judge, builder: planner,
      configDir: join(root, "cfg"), fetchImpl: counted(recorded({ score: 8, yes: 1, choices: { opening: "longer", ending: "longer" } })),
      resolveCamera: camera, ...quiet,
    });
    const { state } = result;
    assert.equal(state.rounds[0]!.feedback[0]!.text, "hold the result a bit longer");
    assert.equal(state.rounds[0]!.feedback[0]!.source, "board");
    assert.ok(state.rounds[1]!.changes.some((c) => c.startsWith("opening:")), state.rounds[1]!.changes.join("; "));
    assert.ok(state.rounds[1]!.set.some((p) => p.startsWith("establish_s=")));
    assert.equal(state.rounds[0]!.critique!.directionKept, true);
    assert.ok(["no_improvement_two_rounds", "round_cap"].includes(state.stop_reason!), String(state.stop_reason));
    assert.ok(existsSync(join(result.runDir, "round-1.mp4")));
    assert.equal(latestRun(dir), result.runDir);
    assert.throws(() => polishFeedback(dir, "too late"), /stopped/);
    const meta = JSON.parse(readFileSync(join(dir, "take.json"), "utf8"));
    assert.equal(meta.direction.polished.round, state.final!.round);
    const posts = sign.calls().filter((c) => c[0] === "post").map((c) => c[c.indexOf("--key") + 1]);
    assert.deepEqual(posts.slice(1), ["takeone-t1-polish-1-r1", "takeone-t1-polish-1-r2"].slice(0, state.rounds.length - 1));
    if (state.rounds.length > 2) assert.ok(sign.calls().some((c) => c[0] === "dismiss" && c[1] === "takeone-t1-polish-1-r1"));

    // The owner answers R0 on the last round card: pick with no letter ships that round instead of the loop's choice.
    const lastCard = posts.at(-1)!;
    writeFileSync(join(root, "answers.json"), JSON.stringify({ "takeone-t1-directions-1": { answer: "b" }, [lastCard]: { answer: "r0" } }));
    assert.deepEqual(pickRound(dir, undefined, quiet.log), { round: 0, from: "board" });
    assert.equal(JSON.parse(readFileSync(join(dir, "take.json"), "utf8")).direction.polished.round, 0);
    assert.ok(readFileSync(join(dir, "out", "t1.mp4")).equals(readFileSync(join(result.runDir, "round-0.mp4"))), "out/ is round 0's film");
    assert.throws(() => pickRound(dir, 9, quiet.log), /no judged round 9/);

    // A second run with no --board uses the board the directions went to, and when the judge fails on refinement 1 it
    // still ships round 0, the best accepted round, instead of the unjudged render left in out/.
    writeFileSync(join(root, "answers.json"), "{}");
    const judgeDown = recorded({ score: 7, yes: 1, choices: { cursor: "larger" } });
    const failing = (async (url: unknown, init?: { body?: unknown }) => /refinement 1 of/.test(String(init?.body)) && /"tools"/.test(String(init?.body))
      ? new Response("overloaded", { status: 529 }) : judgeDown(url as string, init as RequestInit)) as typeof fetch;
    await assert.rejects(runPolishCommand({
      dir, maxRounds: 2, feedback: ["keep the cursor easy to follow"], set: [], judge, builder: planner,
      configDir: join(root, "cfg"), fetchImpl: counted(failing), resolveCamera: camera, ...quiet,
    }), JudgeUnavailable);
    const second = latestRun(dir)!;
    const run2 = JSON.parse(readFileSync(join(second, "run.json"), "utf8"));
    assert.equal(run2.status, "failed");
    assert.equal(run2.final.round, 0);
    assert.equal(run2.board.file, sign.board);
    assert.ok(readFileSync(join(dir, "out", "t1.mp4")).equals(readFileSync(join(second, "round-0.mp4"))), "the failed run ships its round 0, not the unjudged round 1");
    assert.equal(JSON.parse(readFileSync(join(dir, "take.json"), "utf8")).direction.polished.run, second.split("/").at(-1));
    assert.ok(existsSync(join(second, "round-1.mp4")), "round 1 was rendered before the judge failed");
    assert.throws(() => polishFeedback(dir, "x"), /stopped/);

    // Directions (with the take's planning), the first polish and the failed second polish are three commands; the take's
    // one count holds every request any of them sent, planner, builder and judge alike.
    const calls = JSON.parse(readFileSync(join(dir, "take.json"), "utf8")).calls as { used: number; by_workflow: Record<string, number> };
    assert.equal(calls.used, sent, "the take's count is every request sent across all phases");
    for (const workflow of ["film planner", "directions planner", "polish builder", "judge"]) assert.ok((calls.by_workflow[workflow] ?? 0) > 0, `${workflow} is in the count`);
  } finally {
    if (was === undefined) delete process.env.TAKEONE_SIGN_OFF;
    else process.env.TAKEONE_SIGN_OFF = was;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a take that runs past its model-call cap stops there, naming the workflow and the count, and take.json keeps the count", { skip: needsFfmpeg, timeout: 600_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "takeone-budget-"));
  try {
    const dir = buildTake(mkdtempSync(join(root, "take-")));
    const { planner, judge } = await jevRoutes(root);
    const answers = recorded({ score: 8 });
    // The first request is rate-limited and retried: a retry is a request, so it is a unit of the budget like any other.
    let sent = 0;
    const fetchImpl = (async (url: unknown, init?: unknown) => {
      sent++;
      return sent === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "0" } }) : answers(url as string, init as RequestInit);
    }) as typeof fetch;
    const cap = 4;
    const budget = new CallBudget(dir, cap);
    // The take is planned first (its film and beat calls), then directions asks once and the judge scores each cut.
    await assert.rejects(runDirections({
      dir, count: 3, replan: false, set: FAST, planner, judge, configDir: join(root, "cfg"), budget, fetchImpl,
      resolveCamera: (d, pairs, theme) => resolveCamera(d, pairs, theme, true), log: () => {}, warn: () => {},
    }), (e: unknown) => {
      assert.ok(e instanceof CallBudgetExceeded);
      assert.match(e.message, new RegExp(`^the (film planner|beat planner|directions planner|judge) workflow hit the cap of ${cap} model calls per take after ${cap} calls`));
      return true;
    });
    assert.equal(sent, cap, "the request past the cap was never sent");
    assert.equal(budget.used, cap);
    const calls = JSON.parse(readFileSync(join(dir, "take.json"), "utf8")).calls as { cap: number; used: number; by_workflow: Record<string, number> };
    assert.deepEqual([calls.cap, calls.used], [cap, cap]);
    assert.equal(Object.values(calls.by_workflow).reduce((n, v) => n + v, 0), cap, "the workflows add up to the count");
    assert.equal(calls.by_workflow["film planner"], 2, "the rate-limited film request and its retry are two requests");
    assert.ok(!existsSync(join(dir, "directions", "directions.json")), "the run stopped before it wrote directions");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the budget does not reset between phases of one take: make, directions and the judge draw down one count across commands", { skip: needsFfmpeg, timeout: 600_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "takeone-budget-phases-"));
  try {
    const dir = buildTake(mkdtempSync(join(root, "take-")));
    const { planner, judge } = await jevRoutes(root);
    const answers = recorded({ score: 8 });
    let sent = 0;
    const fetchImpl = (async (url: unknown, init?: unknown) => { sent++; return answers(url as string, init as RequestInit); }) as typeof fetch;
    const spent = () => (JSON.parse(readFileSync(join(dir, "take.json"), "utf8")) as { calls: { used: number; by_workflow: Record<string, number> } }).calls;
    // One command plans the take (make), asks for the directions and judges each cut: three phases, one count.
    await runDirections({
      dir, count: 2, replan: false, set: FAST, planner, judge, configDir: join(root, "cfg"), fetchImpl,
      resolveCamera: (d, pairs, theme) => resolveCamera(d, pairs, theme, true), log: () => {}, warn: () => {},
    });
    const first = spent();
    assert.equal(first.used, sent, "every request that was sent is in the count, and nothing else");
    assert.deepEqual(Object.keys(first.by_workflow).sort(), ["beat planner", "directions planner", "film planner", "judge"]);

    // A later command opens the same take's budget: it carries on from the count, with a cap one call above it.
    const cap = first.used + 1;
    const later = new CallBudget(dir, cap);
    assert.equal(later.used, first.used, "the budget is the take's, not the command's");
    const cache = { get: async () => undefined, set: async () => undefined };
    await judgeWith(judge, facts(), { cache, budget: later, fetchImpl }, {});
    assert.equal(spent().used, cap);
    assert.equal(spent().by_workflow.judge, first.by_workflow.judge! + 1);
    // A budget that reset between phases would still have room here; this one has none.
    await assert.rejects(judgeWith(judge, facts(), { cache, budget: later, fetchImpl }, {}),
      (e: unknown) => e instanceof CallBudgetExceeded && e.message.startsWith(`the judge workflow hit the cap of ${cap} model calls per take after ${cap} calls`));
    assert.equal(sent, cap, "the refused request was never sent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directions stops with the AI-engine message when no engine can serve, through the shipped CLI in an isolated home", { skip: needsFfmpeg, timeout: 120_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "takeone-directions-noengine-"));
  try {
    const dir = buildTake(mkdtempSync(join(root, "take-")));
    // No HOME with a sign-in, no engine on PATH, no OS keyring, an empty sealed store: nothing can answer, on any machine.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of ["TYPESAFE_API_KEY", "TAKEONE_NO_KEYRING", "TAKEONE_SECRETS_PASSPHRASE_FD", "TAKEONE_TEST_NO_KEYRING",
      "TAKEONE_TEST_KEYRING_FAILURE", "TAKEONE_TEST_KEYRING_KEY"]) delete env[name];
    Object.assign(env, {
      HOME: root, XDG_CONFIG_HOME: join(root, ".config"), PATH: "", TAKEONE_NO_KEYRING: "1", TAKEONE_SECRETS_PASSPHRASE_FD: "3",
      TAKEONE_DIR: join(root, "takes"), TAKEONE_STATE_DIR: join(root, "state"),
    });
    const passphrase = join(root, "passphrase");
    writeFileSync(passphrase, "test-passphrase");
    const fd = openSync(passphrase, "r"); // array index 3 becomes the child's fd 3
    let r;
    try {
      r = spawnSync(process.execPath, [resolve("bin/takeone.mjs"), "directions", dir, "--count", "2"],
        { encoding: "utf8", env, timeout: 100_000, stdio: ["ignore", "pipe", "pipe", fd] });
    } finally {
      closeSync(fd);
    }
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /needs an AI engine/);
    assert.equal(existsSync(join(dir, "analysis", "beats.json")), false, "nothing was planned or rendered");
    assert.equal(existsSync(join(dir, "directions")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a spotlight window starts when its region has content and is dropped when it never does", { skip: needsFfmpeg, timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-lit-"));
  try {
    const webm = join(dir, "s.webm");
    // 2 s of a flat white region (a menu not yet open), then 2 s of content: the window starts where the region first differs.
    execFileSync("ffmpeg", ["-nostdin", "-y", "-filter_complex", "color=c=white:s=320x180:d=2:r=30[a];testsrc2=s=320x180:d=2:r=30[b];[a][b]concat[v]",
      "-map", "[v]", "-c:v", "libvpx", "-b:v", "1M", webm], { stdio: "ignore" });
    const lit = await litWindow(webm, [0, 0, 320, 180], 0, 4);
    assert.ok(lit && Math.abs(lit.t - 2) <= 0.25 && lit.d >= 1.5, JSON.stringify(lit));
    assert.equal(await litWindow(webm, [0, 0, 320, 180], 0, 1.8), null, "a region that stays flat is never lit");
    // A take planned before the measure kept its planned window: render measures it and keeps a measured one as it is.
    const rect: [number, number, number, number] = [0, 0, 320, 180];
    const kept = await litSpotlights(webm, [{ t: 0, d: 2, rect }, { t: 2.5, d: 1, rect, lit: true }]);
    assert.equal(kept.length, 2);
    assert.ok(Math.abs(kept[0]!.t - 2) <= 0.25 && kept[0]!.lit === true, "the planned window moved to when the region changes");
    assert.deepEqual(kept[1], { t: 2.5, d: 1, rect, lit: true }, "a measured window is left as it is");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
