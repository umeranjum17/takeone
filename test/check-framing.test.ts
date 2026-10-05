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

function run(beat: object, start: string, references?: object[]) {
  const beats = resolve(root, "beats.json");
  const before = resolve(root, "before.json");
  const after = resolve(root, "after.json");
  const frames = [0, 0.05, 0.1].map(t => ({ t, x: 0, y: 0, w: 100, h: 100 }));
  writeFileSync(beats, JSON.stringify([beat]));
  writeFileSync(before, JSON.stringify(frames));
  writeFileSync(after, JSON.stringify(frames));
  if (!references) return spawnSync(process.execPath, [script, beats, start, before, after], { encoding: "utf8" });
  const boxFile = resolve(root, "references.json");
  writeFileSync(boxFile, JSON.stringify(references));
  return spawnSync(process.execPath, [script, beats, start, before, after, boxFile, "0"], { encoding: "utf8" });
}

test("framing CLI aligns trim-relative frames to output-clock beats", () => {
  const result = run({ id: "trimmed", t0: 16, t1: 16.1, kind: "type", zones: [], actions: [] }, "16");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /trimmed \| 3 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| PASS/);
  const drag = { k: "drag", t0: 16000, t1: 16100, from: [20, 20], to: [20, 20], bbox: [20, 20, 0, 0] };
  for (const footprint of [{}, { subject: [15, 15, 10, 10] }, { whole_object: [10, 10, 20, 20] }]) {
    const checked = run({ id: "drag", t0: 16, t1: 16.1, kind: "drag", zones: [],
      actions: [{ ...drag, ...footprint }] }, "16");
    assert.equal(checked.status, "whole_object" in footprint ? 0 : 1, checked.stderr + checked.stdout);
  }
});

test("framing CLI rejects a beat with no corresponding frames", () => {
  const result = run({ id: "empty", t0: 20, t1: 21, kind: "type", zones: [], actions: [] }, "16");
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stdout, /empty \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| FAIL/);
});

test("framing CLI checks a held gesture beyond its shortened owner", () => {
  for (const to of [[20, 20], [200, 20]]) {
    const result = run({ id: "held", t0: 15, t1: 15.5, kind: "drag", zones: [], actions: [{
      k: "drag", t0: 15000, t1: 16100, from: [20, 20], to,
      bbox: [20, 20, 180, 0], whole_object: [10, 10, 20, 20],
    }] }, "16");
    assert.equal(result.status, to[0] === 20 ? 0 : 1, result.stderr + result.stdout);
    assert.match(result.stdout, /held \| 3 \| 0 \| 0 \| 0 \| 3 \|/);
  }
});

// The audit that missed the 38 s heading cut reported zero because its oracle
// never covered the label row. A settled crop that slices a reference surface
// must now be reported, and the report must name the surface and the time.
test("framing CLI reports a settled crop that slices a reference surface", () => {
  const beat = { id: "heading", t0: 0, t1: 0.1, kind: "type", zones: [], actions: [] };
  const cut = run(beat, "0", [{ name: "column heading: To do 4", bbox: [90, 10, 20, 20] }]);
  assert.equal(cut.status, 1, cut.stderr + cut.stdout);
  assert.match(cut.stdout, /references \| 3 \| .* 3 \| FAIL \(column heading: To do 4; first cut column heading: To do 4 at 0\.000s/);
  const whole = run(beat, "0", [{ name: "column heading: To do 4", bbox: [10, 10, 20, 20] }]);
  assert.equal(whole.status, 0, whole.stderr + whole.stdout);
  assert.match(whole.stdout, /references \| 3 \| .* 0 \| PASS/);
});
