import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const GUARD = join(import.meta.dirname, "..", "scripts", "floor-guard.mjs");

// Built from parts so this file's own lines never read as a skipped test.
const SKIP = "{ skip" + ": needsFfmpeg }";
const BASE = `test("make --no-jev renders", async () => {
  assert.equal(r.jev.failed, 0);
  assert.equal(r.jev.input_tokens, 0);
  assert.ok(r.decisions.some((d) => d.decided_by === "jev"));
  assert.ok(r1.answers);
  assert.deepEqual(r2.response, r1.response);
});
`;
const SRC = "export interface AskResult { response?: unknown; answers?: unknown }\n";

test("floor guard passes renamed assertions, still flags real removals and new skips", () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-floor-"));
  const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: dir, env });
  const guard = (body: string, src = SRC) => {
    writeFileSync(join(dir, "test", "x.test.ts"), body);
    writeFileSync(join(dir, "src", "ask.ts"), src);
    return spawnSync(process.execPath, [join(dir, "floor-guard.mjs"), "--base", "main"], { cwd: dir, env, encoding: "utf8" }).status;
  };
  try {
    git("init", "-q", "-b", "main");
    mkdirSync(join(dir, "test"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "ask.ts"), SRC);
    copyFileSync(GUARD, join(dir, "floor-guard.mjs"));
    writeFileSync(join(dir, "test", "x.test.ts"), BASE);
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "change");

    const renamed = BASE.replaceAll("--no-jev", "--no-ai").replaceAll("r.jev.", "r.planner.").replace('=== "jev"', '=== "ai"');
    assert.equal(guard(renamed), 0, "a rename is not a removal");
    assert.equal(guard(BASE.replace("r.jev.failed, 0", "r.jev.skipped, 0") + "// failed beats\n"), 1, "a same-shape swap is not a rename while the old word remains");
    assert.equal(guard(BASE.replaceAll("r.jev.", "r.planner.")), 0, "a one-word swap recurring across assertions is a rename even while the old word remains");
    const answersSwap = BASE.replace("r2.response,", "r2.answers,");
    assert.equal(guard(answersSwap, SRC.replace("response?: unknown; ", "")), 0, "a one-word swap pairs when this diff deletes the old field from src");
    assert.equal(guard(answersSwap), 1, "a test-only swap while src still has the old field still fails");
    assert.equal(guard(BASE.replace("  assert.equal(r.jev.failed, 0);\n", "")), 1, "a removed assertion still fails");
    assert.equal(guard(BASE.replace("r.jev.failed, 0", "true, true")), 1, "a subject rewritten into another shape still fails");
    assert.equal(guard(renamed + `test("new", ${SKIP}, async () => {});\n`), 1, "a new skipped test still fails");
    assert.equal(guard(renamed.replace('renders", async', `renders", ${SKIP}, async`)), 1, "a renamed test that gains a skip still fails");
    // The prerequisite sentinel is undefined whenever the tool is present, so a
    // new declaration using it still runs on CI. A truthy skip is never exempt.
    const sentinel = 'const needsFfmpeg = hasFfmpeg() ? undefined : "requires ffmpeg";\n';
    assert.equal(guard(sentinel + BASE + `test("new", ${SKIP}, async () => {});\n`), 0, "a new test may declare the prerequisite sentinel");
    const truthy = 'const needsFfmpeg = hasFfmpeg() ? "present" : "missing";\n';
    const REAL_SKIP = "{ skip" + ': "always" }';
    assert.equal(guard(truthy + BASE + `test("new", ${SKIP}, async () => {});\n`), 1, "a sentinel-shaped binding that can resolve truthy still fails");
    assert.equal(guard(sentinel + BASE + `test("new", ${REAL_SKIP}, async () => {});\n`), 1, "a genuinely skipped new test still fails");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
