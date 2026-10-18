import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPlan } from "../src/decide/plan.ts";

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
