import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlan, readPlan, type Plan } from "../src/decide/plan.ts";
import { gateUnusable } from "../src/decide/planner.ts";

function planDir(json: string): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-"));
  mkdirSync(join(dir, "analysis"));
  writeFileSync(join(dir, "analysis/plan.json"), json);
  return dir;
}

test("readPlan accepts boolean choices", () => {
  const dir = planDir(JSON.stringify({ version: 1, beats: [{ id: "b1", shot: { value: false, by: "user" } }] }));
  assert.equal(readPlan(dir)?.beats[0]?.shot?.value, false);
});

test("readPlan rejects a string value instead of treating it as true", () => {
  const dir = planDir(JSON.stringify({ version: 1, beats: [{ id: "b1", shot: { value: "false", by: "user" } }] }));
  assert.throws(() => readPlan(dir), /b1\.shot\.value must be true or false/);
});

test("gateUnusable caches a beat whose optional camera answer abstained", () => {
  const store = new Map();
  const cache = gateUnusable({ get: (k) => store.get(k), set: (k, v) => void store.set(k, v) });
  const answers = {
    focus_start: { answer: "a", confidence: 1, abstained: false },
    b1_shot: { answer: null, confidence: 0, abstained: true },
  };
  cache.set("key", answers);
  assert.deepEqual(cache.get("key"), answers);
});

test("gateUnusable refuses a beat whose required answer abstained", () => {
  const store = new Map();
  const cache = gateUnusable({ get: (k) => store.get(k), set: (k, v) => void store.set(k, v) });
  cache.set("key", { focus_start: { answer: null, confidence: 0, abstained: true }, b1_shot: { answer: true, confidence: 1, abstained: false } });
  assert.equal(cache.get("key"), undefined);
});

test("readPlan rejects a null camera choice with a clear error", () => {
  const dir = planDir(JSON.stringify({ version: 1, beats: [{ id: "b1", shot: null }] }));
  assert.throws(() => readPlan(dir), /b1\.shot\.by must be ai, rule or user/);
});

test("readPlan rejects a beat id that appears twice", () => {
  const dir = planDir(JSON.stringify({ version: 1, beats: [{ id: "b1" }, { id: "b1", shot: { value: true, by: "user" } }] }));
  assert.throws(() => readPlan(dir), /beat id b1 appears more than once/);
});

test("readPlan rejects beats that are not a list", () => {
  const dir = planDir(JSON.stringify({ version: 1, beats: {} }));
  assert.throws(() => readPlan(dir), /beats must be a list/);
});

test("applyPlan applies only user-set values, not the AI's stored ones", () => {
  const plan = { version: 1, beats: [{ id: "b1", shot: { value: true, by: "ai" }, idle: { value: false, by: "user" } }] } as Plan;
  assert.deepEqual(applyPlan([{ beat: "b1", shot: false, idle: true }], plan), [{ beat: "b1", shot: false, idle: false }]);
});

test("applyPlan rejects a user edit whose beat id matches no decision", () => {
  const plan = { version: 1, beats: [{ id: "B2", shot: { value: true, by: "user" } }] } as Plan;
  assert.throws(() => applyPlan([{ beat: "b1" }], plan), /user edit for B2 matches no beat/);
});
