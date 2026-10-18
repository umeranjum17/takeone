import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const GUARD = join(import.meta.dirname, "..", "scripts", "floor-guard.mjs");

// Built from parts so this file's own lines never read as a skipped test.
const SKIP = "{ skip" + ": needsFfmpeg }";
const BASE = `test("make --no-jev renders", ${SKIP}, async () => {
  assert.equal(r.jev.failed, 0);
  assert.equal(r.jev.input_tokens, 0);
  assert.ok(r.decisions.some((d) => d.decided_by === "jev"));
});
`;

test("floor guard passes renamed tests and assertions, still flags real removals and new skips", () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-floor-"));
  const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: dir, env });
  const guard = (body: string) => {
    writeFileSync(join(dir, "test", "x.test.ts"), body);
    return spawnSync(process.execPath, [join(dir, "floor-guard.mjs"), "--base", "main"], { cwd: dir, env, encoding: "utf8" }).status;
  };
  try {
    git("init", "-q", "-b", "main");
    mkdirSync(join(dir, "test"));
    copyFileSync(GUARD, join(dir, "floor-guard.mjs"));
    writeFileSync(join(dir, "test", "x.test.ts"), BASE);
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "change");

    const renamed = BASE.replaceAll("--no-jev", "--no-ai").replaceAll("r.jev.", "r.planner.").replace('=== "jev"', '=== "ai"');
    assert.equal(guard(renamed), 0, "a rename is not a removal");
    assert.equal(guard(BASE.replace("r.jev.failed, 0", "r.jev.skipped, 0") + "// failed beats\n"), 1, "a same-shape swap is not a rename while the old word remains");
    assert.equal(guard(BASE.replaceAll("r.jev.", "r.planner.")), 0, "a one-word swap recurring across assertions is a rename even while the old word remains");
    assert.equal(guard(BASE.replace("  assert.equal(r.jev.failed, 0);\n", "")), 1, "a removed assertion still fails");
    assert.equal(guard(BASE.replace("r.jev.failed, 0", "true, true")), 1, "a subject rewritten into another shape still fails");
    assert.equal(guard(renamed + `test("new", ${SKIP}, async () => {});\n`), 1, "a new skipped test still fails");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
