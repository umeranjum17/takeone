import test from "node:test";
import assert from "node:assert/strict";
import { buildRequest, estimateTokens, planTokens, REQUEST_TOKEN_CAP } from "../src/decide/request.ts";
import { heuristicDecision } from "../src/decide/heuristics.ts";
import { mapAnswers, argmaxLevel, sumsTo1 } from "../src/decide/mapping.ts";
import { redactText } from "../src/decide/redact.ts";
import type { Action, Beat, Decision, JevAnswers, Zone } from "../src/types.ts";
import { STREAM } from "./helpers.ts";

function zone(name: string, kind: Zone["kind"], bbox: [number, number, number, number], shows = "the control the user clicked"): Zone {
  return {
    name,
    kind,
    bbox,
    area_frac: (bbox[2] * bbox[3]) / (STREAM.w * STREAM.h),
    desc: { shows, size: "small, a group of controls", where: "center", activity: "clicked once at the start of the beat" },
  };
}

function clickBeat(zones: Zone[]): Beat {
  return {
    id: "b1",
    t0: 500,
    t1: 2000,
    anchor_t: 500,
    window_cls: "chromium",
    actions: [{ k: "click", t: 500, x: 80, y: 60, window_cls: "chromium" }],
    zones,
    kind: "click",
  };
}

// ------------------------------------------------------------------ requests

test("buildRequest batches all questions; key_moment only with --about", () => {
  const zones = [zone("z1", "act", [60, 32, 80, 56]), zone("z2", "all", [0, 0, 160, 120])];
  const b = clickBeat(zones);
  const { body, tokens } = buildRequest(b, { currentShot: "Framing the entire screen." }, false);
  const req = JSON.parse(body);
  assert.equal(req.model, "jev-latest");
  assert.equal(req.state.beat.length, "1.5 seconds");
  assert.equal(req.state.current_shot, "Framing the entire screen.");
  assert.ok(req.questions["focus_start"]);
  assert.ok(req.questions["focus_end"]);
  assert.ok(req.questions["tightness"]);
  assert.ok(req.questions["new_subject"]);
  assert.ok(!req.questions["key_moment"]);
  // criteria are name-only (null values), descriptions live in state.zones
  for (const q of ["focus_start", "focus_end"] as const) {
    const crit = req.questions[q].criteria as Record<string, null>;
    assert.deepEqual(Object.keys(crit).sort(), ["z1", "z2"]);
    for (const v of Object.values(crit)) assert.equal(v, null);
  }
  assert.ok(tokens > 0);
  const withAbout = JSON.parse(buildRequest(b, { currentShot: "x", about: "Exporting a report" }, true).body);
  assert.equal(withAbout.state.demo_topic, "Exporting a report");
  assert.ok(withAbout.questions["key_moment"]);
});

test("request size is capped at 1,200 estimated tokens even with huge zone text", () => {
  const big = zone("z1", "act", [60, 32, 80, 56]);
  big.desc.text = "word ".repeat(500);
  const b = clickBeat([big, zone("z2", "all", [0, 0, 160, 120])]);
  const { tokens } = buildRequest(b, { currentShot: "x" }, true);
  assert.ok(tokens <= REQUEST_TOKEN_CAP, `tokens=${tokens}`);
});

test("oversize non-zone request fields are refused before POST", () => {
  const b = clickBeat([zone("z1", "all", [0, 0, 160, 120])]);
  assert.throws(() => buildRequest(b, { currentShot: "x", about: "topic".repeat(2000) }, true), /request exceeds/);
  b.actions = [{ k: "shortcut", t: 500, combo: "X".repeat(5000), window_cls: "chromium" }];
  assert.throws(() => buildRequest(b, { currentShot: "x" }, false), /request exceeds/);
});

test("estimateTokens is ceil(chars / 3.5)", () => {
  assert.equal(estimateTokens("a".repeat(35)), 10);
  assert.equal(estimateTokens("a".repeat(36)), 11);
});

test("planTokens sums per-beat estimates and prices at $0.042 per million", () => {
  const zones = [zone("z1", "act", [60, 32, 80, 56])];
  const b1 = clickBeat(zones);
  const b2 = clickBeat(zones);
  b2.id = "b2";
  const plan = planTokens([b1, b2], [{ currentShot: "x" }, { currentShot: "y" }], false);
  const one = buildRequest(b1, { currentShot: "x" }, false).tokens;
  assert.equal(plan.tokens, one * 2);
  assert.ok(Math.abs(plan.usd - (plan.tokens * 0.042) / 1e6) < 1e-12);
});

// ---------------------------------------------------------------- heuristics

test("heuristic policy per beat kind", () => {
  const zones = [
    zone("z1", "act", [60, 32, 80, 56]),
    zone("z2", "res", [0, 90, 100, 30], "a region that changed after the action"),
    zone("z3", "win", [0, 0, 100, 80], "the whole Chromium window"),
    zone("z4", "all", [0, 0, 160, 120]),
  ];
  const kindA: Array<[Action, string, string, number]> = [
    [{ k: "click", t: 500, x: 80, y: 60, window_cls: "chromium" }, "z1", "z2", 2],
    [{ k: "type", t0: 500, t1: 1500, window_cls: "chromium", region: [10, 10, 40, 20] }, "z1", "z2", 2],
  ];
  for (const [action, a, b, l] of kindA) {
    const beat = clickBeat(zones);
    beat.actions = [action];
    beat.kind = action.k;
    const d = heuristicDecision(beat, { viewport: null });
    assert.equal(d.A, a);
    assert.equal(d.B, action.k === "type" ? d.A : b);
    assert.equal(d.L, l);
    assert.equal(d.decided_by, "heuristic");
    assert.equal(d.K, 1);
  }
  // scroll: A = B = win, L = 1
  const scrollBeat = clickBeat(zones);
  scrollBeat.actions = [{ k: "scroll", t0: 500, t1: 900, x: 80, y: 60, dx: 0, dy: 3, detents: 3, window_cls: "chromium" }];
  scrollBeat.kind = "scroll";
  const dScroll = heuristicDecision(scrollBeat, { viewport: null });
  assert.equal(dScroll.A, "z3");
  assert.equal(dScroll.B, "z3");
  assert.equal(dScroll.L, 1);
  // idle over 3 s: L = 0
  const idleBeat = clickBeat(zones);
  idleBeat.actions = [];
  idleBeat.kind = "idle";
  idleBeat.t0 = 0;
  idleBeat.t1 = 4000;
  const dIdle = heuristicDecision(idleBeat, { viewport: null });
  assert.equal(dIdle.L, 0);
  assert.equal(dIdle.A, "z3");
});

// ------------------------------------------------------------------- mapping

const goodAnswers: JevAnswers = {
  focus_start: { choice: "z1", probabilities: { z1: 0.9, z2: 0.1 }, confidence: 0.8 },
  focus_end: { choice: "z2", probabilities: { z1: 0.1, z2: 0.9 }, confidence: 0.8 },
  tightness: { probabilities: [0.1, 0.1, 0.7, 0.1], confidence: 0.9 },
  new_subject: { p: 0.9 },
};

test("initial full-screen viewport holds a fitting first zone", () => {
  const beat = clickBeat([zone("z1", "act", [60, 32, 80, 56]), zone("z2", "all", [0, 0, 160, 120])]);
  assert.equal(heuristicDecision(beat, { viewport: null }).p, 0);
  assert.equal(heuristicDecision(beat, { viewport: { bbox: [0, 0, 40, 40] } }).p, 1);
});

test("typing keeps its text zone even with an attached result", () => {
  const beat = clickBeat([zone("z1", "txt", [10, 10, 40, 20]), zone("z2", "res", [100, 90, 40, 20])]);
  beat.kind = "type";
  beat.actions = [{ k: "type", t0: 500, t1: 1400, window_cls: "chromium", region: [10, 10, 40, 20] }];
  const d = heuristicDecision(beat, { viewport: null });
  assert.equal(d.A, "z1");
  assert.equal(d.B, "z1");
});

test("mapAnswers maps focus_start/end to A/B and tightness argmax to L", () => {
  const zones = [zone("z1", "act", [60, 32, 80, 56]), zone("z2", "res", [0, 90, 100, 30], "a region that changed after the action")];
  const beat = clickBeat(zones);
  const d = mapAnswers(beat, goodAnswers, { viewport: null, winRect: [0, 0, 100, 80], stream: STREAM });
  assert.ok(d);
  assert.equal(d.A, "z1");
  assert.equal(d.B, "z2");
  assert.equal(d.L, 2);
  assert.equal(d.p, 0.9);
  assert.equal(d.decided_by, "jev");
  assert.equal(d.K, 1);
});

test("B = A when B fits the frame chosen for A with 8% margin", () => {
  // res zone inside the L=2 frame of act -> collapses to A
  const zones = [zone("z1", "act", [40, 32, 80, 56]), zone("z2", "res", [50, 40, 40, 40])];
  const beat = clickBeat(zones);
  const d = mapAnswers(beat, goodAnswers, { viewport: null, winRect: null, stream: STREAM });
  assert.ok(d);
  assert.equal(d.B, "z1");
});

test("confidence < 0.5 widens A to the smallest zone containing the top two", () => {
  const zones = [
    zone("z1", "act", [60, 32, 80, 56]),
    zone("z2", "res", [0, 90, 100, 30], "a region that changed after the action"),
    zone("z3", "win", [0, 30, 142, 92], "the whole Chromium window"), // contains the union, under 70% of the screen
    zone("z4", "all", [0, 0, 160, 120]),
  ];
  const beat = clickBeat(zones);
  const low: JevAnswers = {
    ...goodAnswers,
    focus_start: { choice: "z1", probabilities: { z1: 0.4, z2: 0.35, z3: 0.25 }, confidence: 0.15 },
  };
  const d = mapAnswers(beat, low, { viewport: null, winRect: null, stream: STREAM });
  assert.ok(d);
  // union of z1+z2 = [0,32,160,88]; the smallest containing zone is z3 (win, 130x110), under 70% of screen
  assert.equal(d.A, "z3");

  // when the containing zone would cover over 70% of the screen, widen to all
  const tiny: JevAnswers = {
    ...low,
    focus_start: { choice: "z1", probabilities: { z1: 0.5, z2: 0.5 }, confidence: 0 },
  };
  const zonesNoWin = [zones[0]!, zones[1]!, zones[3]!];
  const d2 = mapAnswers(clickBeat(zonesNoWin), tiny, { viewport: null, winRect: null, stream: STREAM });
  assert.ok(d2);
  assert.equal(d2.A, "z4");
});

test("tightness widens one level when its confidence is low; K = 2 tightens", () => {
  const zones = [zone("z1", "act", [60, 32, 80, 56]), zone("z2", "res", [0, 90, 100, 30], "a region that changed after the action")];
  const beat = clickBeat(zones);
  const lowTight: JevAnswers = {
    ...goodAnswers,
    tightness: { probabilities: [0.1, 0.1, 0.7, 0.1], confidence: 0.2 },
  };
  const d = mapAnswers(beat, lowTight, { viewport: null, winRect: null, stream: STREAM });
  assert.ok(d);
  assert.equal(d.L, 1); // 2 - 1

  const key: JevAnswers = {
    ...goodAnswers,
    key_moment: { probabilities: [0.1, 0.1, 0.8], confidence: 0.9 },
  };
  const d2 = mapAnswers(beat, key, { viewport: null, winRect: null, stream: STREAM, about: "demo" });
  assert.ok(d2);
  assert.equal(d2.K, 2);
  assert.equal(d2.L, 3); // 2 + 1
});

test("malformed answers fall back: missing choices, bad probability sums, bad p", () => {
  const zones = [zone("z1", "act", [60, 32, 80, 56]), zone("z2", "res", [0, 90, 100, 30], "a region that changed after the action")];
  const beat = clickBeat(zones);
  const ctx = { viewport: null, winRect: null, stream: STREAM };
  assert.equal(mapAnswers(beat, { ...goodAnswers, focus_start: { choice: "z1" } }, ctx), null);
  assert.equal(
    mapAnswers(
      beat,
      { ...goodAnswers, focus_start: { choice: "z1", probabilities: { z1: 0.9, z2: 0.2 }, confidence: 0.9 } },
      ctx,
    ),
    null,
  );
  assert.equal(mapAnswers(beat, { ...goodAnswers, new_subject: {} }, ctx), null);
  assert.equal(mapAnswers(beat, { ...goodAnswers, tightness: {} }, ctx), null);
});

test("malformed probabilities and confidence refuse Jev mapping", () => {
  const beat = clickBeat([zone("z1", "act", [60, 32, 80, 56]), zone("z2", "all", [0, 0, 160, 120])]);
  const ctx = { viewport: null, winRect: null, stream: STREAM, about: "demo" };
  const valid = { ...goodAnswers, key_moment: { probabilities: [0.1, 0.8, 0.1], confidence: 0.8 } };
  const invalid: JevAnswers[] = [
    { ...valid, focus_start: { choice: "z1", probabilities: { z1: 1.2, z2: -0.2 } } },
    { ...valid, focus_end: { choice: "z2", probabilities: { z1: 0.5, bogus: 0.5 } } },
    { ...valid, focus_end: { choice: "z2", probabilities: { z1: 0.5, z2: 0.5 }, confidence: Infinity } },
    { ...valid, tightness: { probabilities: [0, 0, 0, 0, 1] } },
    { ...valid, tightness: { probabilities: [0, 0, NaN, 1] } },
    { ...valid, new_subject: { p: NaN } },
    { ...valid, key_moment: { probabilities: [0, 0, 0, 1] } },
  ];
  for (const answer of invalid) assert.equal(mapAnswers(beat, answer, ctx), null);
});

test("sumsTo1 and argmaxLevel helpers", () => {
  assert.ok(sumsTo1({ a: 0.6, b: 0.4 }));
  assert.ok(!sumsTo1({ a: 0.6, b: 0.5 }));
  assert.ok(!sumsTo1(undefined));
  assert.equal(argmaxLevel([0.1, 0.2, 0.7]), 2);
  assert.equal(argmaxLevel([0.7, 0.2, 0.1]), 0);
});

// ------------------------------------------------------------------ redaction

test("redactText masks emails, 6+ digit runs and 20+ char mixed alphanumerics", () => {
  assert.equal(redactText("mail me at bob@example.com now"), "mail me at [redacted] now");
  assert.equal(redactText("order 1234567890 shipped"), "order [redacted] shipped");
  assert.equal(redactText("id a1b2c3d4e5f6g7h8i9j0k1 done"), "id [redacted] done");
  assert.equal(redactText("keep short123 and normal words"), "keep short123 and normal words");
});

// ------------------------------------------------------------ decision record

test("decision record carries model and per-question confidence", () => {
  const zones = [zone("z1", "act", [60, 32, 80, 56]), zone("z2", "res", [0, 90, 100, 30], "a region that changed after the action")];
  const beat = clickBeat(zones);
  const d = mapAnswers(beat, goodAnswers, { viewport: null, winRect: null, stream: STREAM }) as Decision;
  assert.equal(d.model, "jev-latest");
  assert.equal(d.conf.A, 0.8);
  assert.equal(d.conf.B, 0.8);
  assert.equal(d.conf.L, 0.9);
});
