import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";

const root = mkdtempSync(resolve(tmpdir(), "check-framing-"));
const script = resolve(process.cwd(), "scripts/check-framing.ts");
after(() => rmSync(root, { recursive: true, force: true }));

function run(beat: object, start: string) {
  const beats = resolve(root, "beats.json");
  const before = resolve(root, "before.json");
  const after = resolve(root, "after.json");
  const frames = [0, 0.05, 0.1].map(t => ({ t, x: 0, y: 0, w: 100, h: 100 }));
  writeFileSync(beats, JSON.stringify([beat]));
  writeFileSync(before, JSON.stringify(frames));
  writeFileSync(after, JSON.stringify(frames));
  return spawnSync(process.execPath, [script, beats, start, before, after], { encoding: "utf8" });
}

test("framing CLI aligns trim-relative frames to output-clock beats", () => {
  const result = run({ id: "trimmed", t0: 16, t1: 16.1, kind: "type", zones: [], actions: [] }, "16");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /trimmed \| 3 \| 0 \| 0 \| 0 \| 0 \| 0 \| PASS/);
});

test("framing CLI rejects a beat with no corresponding frames", () => {
  const result = run({ id: "empty", t0: 20, t1: 21, kind: "type", zones: [], actions: [] }, "16");
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stdout, /empty \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| FAIL/);
});
