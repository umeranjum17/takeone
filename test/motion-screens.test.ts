import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PlannerUnavailable, savePlannerConfig } from "../src/decide/planner.ts";
import { THEME_NOTES } from "../src/decide/film.ts";
import { parseMotionArgs, planMotion, planStoryboard } from "../src/motion/cli.ts";
import { main } from "../src/cli.ts";
import { FOCUS, SHAPES } from "../src/motion/ai.ts";
import { validateStoryboard } from "../src/motion/storyboard.ts";

const KEY = "test-key-000";

/** Three 1200x900 flat screenshots: the planner is faked, so only their sizes matter here. */
function screenshots(dir: string): string[] {
  return ["#202030", "#303040", "#405060"].map((colour, i) => {
    const file = join(dir, `screen-${i + 1}.png`);
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", `color=c=${colour}:s=1200x900`, "-frames:v", "1", file]);
    return file;
  });
}

/** A throwaway planner config for a model that reads images: the screenshot path needs one. */
async function visionConfig(dir: string): Promise<string> {
  const configDir = join(dir, "test-config");
  await savePlannerConfig({ backend: "anthropic", auth: "apiKey", model: "claude-haiku-5-5", maxRetries: 0, retryBaseMs: 1, retryMaxMs: 1, supportsImages: true }, { configDir });
  return configDir;
}

/** The planner's answer for one asked field, in the Anthropic tool-input shape the backend parses. */
function answerFor(name: string): unknown {
  const pick = (options: string[], chosen: string) => ({ probabilities: Object.fromEntries(options.map((o) => [o, o === chosen ? 1 : 0])), pick: chosen });
  if (name === "theme") return pick(Object.keys(THEME_NOTES), "paper");
  if (name === "shape") return pick(Object.keys(SHAPES), "tour");
  if (name === "order") return { ranking: ["S3", "S1", "S2"], confidence: 1 };
  return pick(FOCUS, name === "focus_S1" ? "middle-centre" : "whole");
}

/** A fake planner endpoint: records the asked fields of each call and answers them with `answer`. */
function plannerFetch(calls: string[][], answer: (name: string) => unknown = answerFor): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const names = Object.keys((JSON.parse(String(init?.body)) as { tools: { input_schema: { properties: Record<string, unknown> } }[] }).tools[0]!.input_schema.properties);
    calls.push(names);
    const input = Object.fromEntries(names.map((n) => [n, answer(n)]));
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "decisions", input }], usage: { input_tokens: 800, output_tokens: 40 } }), { status: 200 });
  }) as typeof fetch;
}

test("screenshots get one planner call: theme, shape, screen order and focus come from the planner", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-screens-"));
  try {
    const files = screenshots(dir);
    const calls: string[][] = [];
    const configDir = await visionConfig(dir);
    const sb = validateStoryboard(await planMotion(parseMotionArgs(files), "motion", { apiKey: KEY, configDir, fetchImpl: plannerFetch(calls), warn: () => {} }));
    assert.deepEqual(calls, [["theme", "shape", "order", "focus_S1", "focus_S2", "focus_S3"]]);
    assert.equal(sb.theme.name, "paper");
    assert.deepEqual(sb.planner, { by: "ai", abstained: [] });
    assert.deepEqual(sb.scenes.map((s) => s.pattern), ["zoom-tour", "zoom-tour", "zoom-tour", "end-card"]);
    // The planner ranked the third screenshot first; the first screenshot's middle-centre third is now S2.
    assert.deepEqual((sb.source as { files: string[] }).files, [files[2], files[0], files[1]].map((f) => resolve(f!)));
    assert.deepEqual(sb.regions.find((r) => r.screen === "S2")?.rect, [400, 300, 400, 300]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flags fix their decisions: the planner is asked only about the rest", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-screens-"));
  try {
    const files = screenshots(dir);
    const calls: string[][] = [];
    const configDir = await visionConfig(dir);
    const sb = validateStoryboard(await planMotion(parseMotionArgs([...files, "--theme", "mono", "--pattern", "end-card"]), "motion",
      { apiKey: KEY, configDir, fetchImpl: plannerFetch(calls), warn: () => {} }));
    assert.deepEqual(calls, [["order", "focus_S1", "focus_S2", "focus_S3"]]);
    assert.equal(sb.theme.name, "mono");
    assert.deepEqual(sb.scenes.map((s) => s.pattern), ["end-card"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--no-ai keeps the local plan and makes no planner call", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-screens-"));
  try {
    const files = screenshots(dir);
    const calls: string[][] = [];
    const configDir = await visionConfig(dir);
    const local = await planMotion(parseMotionArgs([...files, "--no-ai"]), "motion", { apiKey: KEY, configDir, fetchImpl: plannerFetch(calls) });
    assert.deepEqual(local, planStoryboard(parseMotionArgs(files), "motion"));
    assert.equal(calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a planner that abstains on everything falls back to the local look, and says so", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-screens-"));
  try {
    const files = screenshots(dir);
    const configDir = await visionConfig(dir);
    const sb = validateStoryboard(await planMotion(parseMotionArgs(files), "motion",
      { apiKey: KEY, configDir, fetchImpl: plannerFetch([], () => undefined), warn: () => {} }));
    assert.equal(sb.planner.by, "local");
    assert.deepEqual(sb.planner.abstained, ["theme", "shape", "order", "focus_S1", "focus_S2", "focus_S3"]);
    assert.equal(sb.theme.name, "midnight");
    assert.deepEqual(sb.scenes.map((s) => s.pattern), ["hero-reveal", "zoom-tour", "zoom-tour", "zoom-tour", "end-card"]);
    // An abstained focus is the whole screen, split into the two halves the local planner also tours.
    assert.deepEqual(sb.regions.filter((r) => r.screen === "S1").map((r) => r.rect), [[0, 0, 600, 900], [600, 0, 600, 900]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a planner that is rate limited stops the run instead of silently falling back", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-screens-"));
  try {
    const files = screenshots(dir);
    const configDir = await visionConfig(dir);
    const limited = (async () => new Response("limited", { status: 429 })) as typeof fetch;
    await assert.rejects(planMotion(parseMotionArgs(files), "motion", { apiKey: KEY, configDir, fetchImpl: limited, warn: () => {} }), PlannerUnavailable);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed screen order falls back to the order given, never doubling a screen", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-screens-"));
  try {
    const files = screenshots(dir);
    const configDir = await visionConfig(dir);
    const answer = (name: string) => name === "order" ? { ranking: ["S1", "S1", "S2"], confidence: 1 } : answerFor(name);
    const sb = validateStoryboard(await planMotion(parseMotionArgs(files), "motion",
      { apiKey: KEY, configDir, fetchImpl: plannerFetch([], answer), warn: () => {} }));
    assert.ok(sb.planner.abstained.includes("order"), sb.planner.abstained.join(","));
    assert.deepEqual((sb.source as { files: string[] }).files, files.map((f) => resolve(f!)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a flag the local rules reject fails before the billed planner call", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-screens-"));
  try {
    const files = screenshots(dir);
    const configDir = await visionConfig(dir);
    for (const bad of [["--region", "0,0,abc"], ["--theme", "neon"], ["--pattern", "bento"]]) {
      const calls: string[][] = [];
      await assert.rejects(planMotion(parseMotionArgs([...files, ...bad]), "motion",
        { apiKey: KEY, configDir, fetchImpl: plannerFetch(calls), warn: () => {} }));
      assert.deepEqual(calls, [], `${bad.join(" ")} called the planner first`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run whose flags fix every decision never resolves the planner", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-screens-"));
  try {
    const files = screenshots(dir).slice(0, 1);
    const configDir = join(dir, "broken-config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "planner.json"), "{not json");
    const args = parseMotionArgs([...files, "--theme", "paper", "--pattern", "hero-reveal", "--region", "120,80,800,500"]);
    const warns: string[] = [];
    const sb = validateStoryboard(await planMotion(args, "motion", { configDir, warn: (s) => warns.push(s) }));
    assert.equal(sb.theme.name, "paper");
    assert.deepEqual(sb.planner, { by: "local", abstained: [] });
    assert.deepEqual(await planMotion(args, "motion", { configDir, warn: () => {} }), planStoryboard(args, "motion"));
    assert.deepEqual(warns, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a provider that cannot serve the run exits 3 before any take directory is written", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-screens-"));
  const saved = [process.env.XDG_CONFIG_HOME, process.env.TAKEONE_DIR, process.env.TAKEONE_NO_KEYRING];
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.env.TAKEONE_DIR = join(dir, "takes");
  process.env.TAKEONE_NO_KEYRING = "1";
  const error = console.error;
  console.error = () => {};
  try {
    const files = screenshots(dir);
    mkdirSync(join(dir, "config", "takeone"), { recursive: true });
    writeFileSync(join(dir, "config", "takeone", "planner.json"), JSON.stringify({
      backend: "opencode-go", auth: "account", model: "opencode-go/muse-spark-1.3-contributor",
    }));
    assert.equal(await main(["motion", ...files]), 3);
    assert.equal(existsSync(join(dir, "takes")), false);
  } finally {
    console.error = error;
    for (const [k, v] of [["XDG_CONFIG_HOME", saved[0]], ["TAKEONE_DIR", saved[1]], ["TAKEONE_NO_KEYRING", saved[2]]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with the planner off, screenshots get the local plan and a warning", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-screens-"));
  try {
    const files = screenshots(dir);
    const warns: string[] = [];
    const sb = validateStoryboard(await planMotion(parseMotionArgs(files), "motion", { apiKey: null, warn: (s) => warns.push(s) }));
    assert.equal(sb.planner.by, "local");
    assert.match(warns.join("\n"), /AI planner is OFF/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
