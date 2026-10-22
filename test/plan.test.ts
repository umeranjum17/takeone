import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlan, readPlan, type Plan } from "../src/decide/plan.ts";
import { gateUnusable } from "../src/decide/planner.ts";
import type { Answer } from "@byokit/decide";

function planDir(json: string): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-"));
  mkdirSync(join(dir, "analysis"));
  writeFileSync(join(dir, "analysis/plan.json"), json);
  return dir;
}

/** A plan file as takeone writes it: every beat has its place and its key. */
function planFile(beats: { id: string; key?: string; shot?: unknown; idle?: unknown }[]): string {
  return JSON.stringify({
    version: 2,
    beats: beats.map((b) => ({
      id: b.id,
      key: b.key ?? `k-${b.id}`,
      ...("shot" in b ? { shot: b.shot } : {}),
      ...("idle" in b ? { idle: b.idle } : {}),
    })),
  });
}

test("readPlan accepts boolean choices", () => {
  const dir = planDir(planFile([{ id: "b1", shot: { value: false, by: "user" } }]));
  assert.equal(readPlan(dir)?.beats[0]?.shot?.value, false);
});

test("readPlan rejects a string value instead of treating it as true", () => {
  const dir = planDir(planFile([{ id: "b1", shot: { value: "false", by: "user" } }]));
  assert.throws(() => readPlan(dir), /b1\.shot\.value must be true or false/);
});

test("gateUnusable caches a beat whose optional camera answer abstained", () => {
  const store = new Map();
  const cache = gateUnusable({ get: (k) => store.get(k), set: (k, v) => void store.set(k, v) });
  const answers = {
    focus_start: { answer: "a", confidence: 1, abstained: false, by: "ai", ms: 0 },
    b1_shot: { answer: null, confidence: 0, abstained: true, by: "ai", ms: 0 },
  } as Record<string, Answer>;
  cache.set("key", answers);
  assert.deepEqual(cache.get("key"), answers);
});

test("gateUnusable refuses a beat whose required answer abstained", () => {
  const store = new Map();
  const cache = gateUnusable({ get: (k) => store.get(k), set: (k, v) => void store.set(k, v) });
  cache.set("key", { focus_start: { answer: null, confidence: 0, abstained: true, by: "ai", ms: 0 }, b1_shot: { answer: true, confidence: 1, abstained: false, by: "ai", ms: 0 } });
  assert.equal(cache.get("key"), undefined);
});

test("readPlan rejects a null camera choice with a clear error", () => {
  const dir = planDir(planFile([{ id: "b1", shot: null }]));
  assert.throws(() => readPlan(dir), /b1\.shot\.by must be ai, rule or user/);
});

test("readPlan rejects a beat id that appears twice", () => {
  const dir = planDir(planFile([{ id: "b1" }, { id: "b1", key: "k-other", shot: { value: true, by: "user" } }]));
  assert.throws(() => readPlan(dir), /beat id b1 appears more than once/);
});

test("readPlan names the file for malformed JSON and for a beat that is not an object", () => {
  assert.throws(() => readPlan(planDir("{ beats: [ }")), /analysis\/plan\.json: is not valid JSON/);
  assert.throws(() => readPlan(planDir(JSON.stringify({ version: 2, beats: [{ id: "b1", key: "k1" }, null] }))), /analysis\/plan\.json: every beat needs a string id/);
});

test("readPlan rejects beats that are not a list", () => {
  const dir = planDir(JSON.stringify({ version: 2, beats: {} }));
  assert.throws(() => readPlan(dir), /beats must be a list/);
});

test("readPlan rejects a beat without a key and an old plan version", () => {
  assert.throws(() => readPlan(planDir(JSON.stringify({ version: 2, beats: [{ id: "b1" }] }))), /b1 needs a key/);
  assert.throws(() => readPlan(planDir(JSON.stringify({ version: 1, beats: [{ id: "b1", key: "k1" }] }))),
    /plan version 1 is not supported/);
});

test("readPlan rejects a key that appears twice", () => {
  const dir = planDir(planFile([{ id: "b1", key: "k1" }, { id: "b2", key: "k1" }]));
  assert.throws(() => readPlan(dir), /beat key k1 appears more than once/);
});

test("applyPlan applies only user-set values, not the AI's stored ones", () => {
  const plan = { version: 2, beats: [{ id: "b1", key: "k1", shot: { value: true, by: "ai" }, idle: { value: false, by: "user" } }] } as Plan;
  assert.deepEqual(applyPlan([{ beat: "b1", shot: false, idle: true }], plan), [{ beat: "b1", shot: false, idle: false }]);
});

test("applyPlan rejects a user edit whose beat id matches no decision", () => {
  const plan = { version: 2, beats: [{ id: "B2", key: "k1", shot: { value: true, by: "user" } }] } as Plan;
  assert.throws(() => applyPlan([{ beat: "b1" }], plan), /user edit for B2 matches no beat/);
});
