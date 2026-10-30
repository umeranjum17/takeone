import { CallBudget } from "../src/decide/budget.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rmSync } from "node:fs";
import { DEFAULT_PLANNER_CONFIG, PlannerFileCache, askChunk, pooled } from "../src/decide/planner.ts";
import type { Answer } from "@byokit/decide";

test("PlannerFileCache surfaces write failures through warn and never fails the decision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-plannercache-"));
  try {
    // a regular file where the cache's parent directory should be: every
    // mkdirSync/appendFileSync under it fails with ENOTDIR
    const blocker = join(dir, "analysis");
    writeFileSync(blocker, "not a directory\n");
    const path = join(blocker, "planner-cache.jsonl");
    const failures: string[] = [];
    const cache = new PlannerFileCache(path, (line) => failures.push(line));
    const answers = { focus: { answer: "a", abstained: false, confidence: 1 } } as unknown as Record<string, Answer>;
    assert.doesNotThrow(() => cache.set("k1", answers), "cache write failure must not throw");
    assert.ok(failures.length === 1, "write failure is reported, not swallowed");
    assert.ok(failures[0]!.includes(path), "warning names the cache path");
    // the in-memory entry still serves hits after the disk write failed
    assert.deepEqual(cache.get("k1"), answers);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fully abstained planner beat reports failed and keeps its billed tokens", async () => {
  const planner = { config: { ...DEFAULT_PLANNER_CONFIG }, defaulted: true, label: "jev", member: null, key: "k", accountPresent: false };
  const questions = { focus: { kind: "choice", options: { a: "Zone A" } } } as const;
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ answers: { focus: { choice: "zz", probabilities: { zz: 1 }, confidence: 0 } }, usage: { input_tokens: 15800, output_tokens: 40 } }), { status: 200 })) as typeof fetch;
  const r = await askChunk({ secret: "x" }, questions, planner as never, new Map() as never, { fetchImpl, timeoutMs: 2000, budget: new CallBudget(), workflow: "test" });
  assert.equal(r.decisionSource, "failed");
  assert.equal(r.inputTokens, 15800);
  assert.equal(r.outputTokens, 40);
});

test("pooled stops pulling queued items once a worker rejects", async () => {
  const started: number[] = [];
  let otherWorkerSettled = false;
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await assert.rejects(
    pooled([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 2, async (n) => {
      started.push(n);
      await delay(n === 1 ? 5 : 30);
      if (n === 1) throw new Error("rate limited");
      otherWorkerSettled = true;
    }),
    /rate limited/,
  );
  assert.equal(started.length, 2);
  assert.equal(otherWorkerSettled, true);
});
