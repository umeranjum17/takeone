import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rmSync } from "node:fs";
import { PlannerFileCache } from "../src/decide/planner.ts";
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
