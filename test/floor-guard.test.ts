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

// A throwaway repo with one committed test file, and a guard that reads the working tree.
const repo = (base = BASE, baseSrc = SRC) => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-floor-"));
  const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: dir, env });
  const guard = (body: string, src = SRC) => {
    writeFileSync(join(dir, "test", "x.test.ts"), body);
    writeFileSync(join(dir, "src", "ask.ts"), src);
    return spawnSync(process.execPath, [join(dir, "floor-guard.mjs"), "--base", "main"], { cwd: dir, env, encoding: "utf8" }).status;
  };
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "test"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "ask.ts"), baseSrc);
  copyFileSync(GUARD, join(dir, "floor-guard.mjs"));
  writeFileSync(join(dir, "test", "x.test.ts"), base);
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "change");
  return { guard, done: () => rmSync(dir, { recursive: true, force: true }) };
};

test("floor guard passes renamed assertions, still flags real removals and new skips", () => {
  const r = repo();
  const { guard } = r;
  try {
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
    r.done();
  }
});

// The preflight reserve of the chunked planner: the reserve rule moved from "every request twice"
// to "one re-asked chunk", so the old inequality no longer holds on a take with two chunks. The
// same test states the new rule instead.
const RESERVE = `test("preflight reserves re-asks", async () => {
  assert.ok(planned >= bodies.reduce((sum, body) => sum + Math.ceil(body.length / 3.5), 0) * 2 - 1200);
});
`;
const RESERVE_STRONGER = `test("preflight reserves re-asks", async () => {
  assert.equal(bodies.length, 3);
  assert.equal(bodies[1], bodies[0], "the re-ask repeats the first chunk");
  assert.ok(planned >= tokens(bodies[0]!) + tokens(bodies[2]!) + Math.max(tokens(bodies[0]!), tokens(bodies[2]!)));
  assert.ok(bodies.every((body) => tokens(body) <= 4000), "every chunk stays under the 4,000-token cap");
});
`;

test("floor guard pairs a removed check with stronger checks in the same test only", () => {
  const r = repo(RESERVE);
  const { guard } = r;
  try {
    assert.equal(guard(RESERVE_STRONGER), 0, "stronger checks in the same test replace the removed one");
    assert.equal(guard(`test("preflight reserves re-asks", async () => {
});
`), 1, "a removed check with nothing in its place still fails");
    assert.equal(guard(`test("preflight reserves re-asks", async () => {
  assert.equal(r.planner.failed, 0);
});
`), 1, "a removed check with an unrelated check beside it still fails");
    assert.equal(guard(`test("preflight reserves re-asks", async () => {
});
test("the next chunk starts from the previous one", async () => {
  assert.equal(bodies.length, 3);
  assert.equal(bodies[1], bodies[0], "the re-ask repeats the first chunk");
  assert.ok(planned >= tokens(bodies[0]!) + tokens(bodies[2]!) + Math.max(tokens(bodies[0]!), tokens(bodies[2]!)));
  assert.ok(bodies.every((body) => tokens(body) <= 4000), "every chunk stays under the 4,000-token cap");
});
`), 1, "stronger checks in another test do not cover the removed one");
    assert.equal(guard(`test("preflight reserves re-asks", async () => {
  assert.ok(planned >= 1);
});
`), 1, "a constant on the same quantity proves less than the removed check");
    assert.equal(guard(`test("preflight reserves re-asks", async () => {
  assert.ok(planned >= 1);
  assert.equal(r.planner.failed, 0);
});
`), 1, "a weaker check plus an unrelated one do not cover the removed one");
  } finally {
    r.done();
  }
});

test("floor guard keeps a numeric bar when a check is rewritten", () => {
  const r = repo(`test("the plan covers every beat", async () => {
  assert.ok(planned >= 1200);
});
`);
  const { guard } = r;
  try {
    assert.equal(guard(`test("the plan covers every beat", async () => {
  assert.ok(planned >= 2400);
});
`), 0, "a raised bar on the same quantity covers the removed one");
    assert.equal(guard(`test("the plan covers every beat", async () => {
  assert.ok(planned >= 600);
});
`), 1, "a lowered bar on the same quantity is still a removal");
  } finally {
    r.done();
  }
});

test("floor guard flags a test that lost more checks than it gained", () => {
  const r = repo(`test("the plan covers every beat", async () => {
  assert.ok(planned >= 1200);
  assert.ok(planned >= 600);
});
test("a second test", async () => {
  assert.equal(r.decisions.length, 3);
});
`);
  const { guard } = r;
  try {
    assert.equal(guard(`test("the plan covers every beat", async () => {
  assert.ok(planned >= 2400);
});
test("a second test", async () => {
  assert.equal(r.decisions.length, 3);
  assert.equal(r.decisions[0]!.kind, "beat");
});
`), 1, "a test that lost two checks and gained one is a removal even when the gain is stronger");
  } finally {
    r.done();
  }
});

// The caption layout lost its phone-overlay parameters, so the band check calls it with one argument
// fewer. That check is the same check, not a removed one, only while src/ drops the parameter too.
test("floor guard pairs a call that lost an argument with the function that lost the parameter", () => {
  const SIGNATURE = "export function layout(rows: unknown[], d: object, wide = false, band?: object) { return [rows, d, wide, band]; }\n";
  const r = repo(`test("the title fits the band row", async () => {
  assert.doesNotThrow(() => layout(rows, d, false, band), "the title does not fit");
});
`, SIGNATURE);
  const { guard } = r;
  try {
    const dropped = `test("the title fits the band row", async () => {
  assert.doesNotThrow(() => layout(rows, d, band), "the title does not fit");
});
`;
    assert.equal(guard(dropped, SIGNATURE.replace("wide = false, ", "").replace("wide, ", "")), 0, "the argument went with its parameter");
    assert.equal(guard(dropped, SIGNATURE), 1, "an argument dropped while src keeps the parameter still fails");
    assert.equal(guard(dropped.replace("layout(rows, d, band)", "layout(rows, band)"), SIGNATURE.replace("wide = false, ", "").replace("wide, ", "")), 1,
      "dropping a second argument for one dropped parameter still fails");
    assert.equal(guard(dropped.replace("layout(rows, d, band)", "layout(rows, d, true)"), SIGNATURE.replace("wide = false, ", "").replace("wide, ", "")), 1,
      "a changed argument is not a dropped one");
  } finally {
    r.done();
  }
});
