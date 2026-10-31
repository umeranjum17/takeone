import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PlannerUnavailable } from "../src/decide/planner.ts";
import { FOCUS, screenAsk, screenDecision } from "../src/motion/ai.ts";
import { parseMotionArgs, planMotion, planStoryboard } from "../src/motion/cli.ts";
import { main } from "../src/cli.ts";
import { validateStoryboard } from "../src/motion/storyboard.ts";

/** An engine that can serve, and one that cannot: the stop is the sign-in line the other surfaces give. */
const engine = async () => ({});
const noEngine = async () => { throw new PlannerUnavailable("signed-in account or stored key", "no sign-in found", { credentialMissing: true }); };

/** Three 1200x900 flat screenshots: only their sizes and order matter here. */
function screenshots(dir: string): string[] {
  return ["#202030", "#303040", "#405060"].map((colour, i) => {
    const file = join(dir, `screen-${i + 1}.png`);
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", `color=c=${colour}:s=1200x900`, "-frames:v", "1", file]);
    return file;
  });
}

test("screenshot runs are planned locally: every run keeps the local plan and says image planning is off", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-screens-"));
  try {
    const files = screenshots(dir);
    const args = parseMotionArgs(files);
    const warns: string[] = [];
    await assert.rejects(planMotion(args, "motion", { warn: (s) => warns.push(s), engine: noEngine }), /takeone needs an AI engine/);
    const sb = validateStoryboard(await planMotion(args, "motion", { warn: (s) => warns.push(s), engine }));
    assert.deepEqual(sb, validateStoryboard(planStoryboard(args, "motion")));
    assert.deepEqual(sb.planner, { by: "local", abstained: [] });
    assert.deepEqual(sb.scenes.map((s) => s.pattern), ["kinetic-type", "zoom-tour", "zoom-tour", "zoom-tour", "end-card"]);
    // The warning names the limit: no screenshot is handed to a planner.
    assert.match(warns.join("\n"), /AI image planning is OFF[^]*no screenshot is sent to a planner/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--no-ai is refused by name: a film the user lays out keeps the local plan and warns about nothing", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-screens-"));
  try {
    const files = screenshots(dir);
    const warns: string[] = [];
    assert.throws(() => parseMotionArgs([...files, "--no-ai"]), /--no-ai is not offered: an image run is planned with an AI engine/);
    await assert.rejects(planMotion(parseMotionArgs(files), "motion", { warn: (s) => warns.push(s), engine: noEngine }), /takeone needs an AI engine/);
    // --pattern is the way to keep the local rules: the user names the film, so no engine is asked.
    const args = parseMotionArgs([...files, "--pattern", "end-card"]);
    assert.deepEqual(await planMotion(args, "motion", { warn: (s) => warns.push(s) }), planStoryboard(args, "motion"));
    assert.deepEqual(warns, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a screenshot run resolves the stored planner: a corrupt one stops it before any storyboard", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-screens-"));
  const saved = [process.env.XDG_CONFIG_HOME, process.env.TAKEONE_DIR, process.env.TAKEONE_NO_KEYRING];
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.env.TAKEONE_DIR = join(dir, "takes");
  process.env.TAKEONE_NO_KEYRING = "1";
  const error = console.error;
  const log = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    mkdirSync(join(dir, "config", "takeone"), { recursive: true });
    // Corrupt on purpose: resolving the planner fails the run, and nothing is planned.
    writeFileSync(join(dir, "config", "takeone", "planner.json"), "{not json");
    const out = join(dir, "take");
    assert.notEqual(await main(["motion", ...screenshots(dir), "--out", out, "--plan-only", "--theme", "paper"]), 0);
    assert.ok(!existsSync(join(out, "storyboard.json")), "no storyboard is written");
    // With an engine the same flags plan locally, as before.
    const sb = validateStoryboard(await planMotion(parseMotionArgs([...screenshots(dir), "--theme", "paper"]), "motion", { warn: () => {}, engine }));
    assert.equal(sb.theme.name, "paper");
    assert.deepEqual(sb.planner, { by: "local", abstained: [] });
  } finally {
    console.error = error;
    console.log = log;
    for (const [k, v] of [["XDG_CONFIG_HOME", saved[0]], ["TAKEONE_DIR", saved[1]], ["TAKEONE_NO_KEYRING", saved[2]]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a planner that abstains on everything keeps the local defaults: no shape, no focus region", () => {
  const screens = ["S1", "S2", "S3"].map((id) => ({ id, width: 1200, height: 900 }));
  const pins = { theme: false, shape: false, orderFree: true, focus: new Set<string>() };
  assert.deepEqual(Object.keys(screenAsk(screens, pins).questions), ["theme", "shape", "order", "focus_S1", "focus_S2", "focus_S3"]);
  const d = screenDecision({}, screens, pins);
  assert.equal(d.theme, undefined);
  assert.equal(d.shape, undefined);
  assert.deepEqual(d.order, ["S1", "S2", "S3"]);
  assert.deepEqual(d.focus, {});
  assert.equal(d.decided, 0);
  assert.deepEqual(d.abstained, ["theme", "shape", "order", "focus_S1", "focus_S2", "focus_S3"]);
  // Pinned fields are not asked, so they are not abstentions either.
  const pinned = screenDecision({}, screens, { theme: true, shape: true, orderFree: false, focus: new Set(["S2"]) });
  assert.deepEqual(Object.keys(screenAsk(screens, { theme: true, shape: true, orderFree: false, focus: new Set(["S2"]) }).questions), ["focus_S1", "focus_S3"]);
  assert.deepEqual(pinned.abstained, ["focus_S1", "focus_S3"]);
  assert.deepEqual(pinned.focus, {});
});

test("decided answers are kept: focus only for the screens the planner answered", () => {
  const screens = ["S1", "S2"].map((id) => ({ id, width: 1200, height: 900 }));
  const pins = { theme: false, shape: false, orderFree: true, focus: new Set<string>() };
  const answers = {
    theme: { answer: "paper", confidence: 1, abstained: false, by: "ai" as const, ms: 0 },
    shape: { answer: "tour", confidence: 1, abstained: false, by: "ai" as const, ms: 0 },
    order: { answer: ["S2", "S1"], confidence: 1, abstained: false, by: "ai" as const, ms: 0 },
    focus_S1: { answer: FOCUS[4]!, confidence: 1, abstained: false, by: "ai" as const, ms: 0 },
    focus_S2: { answer: null, confidence: 0, abstained: true, by: "ai" as const, ms: 0 },
  };
  const d = screenDecision(answers, screens, pins);
  assert.equal(d.theme, "paper");
  assert.equal(d.shape, "tour");
  assert.deepEqual(d.order, ["S2", "S1"]);
  assert.deepEqual(d.focus, { S1: FOCUS[4]! });
  assert.deepEqual(d.abstained, ["focus_S2"]);
  assert.equal(d.decided, 4);
});

test("a flag the local rules reject fails before any planning happens", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-screens-"));
  try {
    const files = screenshots(dir);
    for (const bad of [["--region", "0,0,abc"], ["--theme", "no-such-theme"], ["--pattern", "bento"]]) {
      await assert.rejects(planMotion(parseMotionArgs([...files, ...bad]), "motion", { warn: () => {} }));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing take is a motion input: its footage becomes an editable clip film planned without a planner", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-take-input-"));
  try {
    const take = join(dir, "take");
    mkdirSync(join(take, "out"), { recursive: true });
    writeFileSync(join(take, "take.json"), JSON.stringify({ id: "t1" }));
    assert.throws(() => planStoryboard(parseMotionArgs([take]), "motion"), /no footage/);
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=0x335577:s=320x180:d=3:r=30", "-pix_fmt", "yuv420p", join(take, "out", "t1.mp4")]);
    const args = parseMotionArgs([take, "--title", "My take", "--cta", "Get it", "--url", "example.com"]);
    const warns: string[] = [];
    const sb = validateStoryboard(await planMotion(args, "motion", { warn: (s) => warns.push(s) }));
    assert.deepEqual(warns, []);
    assert.deepEqual(sb.source, { kind: "take", dir: take });
    assert.deepEqual(sb.planner, { by: "local", abstained: [] });
    assert.deepEqual(sb.scenes.map((s) => s.pattern), ["statement", "clip", "statement"]);
    assert.deepEqual(sb.clips!["footage"]!.files, [join(take, "out", "t1.mp4")]);
    assert.ok(Math.abs(sb.clips!["footage"]!.d - 3) < 0.1);
    assert.equal(sb.scenes[1]!.fill, true);
    assert.deepEqual(sb.scenes.map((s) => s.title), ["My take", undefined, "Get it"]);
    assert.equal(sb.scenes[2]!.note, "example.com");
    const out = join(dir, "film");
    assert.equal(await main(["motion", take, "--out", out, "--plan-only"]), 0);
    assert.equal(validateStoryboard(JSON.parse(readFileSync(join(out, "storyboard.json"), "utf8"))).source.kind, "take");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a screenshot run with no engine stops with the sign-in line and plans nothing; --no-ai fails by name", { timeout: 120000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-screens-noengine-"));
  try {
    const [board] = screenshots(dir);
    const run = (...extra: string[]) => spawnSync(process.execPath, [resolve("bin/takeone.mjs"), "motion", board!, "--out", join(dir, "film"), "--plan-only", ...extra], {
      encoding: "utf8", timeout: 60_000,
      env: { HOME: dir, XDG_CONFIG_HOME: join(dir, ".config"), TMPDIR: dir, PATH: dirname(process.execPath), TAKEONE_NO_KEYRING: "1" },
    });
    const stopped = run("--theme", "paper");
    assert.equal(stopped.status, 3, stopped.stderr);
    assert.match(stopped.stderr, /takeone needs an AI engine.*Sign in with: claude/);
    const removed = run("--no-ai");
    assert.equal(removed.status, 1, removed.stderr);
    assert.match(removed.stderr, /--no-ai is not offered: an image run is planned with an AI engine/);
    assert.ok(!existsSync(join(dir, "film", "storyboard.json")), "no storyboard is written");
    assert.equal(run("--pattern", "end-card").status, 0, "a film the user lays out with --pattern needs no engine");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
