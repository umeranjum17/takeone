// End-to-end planner test over a synthetic take: a tiny webm generated with
// ffmpeg, plus events and frames.tsv written in code.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { makeTake, PreflightRefusal, TakeInputError, type MakeOptions, type MakeResult } from "../src/make.ts";
import { PlannerUnavailable, askChunk, loadPlannerConfig, resolvePlanner } from "../src/decide/planner.ts";
import { ConfigError, type Answer } from "@byokit/decide";
import type { Keystore } from "@byokit/secrets";
import { main, resolveCamera } from "../src/cli.ts";
import { frameRect } from "../src/decide/mapping.ts";
import type { Plan } from "../src/decide/plan.ts";
import { measureCaptions, renderTake } from "../src/render/render.ts";
import { bandLayout, bandText, captionLayouts, takeCaptions } from "../src/render/stage.ts";
import { mapFilm, planFilm } from "../src/decide/film.ts";
import type { Beat, Decision, TakeMeta } from "../src/types.ts";
import { STREAM, hasFfmpeg, buildLongTake, beatViews, chunkAnswers, filmAnswers } from "./helpers.ts";
import { DEFAULTS } from "../src/camera/defaults.ts";
import { THEMES } from "../src/themes.ts";

const STREAM_W = 320;
const STREAM_H = 180;
const KEY = "test-key-000";

// Every test in this file renders real video via system ffmpeg/ffprobe except
// the --max-tokens refusal check (it exits before touching video), so they
// skip explicitly where those binaries are absent instead of failing with
// ENOENT. CI installs ffmpeg (see .github/workflows/ci.yml) so coverage stays
// real there; the string below is the recorded skip reason.
const needsFfmpeg = hasFfmpeg() ? undefined : "requires system ffmpeg and ffprobe on PATH";

// Only tests render fast: the shipped default preset stays slow (see
// camera.test.ts), so production output is byte-identical to before.
// Tiny test renders: 320x180 output with the veryfast preset keeps CI encodes to
// seconds, and ripple/fade stay off to skip their per-frame stage work.
// Shipped output stays 1920x1080 slow (see DEFAULTS); only tests
// override the size.
const FAST = { ...DEFAULTS, preset: "veryfast", out_w: 320, out_h: 180, ripple_ms: 0, fade_s: 0 };
function fastTake(dir: string, opts: MakeOptions = {}): Promise<MakeResult> {
  // No test may discover credentials from the real home; Jev tests pass fake keys explicitly.
  return makeTake(dir, { apiKey: null, camera: FAST, configDir: join(dir, "test-config"), log: () => {}, warn: () => {}, ...opts });
}

function buildTake(dir: string): string {
  const webm = join(dir, "screen.webm");
  // 10 s solid grey at 30 fps: no change regions, deterministic beats from events
  // mpeg4, not VP9: software VP9 stalls weak CI runners (a 4 s 4K encode blocked
  // one for 25+ min). The input codec is incidental - only the rendered MP4,
  // beats and decisions are asserted. Matroska muxer because stock webm allows
  // only VP8/VP9/AV1; the pipeline probes content, so the .webm name is cosmetic.
  execFileSync("ffmpeg", [
    "-nostdin", "-f", "lavfi", "-i", "color=c=gray:s=320x180:d=10:r=30",
    "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska", "-frames:v", "300", "-y", webm,
  ], { stdio: "ignore" });
  const lines: string[] = [];
  for (let i = 0; i < 300; i++) lines.push(`${i * 3000}\t${i * 33333333}`);
  writeFileSync(join(dir, "frames.tsv"), lines.join("\n") + "\n");

  const events = [
    { t: 100, k: "win", cls: "chromium", title: "Quarterly report", rect: [0, 0, STREAM_W, STREAM_H] },
    { t: 400, k: "ptr", x: 200, y: 90 },
    { t: 500, k: "btn", b: "left", down: true },
    { t: 560, k: "btn", b: "left", down: false },
    { t: 2200, k: "wheel", dx: 0, dy: 1 },
    { t: 2400, k: "wheel", dx: 0, dy: 1 },
    { t: 4200, k: "key", cls: "char", down: true },
    { t: 4300, k: "key", cls: "char", down: true },
    { t: 6500, k: "btn", b: "left", down: true },
    { t: 6560, k: "btn", b: "left", down: false },
  ];
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const take: TakeMeta = {
    id: "t1",
    stream: { w: STREAM_W, h: STREAM_H },
    scale: 1,
    offset_ms: 0,
    pointer: "hyprland",
  };
  writeFileSync(join(dir, "take.json"), JSON.stringify(take, null, 1));
  return dir;
}

function newTake(): string {
  return buildTake(mkdtempSync(join(tmpdir(), "takeone-take-")));
}

function plannerAnswers(): unknown {
  // Jev wire shape (what the backend parses), not the mapping shape.
  const answers = {
    focus_start: { choice: "z1", probabilities: { z1: 0.9, z2: 0.1 }, confidence: 0.8 },
    focus_end: { choice: "z1", probabilities: { z1: 0.9, z2: 0.1 }, confidence: 0.8 },
    tightness: { probabilities: [0.1, 0.1, 0.7, 0.1], confidence: 0.9 },
    new_subject: { noul: 0.2 },
    key_moment: { probabilities: [0.7, 0.2, 0.1], confidence: 0.8 },
  };
  return { answers, usage: { input_tokens: 800 } };
}

/** plannerAnswers for one beat, focused on its first zone. */
function firstZoneAnswers(names: string[]): Record<string, unknown> {
  const probabilities = Object.fromEntries(names.map((name, i) => [name, i === 0 ? 1 : 0]));
  const { answers } = plannerAnswers() as { answers: Record<string, unknown> };
  return { ...answers, focus_start: { choice: names[0], probabilities, confidence: 1 }, focus_end: { choice: names[0], probabilities, confidence: 1 } };
}

/** A planner reply answering every beat of a chunk on its first zone; 800 input tokens a call. */
function firstZoneReply(body: string): Response {
  return new Response(JSON.stringify({ answers: chunkAnswers(body, firstZoneAnswers), usage: { input_tokens: 800 } }), { status: 200 });
}

function newLongTake(): string {
  return buildLongTake(mkdtempSync(join(tmpdir(), "takeone-take-")));
}

test("make --no-ai renders the agreed beat/decision files into a tiny test MP4", async () => {
  const dir = newTake();
  try {
    // --set is test-only plumbing: full-size slow output stays the default.
    assert.equal(await main(["make", dir, "--no-ai", "--theme", "paper",
      "--set", "preset=veryfast", "--set", "out_w=320", "--set", "out_h=180",
      "--set", "ripple_ms=0", "--set", "fade_s=0"]), 0);
    assert.equal(JSON.parse(readFileSync(join(dir, "take.json"), "utf8")).theme, "paper");
    const output = join(dir, "out", "t1.mp4");
    assert.ok(existsSync(output));
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=width,height,nb_read_frames", "-of", "json", output], { encoding: "utf8" }));
    assert.deepEqual([probe.streams[0].width, probe.streams[0].height], [320, 180]);
    // Idle squeezing shortens the 10 s take; the video still matches the solved camera path.
    const cameraFrames = JSON.parse(readFileSync(join(dir, "camera.json"), "utf8")).length;
    const frames = Number(probe.streams[0].nb_read_frames);
    assert.ok(frames < 10 * DEFAULTS.fps && Math.abs(frames - cameraFrames) <= 1, `${frames} frames vs ${cameraFrames} camera samples`);
    const beats = JSON.parse(readFileSync(join(dir, "analysis", "beats.json"), "utf8"));
    const decisions = readFileSync(join(dir, "analysis", "decisions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(Array.isArray(beats));
    assert.equal(beats.length, decisions.length);
    assert.ok(beats.every((b: { t0: number; t1: number; zones: { type: string; t_change?: number }[] }) => b.t0 >= 0 && b.t1 <= 10 && b.zones.every((z) => Boolean(z.type) && (z.t_change === undefined || z.t_change >= b.t0 && z.t_change <= b.t1))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("render --preview frames the film like the full render, at preview speed", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    // Upscale headroom lets the 320 px fixture's camera push in, and the cursor stays shown, so it rides a moving camera.
    const look = ["--theme", "paper", "--set", "preset=veryfast", "--set", "out_w=320", "--set", "out_h=180",
      "--set", "ripple_ms=0", "--set", "fade_s=0", "--set", "max_upscale=4", "--set", "cursor_hide_idle_s=0"];
    // A cursor-free take: the preview draws the same re-rendered cursor as the full render. The pointer
    // wanders off the click, so where the arrow lands depends on which camera frame projects it.
    const metaPath = join(dir, "take.json");
    writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(readFileSync(metaPath, "utf8")), cursor_free: true }));
    const eventsPath = join(dir, "events.jsonl");
    const wander = Array.from({ length: 40 }, (_, i) => ({ t: 700 + i * 200, k: "ptr", x: 200 - i * 4, y: 90 - i }));
    const events = [...readFileSync(eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)), ...wander].sort((a, b) => a.t - b.t);
    writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    assert.equal(await main(["make", dir, "--no-ai", ...look]), 0);
    const fullPath = join(dir, "camera.json");
    const fullCamera = readFileSync(fullPath, "utf8");
    // The preview writes its own file and leaves the full render's export alone.
    assert.equal(await main(["render", dir, ...look, "--preview"]), 0);
    assert.ok(existsSync(join(dir, "out", "t1-preview.mp4")));
    // The camera path is the full render's, solved at full resolution: the preview frames
    // the film the same way, so camera.json is byte-identical.
    assert.equal(readFileSync(fullPath, "utf8"), fullCamera);
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", join(dir, "out", "t1-preview.mp4")], { encoding: "utf8" }));
    assert.deepEqual([probe.streams[0].width, probe.streams[0].height], [320, 180]);
    assert.equal(probe.streams[0].r_frame_rate, "30/1");
    // The preview's 30 fps cursor follows the camera at its own time, not the 60 fps camera frame of the same
    // index: its arrow tip sits where the full render's does at that second.
    const tips = (file: string) => new Map(readFileSync(file, "utf8").split("\n").flatMap((line) => {
      // Each line spans its frame's half-frame either side: key it on its centre, the frame's own time.
      const m = /^Dialogue: 1,(\d+):(\d+):([\d.]+),(\d+):(\d+):([\d.]+),.*\}m ([-\d.]+) ([-\d.]+)/.exec(line);
      const at = (h: string, mm: string, ss: string) => +h * 3600 + +mm * 60 + +ss;
      return m ? [[Math.round((at(m[1]!, m[2]!, m[3]!) + at(m[4]!, m[5]!, m[6]!)) * 50), [+m[7]!, +m[8]!]] as const] : [];
    }));
    const full = tips(join(dir, "cursor.ass")), preview = tips(join(dir, "preview", "cursor.ass"));
    const off = [...preview].filter(([t]) => full.has(t)).map(([t, [x, y]]) => Math.hypot(x - full.get(t)![0], y - full.get(t)![1]));
    assert.ok(off.length > 20 && Math.max(...off) <= 1.5, `${off.length} matched frames, worst ${Math.max(...off).toFixed(1)} px`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("make handles an empty focused window without retaining the previous window", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    const path = join(dir, "events.jsonl");
    const events = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    events.push({ t: 2000, k: "win", cls: "", title: "", rect: null });
    events.sort((a, b) => a.t - b.t);
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    await fastTake(dir, { noAi: true });
    const actions = JSON.parse(readFileSync(join(dir, "analysis", "actions.json"), "utf8")).actions;
    assert.ok(actions.some((a: { k: string; t: number; window_cls: string }) => a.k === "click" && a.t > 2000 && a.window_cls === ""));
    const beats = JSON.parse(readFileSync(join(dir, "analysis", "beats.json"), "utf8"));
    const after = beats.filter((b: { anchor_t: number }) => b.anchor_t > 2);
    assert.ok(after.length > 0);
    assert.ok(after.every((b: { window_rect?: number[] }) => b.window_rect === undefined));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("make renders partly and wholly off-screen windows", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    const eventsPath = join(dir, "events.jsonl");
    const events = readFileSync(eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    events[0].rect = [-10, 0, 200, 100];
    events.push({ t: 6000, k: "win", cls: "chromium", title: "Outside", rect: [400, 0, 100, 100] });
    events.sort((a, b) => a.t - b.t);
    writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    await fastTake(dir, { noAi: true, log: () => {}, warn: () => {} });
    const beats = JSON.parse(readFileSync(join(dir, "analysis", "beats.json"), "utf8"));
    assert.ok(beats.some((b: { window_rect?: number[] }) => JSON.stringify(b.window_rect) === "[0,0,190,100]"));
    assert.ok(beats.some((b: { anchor_t: number; window_rect?: number[] }) => b.anchor_t >= 6 && b.window_rect === undefined));
    assert.ok(existsSync(join(dir, "out", "t1.mp4")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI rejects malformed --max-tokens values", async () => {
  const error = console.error;
  const messages: string[] = [];
  console.error = (s: string) => { messages.push(s); };
  try {
    for (const value of ["banana", "Infinity", "0"]) {
      assert.equal(await main(["make", "missing", "--max-tokens", value]), 2);
      assert.match(messages.at(-1)!, /positive integer/);
    }
  } finally {
    console.error = error;
  }
});

test("without a credential the run falls back loudly and records planner.mode fallback", async () => {
  const dir = newTake();
  try {
    const warns: string[] = [];
    const r = await fastTake(dir, { apiKey: null, log: () => {}, warn: (s) => warns.push(s) });
    assert.ok(warns.join("\n").includes("AI planner is OFF"), `no fallback banner: ${warns.join("\n")}`);
    assert.ok(r.decisions.every((d) => d.decided_by === "heuristic"));
    const take = JSON.parse(readFileSync(join(dir, "take.json"), "utf8")) as TakeMeta;
    assert.equal(take.planner?.mode, "fallback");
    assert.deepEqual(r.planner, { input_tokens: 0, output_tokens: 0, usd: 0, failed: 0, requests: 0, cached: 0, request_tokens: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("key moment is asked on every beat even without --goal", async () => {
  const dir = newTake();
  try {
    const bodies: string[] = [];
    await fastTake(dir, {
      apiKey: KEY,
      log: () => {},
      warn: () => {},
      fetchImpl: (async (_url, init) => {
        const body = String(init?.body);
        bodies.push(...beatViews(body));
        return firstZoneReply(body);
      }) as typeof fetch,
    });
    assert.ok(bodies.length > 0);
    assert.ok(bodies.every((body) => Object.hasOwn(JSON.parse(body).questions, "key_moment")),
      "key_moment asked without --goal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt planner.json fails fast instead of falling back silently", async () => {
  const dir = newTake();
  try {
    const configDir = join(dir, "test-config");
    mkdirSync(join(configDir, "takeone"), { recursive: true });
    writeFileSync(join(configDir, "takeone", "planner.json"), "{not json");
    await assert.rejects(
      fastTake(dir, { log: () => {}, warn: () => {} }),
      (e: unknown) => e instanceof ConfigError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a saved installed-CLI planner config loads instead of failing the account guard", () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-cli-config-"));
  try {
    const configDir = join(dir, "test-config");
    mkdirSync(join(configDir, "takeone"), { recursive: true });
    const cases = [
      { backend: "codex", account: "installed-codex", bin: "/usr/bin/codex" },
    ] as const;
    for (const { backend, account, bin } of cases) {
      writeFileSync(join(configDir, "takeone", "planner.json"), JSON.stringify({ backend, auth: "account", account, bin, model: "fixture-model" }));
      const loaded = loadPlannerConfig({ configDir });
      assert.equal(loaded.defaulted, false, `${backend} config read as defaulted`);
      assert.equal(loaded.config.backend, backend);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a planner.json whose wrong account name is rejected as user error", () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-cli-config-"));
  try {
    const configDir = join(dir, "test-config");
    mkdirSync(join(configDir, "takeone"), { recursive: true });
    writeFileSync(join(configDir, "takeone", "planner.json"), JSON.stringify({ backend: "codex", auth: "account", account: "installed-claude", bin: "/usr/bin/codex", model: "fixture-model" }));
    assert.throws(() => loadPlannerConfig({ configDir }), (e: unknown) => e instanceof ConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a signed-in CLI probe that cannot run leaves the planner on local rules instead of failing the take", async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-cli-probe-"));
  try {
    const configDir = join(dir, "config");
    const binDir = join(dir, "bin");
    mkdirSync(join(configDir, "takeone"), { recursive: true });
    mkdirSync(binDir);
    const claude = join(binDir, "claude");
    writeFileSync(claude, "#!/bin/sh\nexit 9\n");
    chmodSync(claude, 0o755);
    writeFileSync(join(configDir, "takeone", "cli-accounts"), "not a directory");
    const empty = { get: async () => null, set: async () => {}, delete: async () => {} };
    const resolved = await resolvePlanner({
      configDir,
      probe: true,
      env: { HOME: dir, XDG_CONFIG_HOME: configDir, PATH: binDir, TAKEONE_NO_KEYRING: "1" },
      store: empty as unknown as Keystore,
    });
    assert.equal(resolved.config.backend, "jev");
    assert.equal(resolved.defaulted, true);
    assert.equal(resolved.active, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a signed-in CLI found through a relative PATH entry is still offered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-cli-relative-"));
  try {
    const configDir = join(dir, "config");
    const binDir = join(dir, "bin");
    mkdirSync(join(configDir, "takeone"), { recursive: true });
    mkdirSync(binDir);
    const claude = join(binDir, "claude");
    writeFileSync(claude, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("auth") && args.includes("status")) {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }) + "\\n");
  process.exit(0);
}
process.exit(2);
`);
    chmodSync(claude, 0o755);
    const empty = { get: async () => null, set: async () => {}, delete: async () => {} };
    const resolved = await resolvePlanner({
      configDir,
      env: { HOME: dir, XDG_CONFIG_HOME: configDir, PATH: relative(process.cwd(), binDir), TAKEONE_NO_KEYRING: "1" },
      store: empty as unknown as Keystore,
    });
    assert.equal(resolved.defaulted, true);
    assert.equal(resolved.config.backend, "claude-code", resolved.refusal ?? "no discovered account");
    assert.equal(resolved.active, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fake installed Claude that answers its own `auth status` with the given
 * sign-in method, as the real CLI does, and answers the planner's own ask with
 * `askExit` (nonzero = the account will not answer). takeone never spawns this
 * binary itself: BYOKit runs it, both to read the sign-in and to ask. */
function fakeClaude(binDir: string, auth: { authMethod: string; apiProvider: string }, askExit = 0, askStdout = ""): void {
  const claude = join(binDir, "claude");
  writeFileSync(claude, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("auth") && args.includes("status")) {
  process.stdout.write(JSON.stringify({ loggedIn: true, ...${JSON.stringify(auth)} }) + "\\n");
  process.exit(0);
}
if (args.includes("-p")) {
  let stdin = "";
  process.stdin.on("data", (d) => { stdin += d; });
  process.stdin.on("end", () => {
    if (${JSON.stringify(askStdout)}) process.stdout.write(${JSON.stringify(askStdout)} + "\\n");
    process.exit(${askExit});
  });
  return;
}
process.exit(2);
`);
  chmodSync(claude, 0o755);
}

/** An isolated home, config dir and PATH holding only the fakes above. */
function cliHome(dir: string): { configDir: string; binDir: string; env: NodeJS.ProcessEnv } {
  const configDir = join(dir, "config");
  const binDir = join(dir, "bin");
  mkdirSync(join(configDir, "takeone"), { recursive: true });
  mkdirSync(binDir);
  return { configDir, binDir, env: { HOME: dir, XDG_CONFIG_HOME: configDir, PATH: binDir, TAKEONE_NO_KEYRING: "1" } };
}

test("a Claude login that is an API key or a cloud route is passed over for the stored key, and says so", async () => {
  // The kit reads `authMethod` off the CLI's own status command: only
  // claude.ai is a subscription takeone can ask with.
  for (const [auth, wording] of [
    [{ authMethod: "api_key", apiProvider: "firstParty" }, /signed in with an API key/],
    [{ authMethod: "bedrock", apiProvider: "amazon-bedrock" }, /Bedrock, Vertex/],
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), "takeone-cli-method-"));
    try {
      const { configDir, binDir, env } = cliHome(dir);
      fakeClaude(binDir, auth);
      const keys = { get: async () => KEY, set: async () => {}, delete: async () => {} };
      const resolved = await resolvePlanner({ configDir, env, store: keys as unknown as Keystore });
      assert.equal(resolved.defaulted, true);
      // The unusable account is not offered, and the stored key is reused.
      assert.equal(resolved.config.backend, "jev", resolved.skipped ?? "no skipped reason");
      assert.equal(resolved.active, true, resolved.refusal ?? "stored key not reused");
      assert.equal(resolved.key, KEY);
      // The passed-over sign-in is said out loud, never swallowed.
      assert.match(resolved.skipped ?? "", wording);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a signed-in Claude CLI that refuses the ask stops the run instead of falling back per beat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-cli-refuse-"));
  try {
    const { configDir, binDir, env } = cliHome(dir);
    // A Claude subscription sign-in discovery accepts, whose ask then refuses.
    fakeClaude(binDir, { authMethod: "claude.ai", apiProvider: "firstParty" }, 1);
    const empty = { get: async () => null, set: async () => {}, delete: async () => {} };
    const planner = await resolvePlanner({ configDir, env, store: empty as unknown as Keystore });
    assert.equal(planner.config.backend, "claude-code", planner.refusal ?? "no discovered account");
    await assert.rejects(
      askChunk({ secret: "x" }, { focus: { kind: "choice", options: { a: "Zone A" } } } as never, planner, new Map() as never, { timeoutMs: 5000 }),
      (e: unknown) => {
        assert.ok(e instanceof PlannerUnavailable, `not a stop: ${String(e)}`);
        // The stop names the CLI, its sign-in and the check the user can run.
        assert.match(e.message, /claude could not answer/);
        assert.match(e.message, /Claude subscription sign-in/);
        assert.match(e.message, /claude auth status/);
        assert.match(e.message, /--no-ai/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Claude CLI that answers in the wrong shape falls back per beat instead of stopping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-cli-badreply-"));
  try {
    const { configDir, binDir, env } = cliHome(dir);
    // The kit reports this one as `bad_reply`, apart from a refusal: the beats
    // keep their heuristics and the film still renders.
    fakeClaude(binDir, { authMethod: "claude.ai", apiProvider: "firstParty" }, 0, "not json at all");
    const empty = { get: async () => null, set: async () => {}, delete: async () => {} };
    const planner = await resolvePlanner({ configDir, env, store: empty as unknown as Keystore });
    assert.equal(planner.config.backend, "claude-code", planner.refusal ?? "no discovered account");
    const outcome = await askChunk({ secret: "x" }, { focus: { kind: "choice", options: { a: "Zone A" } } } as never, planner, new Map() as never, { timeoutMs: 5000 });
    assert.equal(outcome.decisionSource, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a saved installed-CLI account whose state folder cannot be created is refused, not thrown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-cli-unusable-"));
  try {
    const configDir = join(dir, "config");
    mkdirSync(join(configDir, "takeone"), { recursive: true });
    writeFileSync(join(configDir, "takeone", "cli-accounts"), "not a directory");
    writeFileSync(join(configDir, "takeone", "planner.json"), JSON.stringify({ backend: "codex", auth: "account", account: "installed-codex", bin: join(dir, "bin", "codex") }));
    const empty = { get: async () => null, set: async () => {}, delete: async () => {} };
    const resolved = await resolvePlanner({
      configDir,
      probe: true,
      env: { HOME: dir, XDG_CONFIG_HOME: configDir, PATH: join(dir, "bin"), TAKEONE_NO_KEYRING: "1" },
      store: empty as unknown as Keystore,
    });
    assert.equal(resolved.defaulted, false);
    assert.equal(resolved.active, false);
    assert.match(resolved.refusal ?? "", /installed Codex CLI account could not be started/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a provider with no known price shows cost unknown, never $0", async () => {
  const dir = newTake();
  try {
    const configDir = join(dir, "test-config");
    mkdirSync(join(configDir, "takeone"), { recursive: true });
    writeFileSync(join(configDir, "takeone", "planner.json"), JSON.stringify({
      backend: "anthropic", auth: "apiKey", model: "claude-opus-5-5",
    }));
    const lines: string[] = [];
    const r = await fastTake(dir, { apiKey: KEY, planOnly: true, log: (l) => lines.push(l), warn: () => {} });
    assert.equal(r.planned.usd, null);
    assert.ok(lines.some((l) => l.includes("cost unknown")), lines.join("\n"));
    assert.ok(!lines.some((l) => /\$0\.0+\b/.test(l)), lines.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a planner request that fails says why: the reply shape, not just a failed count", async () => {
  const dir = newTake();
  try {
    const configDir = join(dir, "test-config");
    mkdirSync(join(configDir, "takeone"), { recursive: true });
    writeFileSync(join(configDir, "takeone", "planner.json"), JSON.stringify({ backend: "minimax", auth: "apiKey", model: "MiniMax-M3.1-Flash-Preview" }));
    // A reply that spent its budget thinking and never called the decisions tool.
    const fetchImpl = (async () => new Response(JSON.stringify({
      stop_reason: "max_tokens",
      content: [{ type: "thinking", thinking: "private model text" }],
      usage: { input_tokens: 10, output_tokens: 1024 },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const warns: string[] = [];
    const r = await fastTake(dir, { apiKey: KEY, fetchImpl, log: () => {}, warn: (s) => warns.push(s) });
    assert.ok(r.planner.failed > 0);
    const why = warns.filter((w) => w.startsWith("planner: a ") && w.includes("failed:")).join("\n");
    assert.ok(why.includes("stop_reason max_tokens"), why || warns.join("\n"));
    assert.ok(why.includes("content [thinking]"), why);
    assert.ok(!why.includes("private model text") && !why.includes(KEY), "no model text or key in the reason");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a MiniMax ask gets an output budget big enough for its reasoning plus the decisions", async () => {
  const dir = newTake();
  try {
    const configDir = join(dir, "test-config");
    mkdirSync(join(configDir, "takeone"), { recursive: true });
    writeFileSync(join(configDir, "takeone", "planner.json"), JSON.stringify({ backend: "minimax", auth: "apiKey", model: "MiniMax-M3.1-Flash-Preview" }));
    const caps: number[] = [];
    const fetchImpl = (async (_url, init) => {
      caps.push(JSON.parse(String(init?.body)).max_tokens as number);
      return new Response("limited", { status: 429 });
    }) as typeof fetch;
    await assert.rejects(fastTake(dir, { apiKey: KEY, fetchImpl, log: () => {}, warn: () => {} }));
    assert.ok(caps.length > 0 && caps.every((n) => n >= 8192), `max_tokens sent: ${caps.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a MiniMax reply that takes longer than the default 30 s is waited for", async () => {
  const dir = newTake();
  try {
    const configDir = join(dir, "test-config");
    mkdirSync(join(configDir, "takeone"), { recursive: true });
    writeFileSync(join(configDir, "takeone", "planner.json"), JSON.stringify({ backend: "minimax", auth: "apiKey", model: "MiniMax-M3.1-Flash-Preview" }));
    let first = true;
    const fetchImpl = (async (_url, init) => {
      if (first) {
        first = false;
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 31_000);
          init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted at the default timeout")); });
        });
      }
      return new Response("limited", { status: 429 });
    }) as typeof fetch;
    // The slow first reply survives the wait; the 429 after it is then the stop, not "timed out".
    await assert.rejects(fastTake(dir, { apiKey: KEY, fetchImpl, log: () => {}, warn: () => {} }), (e: unknown) => !/timed out/.test(String(e)) && /rate limited|429/.test(String(e)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A MiniMax Messages reply answering every asked question; `broken` loses one yes/no field the way a real reply did ("false": ""). */
function minimaxReply(body: string, broken: boolean): Response {
  const { questions } = JSON.parse(JSON.parse(body).messages[0].content[0].text) as { questions: Record<string, { kind: string; options?: Record<string, unknown>; levels?: string[] }> };
  const input = Object.fromEntries(Object.entries(questions).flatMap(([name, q]) => {
    if (q.kind === "choice") {
      const options = Object.keys(q.options ?? {});
      return [[name, { pick: options[0], probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.9 : 0.1 / Math.max(1, options.length - 1)])), rationale: "first zone" }]];
    }
    if (q.kind === "score") {
      const levels = (q.levels ?? []).map((_, i) => String(i));
      return [[name, { pick: "1", probabilities: Object.fromEntries(levels.map((l) => [l, l === "1" ? 0.9 : 0.1 / Math.max(1, levels.length - 1)])), rationale: "middle level" }]];
    }
    if (q.kind === "yesno") return [[name, { pick: "false", probabilities: { false: 0.9, true: 0.1 }, rationale: "no" }]];
    return [];
  }));
  const name = Object.keys(questions).find((n) => questions[n]!.kind === "yesno");
  if (broken && name) input[name] = { pick: "false", probabilities: { false: "" as unknown as number, true: 0.4 }, rationale: "" };
  return new Response(JSON.stringify({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "decisions", input }], usage: { input_tokens: 500, output_tokens: 300 } }), { status: 200 });
}

test("MiniMax plans two beats a call and repairs a malformed reply with one more ask", async () => {
  const dir = buildTake(mkdtempSync(join(tmpdir(), "takeone-take-")));
  try {
    const configDir = join(dir, "test-config");
    mkdirSync(join(configDir, "takeone"), { recursive: true });
    writeFileSync(join(configDir, "takeone", "planner.json"), JSON.stringify({ backend: "minimax", auth: "apiKey", model: "MiniMax-M3.1-Flash-Preview" }));
    const beatCalls: string[][] = [];
    const seen = new Set<string>();
    const fetchImpl = (async (_url, init) => {
      const body = String(init?.body);
      const names = Object.keys((JSON.parse(JSON.parse(body).messages[0].content[0].text) as { questions: object }).questions);
      if (!names.some((n) => /^b\d+_/.test(n))) return new Response(JSON.stringify({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "decisions", input: {} }] }), { status: 200 });
      beatCalls.push(names);
      const key = names.join(",");
      const first = !seen.has(key);
      seen.add(key);
      return minimaxReply(body, first); // the first ask of every chunk is malformed, the repair ask is good
    }) as typeof fetch;
    const r = await fastTake(dir, { apiKey: KEY, fetchImpl, film: false, log: () => {}, warn: () => {} });
    const beatsAsked = new Set(beatCalls.flat().map((n) => n.split("_")[0]));
    assert.ok(beatCalls.every((names) => new Set(names.map((n) => n.split("_")[0])).size <= 2), "at most two beats a call");
    assert.equal(beatCalls.length, seen.size * 2, "every chunk is asked once more after its malformed reply");
    assert.equal(r.decisions.filter((d) => d.decided_by === "ai").length, beatsAsked.size, "every asked beat is decided by the model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a chosen provider without its credential stops instead of falling back", async () => {
  const dir = newTake();
  const keyring = process.env.TAKEONE_NO_KEYRING;
  process.env.TAKEONE_NO_KEYRING = "1";
  try {
    const configDir = join(dir, "test-config");
    mkdirSync(join(configDir, "takeone"), { recursive: true });
    writeFileSync(join(configDir, "takeone", "planner.json"), JSON.stringify({
      backend: "opencode-go",
      auth: "account",
      model: "opencode-go/muse-spark-1.3-contributor",
    }));
    await assert.rejects(
      fastTake(dir, { apiKey: undefined, log: () => {}, warn: () => {} }),
      (e: unknown) => {
        assert.ok(e instanceof PlannerUnavailable);
        assert.ok(e.message.includes("opencode-go"), `provider not named: ${e.message}`);
        assert.ok(e.message.includes("--no-ai"), `fallback choice missing: ${e.message}`);
        return true;
      },
    );
    assert.ok(!existsSync(join(dir, "out", "t1.mp4")), "rendered despite PlannerUnavailable");
  } finally {
    if (keyring === undefined) delete process.env.TAKEONE_NO_KEYRING;
    else process.env.TAKEONE_NO_KEYRING = keyring;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a chosen pi planner that cannot run stops with pi's own check instead of falling back", async () => {
  const dir = newTake();
  try {
    const configDir = join(dir, "test-config");
    mkdirSync(join(configDir, "takeone"), { recursive: true });
    writeFileSync(join(configDir, "takeone", "planner.json"), JSON.stringify({
      backend: "pi", bin: join(dir, "no-such-pi"), model: "deepseek/deepseek-flash",
    }));
    await assert.rejects(
      fastTake(dir, { apiKey: undefined, log: () => {}, warn: () => {} }),
      (e: unknown) => {
        assert.ok(e instanceof PlannerUnavailable);
        assert.ok(e.message.includes("deepseek/deepseek-flash"), `model not named: ${e.message}`);
        assert.ok(e.message.includes("not installed at"), `missing pi not named: ${e.message}`);
        assert.ok(e.message.includes("--no-ai"), `fallback choice missing: ${e.message}`);
        return true;
      },
    );
    assert.ok(!existsSync(join(dir, "out", "t1.mp4")), "rendered despite PlannerUnavailable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rate-limited provider stops before render instead of falling back", async () => {
  const dir = newTake();
  try {
    const fetchImpl = (async () => new Response("limited", { status: 429 })) as typeof fetch;
    await assert.rejects(
      fastTake(dir, { apiKey: KEY, fetchImpl, log: () => {}, warn: () => {} }),
      (e: unknown) => {
        assert.ok(e instanceof PlannerUnavailable);
        assert.ok(e.message.includes("jev"), `provider not named: ${e.message}`);
        assert.ok(e.message.includes("--no-ai"), `fallback choice missing: ${e.message}`);
        assert.ok(e.message.includes("takeone key set"), `switch choice missing: ${e.message}`);
        return true;
      },
    );
    assert.ok(!existsSync(join(dir, "out", "t1.mp4")), "rendered despite PlannerUnavailable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unauthorized provider stops before render instead of falling back", async () => {
  const dir = newTake();
  try {
    const fetchImpl = (async () => new Response("no", { status: 401 })) as typeof fetch;
    await assert.rejects(
      fastTake(dir, { apiKey: KEY, fetchImpl, log: () => {}, warn: () => {} }),
      (e: unknown) => e instanceof PlannerUnavailable && /--no-ai/.test(e.message),
    );
    assert.ok(!existsSync(join(dir, "out", "t1.mp4")), "rendered despite PlannerUnavailable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a forbidden provider stops before render instead of falling back", async () => {
  const dir = newTake();
  try {
    const fetchImpl = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
    await assert.rejects(
      fastTake(dir, { apiKey: KEY, fetchImpl, log: () => {}, warn: () => {} }),
      (e: unknown) => e instanceof PlannerUnavailable && /--no-ai/.test(e.message),
    );
    assert.ok(!existsSync(join(dir, "out", "t1.mp4")), "rendered despite PlannerUnavailable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--replan ignores saved answers and asks again", async () => {
  const dir = newTake();
  try {
    let calls = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      return firstZoneReply(String(init?.body));
    }) as typeof fetch;
    await fastTake(dir, { apiKey: KEY, fetchImpl, log: () => {}, warn: () => {} });
    const afterFirst = calls;
    assert.ok(afterFirst > 0);
    await fastTake(dir, { apiKey: KEY, fetchImpl, log: () => {}, warn: () => {} });
    assert.equal(calls, afterFirst, "second run should be all cache hits");
    await fastTake(dir, { apiKey: KEY, fetchImpl, replan: true, log: () => {}, warn: () => {} });
    assert.ok(calls > afterFirst, "replan asked again instead of hitting the cache");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("per-beat camera answers reach plan.json and the camera; a user edit in plan.json wins", async () => {
  const dir = newLongTake();
  // A smaller output than the 320x180 source, so a shot can zoom: at source size every shot frames the whole screen.
  const camera = { ...FAST, out_w: 160, out_h: 90 };
  try {
    // The planner says no shot and no follow on every beat, and a breathe on idle.
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      // new_subject is yes: below 0.35 the solver holds the shot, and the shot answer would not show.
      const answers = chunkAnswers(String(init?.body), (names) => ({
        ...firstZoneAnswers(names), new_subject: { noul: 0.9 }, shot: { noul: 0.1 }, idle: { noul: 0.9 }, follow: { noul: 0.1 },
      }));
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 800 } }), { status: 200 });
    }) as typeof fetch;
    const first = await fastTake(dir, { camera, apiKey: KEY, fetchImpl, log: () => {}, warn: () => {} });
    const readPlanFile = (): Plan => JSON.parse(readFileSync(join(dir, "analysis", "plan.json"), "utf8")) as Plan;
    const asked = readPlanFile().beats.filter((b) => b.shot?.by === "ai");
    assert.ok(asked.length > 0, "no beat took the planner's camera answers");
    assert.ok(asked.every((b) => b.shot?.value === false && b.idle?.value === true && b.follow?.value === false),
      JSON.stringify(asked));
    const zoomedFrames = (json: string): number => {
      const frames = JSON.parse(json) as { w: number }[];
      const full = Math.max(...frames.map((f) => f.w));
      return frames.filter((f) => f.w < full).length;
    };
    const aiZoomed = zoomedFrames(readFileSync(join(dir, "camera.json"), "utf8"));

    const baseline = readPlanFile();
    // A user shot on every beat is preserved in plan.json even while make
    // refuses the beats that cannot take one.
    writeFileSync(join(dir, "analysis", "plan.json"), JSON.stringify({ version: 2,
      beats: baseline.beats.map((b) => ({ ...b, shot: { value: true, by: "user" } })) }));
    await assert.rejects(fastTake(dir, { camera, apiKey: KEY, fetchImpl, log: () => {}, warn: () => {} }),
      /analysis\/plan\.json: beat b\d+ \([a-z]+\): shot=true cannot be honoured/);
    assert.ok(readPlanFile().beats.every((b) => b.shot?.by === "user" && b.shot.value === true), "make overwrote the user's edit");

    // The user keeps the shot by hand on every beat that can take one (a
    // scroll beat never gets a camera move and now refuses shot=true): the
    // render follows it, and a rerun of make keeps it.
    const clickIds = new Set(first.beats.filter((b) => b.kind === "click").map((b) => b.id));
    assert.ok(clickIds.size > 0, "the take has no click beat to edit");
    const userPlan: Plan = { version: 2, beats: baseline.beats.map((b) =>
      clickIds.has(b.id) ? { ...b, shot: { value: true, by: "user" } } : b) };
    writeFileSync(join(dir, "analysis", "plan.json"), JSON.stringify(userPlan));
    await renderTake(dir, camera);
    const userZoomed = zoomedFrames(readFileSync(join(dir, "camera.json"), "utf8"));
    assert.ok(userZoomed > aiZoomed, `the user's shot edit did not zoom the camera (${aiZoomed} zoomed frames before, ${userZoomed} after)`);
    await fastTake(dir, { camera, apiKey: KEY, fetchImpl, log: () => {}, warn: () => {} });
    assert.ok(readPlanFile().beats.every((b) => {
      const written = userPlan.beats.find((u) => u.id === b.id)!;
      return clickIds.has(b.id)
        ? b.shot?.by === "user" && b.shot.value === true
        : b.shot?.value === written.shot?.value;
    }), "make overwrote the user's edit or changed a beat the user left alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a user shot=false in plan.json removes the camera zoom the planner gave every beat", async () => {
  const dir = newLongTake();
  const camera = { ...FAST, out_w: 160, out_h: 90 };
  try {
    // The planner asks for a shot on every beat: the camera zooms on the clicks.
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const answers = chunkAnswers(String(init?.body), (names) => ({
        ...firstZoneAnswers(names), new_subject: { noul: 0.9 }, shot: { noul: 0.9 }, idle: { noul: 0.1 }, follow: { noul: 0.1 },
      }));
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 800 } }), { status: 200 });
    }) as typeof fetch;
    await fastTake(dir, { camera, apiKey: KEY, fetchImpl, log: () => {}, warn: () => {} });
    const readPlanFile = (): Plan => JSON.parse(readFileSync(join(dir, "analysis", "plan.json"), "utf8")) as Plan;
    assert.ok(readPlanFile().beats.some((b) => b.shot?.value === true && b.shot.by === "ai"), "the planner asked for no shot");
    const zoomedFrames = (json: string): number => {
      const frames = JSON.parse(json) as { w: number }[];
      const full = Math.max(...frames.map((f) => f.w));
      return frames.filter((f) => f.w < full - 0.5).length; // a settled frame can sit a float under full
    };
    const aiZoomed = zoomedFrames(readFileSync(join(dir, "camera.json"), "utf8"));
    assert.ok(aiZoomed > 0, "the planner's shots did not zoom the camera, so the test proves nothing");

    // The user takes every shot away: the render follows it and no beat zooms.
    const userPlan: Plan = { version: 2, beats: readPlanFile().beats.map((b) => ({ ...b, shot: { value: false, by: "user" } })) };
    writeFileSync(join(dir, "analysis", "plan.json"), JSON.stringify(userPlan));
    await renderTake(dir, camera);
    const userZoomed = zoomedFrames(readFileSync(join(dir, "camera.json"), "utf8"));
    assert.equal(userZoomed, 0, `a user shot=false still zoomed the camera (${aiZoomed} zoomed frames before, ${userZoomed} after)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One take with a click, a pointer-only travel, a scroll, typing, a hard cut
 * and an idle gap, so every plan value the render cannot honour has a beat. */
function buildKindsTake(dir: string): string {
  execFileSync("ffmpeg", [
    "-nostdin", "-f", "lavfi", "-i", `color=c=gray:s=${STREAM_W}x${STREAM_H}:d=9:r=30`,
    "-f", "lavfi", "-i", `color=c=white:s=${STREAM_W}x${STREAM_H}:d=4:r=30`,
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0",
    "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska", "-frames:v", "390", "-y", join(dir, "screen.webm"),
  ], { stdio: "ignore" });
  writeFileSync(join(dir, "frames.tsv"), Array.from({ length: 390 }, (_, i) => `${i * 3000}\t${i * 33333333}`).join("\n") + "\n");
  writeFileSync(join(dir, "events.jsonl"), [
    { t: 100, k: "win", cls: "browser", title: "Board", rect: [0, 0, STREAM_W, STREAM_H] },
    { t: 300, k: "ptr", x: 200, y: 90 },
    { t: 500, k: "btn", b: "left", down: true }, { t: 560, k: "btn", b: "left", down: false },
    { t: 700, k: "ptr", x: 200, y: 90 }, { t: 1100, k: "ptr", x: 200, y: 90 }, { t: 1500, k: "ptr", x: 202, y: 90 },
    { t: 3000, k: "ptr", x: 40, y: 40 }, { t: 3500, k: "ptr", x: 150, y: 150 }, { t: 3900, k: "ptr", x: 280, y: 150 },
    ...Array.from({ length: 7 }, (_, i) => ({ t: 5500 + i * 150, k: "wheel", dx: 0, dy: 1 })),
    ...Array.from({ length: 10 }, (_, i) => ({ t: 7700 + i * 100, k: "key", cls: "char", down: i % 2 === 0 })),
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(dir, "take.json"), JSON.stringify({ id: "kinds", stream: { w: STREAM_W, h: STREAM_H }, scale: 1, offset_ms: 0, pointer: "hyprland" }));
  return dir;
}

test("a user edit follows its beat across a re-cut, is dropped when the cut removes it, and is refused when it names another beat", { skip: needsFfmpeg }, async () => {
  const dir = buildKindsTake(mkdtempSync(join(tmpdir(), "takeone-recut-")));
  const fast = ["out_w=160", "out_h=90", "preset=veryfast", "ripple_ms=0", "fade_s=0"];
  // --no-ai: this journey must never ask a model, and the plan edits are the point.
  const cli = (command: string, ...flags: string[]) => spawnSync(process.execPath,
    ["bin/takeone.mjs", command, dir, ...flags, ...fast.flatMap((value) => ["--set", value])],
    { encoding: "utf8", env: { ...process.env, TAKEONE_DIR: dir, TAKEONE_STATE_DIR: join(dir, "state") } });
  const planFile = join(dir, "analysis", "plan.json");
  const takeFile = join(dir, "take.json");
  const baseline = (): Plan => JSON.parse(readFileSync(planFile, "utf8")) as Plan;
  const writePlanFile = (plan: Plan) => writeFileSync(planFile, JSON.stringify(plan));
  const recut = (trim?: { start: number; end: number }) => {
    const meta = JSON.parse(readFileSync(takeFile, "utf8"));
    if (trim) meta.trim = trim;
    else delete meta.trim;
    writeFileSync(takeFile, JSON.stringify(meta));
    return cli("make", "--no-ai");
  };
  try {
    assert.equal(cli("make", "--no-ai").status, 0);
    // The user takes the shot off the typing beat by hand, as they would in the file.
    const before = baseline();
    const edited = before.beats.find((beat) => beat.id === "b4")!;
    const key = edited.key;
    edited.shot = { value: false, by: "user" };
    writePlanFile(before);

    // The take is re-cut: the head is trimmed away, so every later beat moves up
    // a place and the old b4 is now a different beat entirely.
    const moved = recut({ start: 6000, end: 13000 });
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(moved.stdout, new RegExp(`the user\\'s edit for beat b4 follows its beat to b\\d+ \\(key ${key}\\) - the cut moved it`));
    const after = baseline();
    const landed = after.beats.filter((beat) => beat.shot?.by === "user");
    assert.equal(landed.length, 1, JSON.stringify(after.beats));
    assert.equal(landed[0]!.key, key, "the edit did not follow its beat across the cut");
    assert.notEqual(landed[0]!.id, "b4", "the cut left the beat where it was, so this proves nothing");
    assert.deepEqual(after.dropped, [], JSON.stringify(after.dropped));

    // The cut takes the edited beat away: the edit is dropped and named, never
    // applied to whichever beat landed on its old place.
    const dropped = recut({ start: 0, end: 5000 });
    assert.equal(dropped.status, 0, dropped.stderr);
    assert.match(dropped.stdout, new RegExp(`the user\\'s shot edit for beat ${landed[0]!.id} is dropped - the take no longer has that beat \\(key ${key}\\)`));
    const gone = baseline();
    assert.equal(gone.beats.some((beat) => beat.shot?.by === "user"), false, "the dropped edit is still applied");
    assert.equal(gone.dropped?.[0]?.key, key);
    assert.equal(gone.dropped?.[0]?.shot?.by, "user");

    // A cut that keeps the beat again takes the edit back.
    const back = recut(undefined);
    assert.equal(back.status, 0, back.stderr);
    const restored = baseline();
    assert.equal(restored.beats.find((beat) => beat.id === "b4")?.shot?.by, "user", "the edit was not restored with its beat");
    assert.deepEqual(restored.dropped, []);

    // An entry that names one beat and carries another beat's key is refused:
    // the edit is never applied to the beat that owns the key.
    const swapped = baseline();
    const editedBeat = swapped.beats.find((beat) => beat.id === "b4")!;
    const other = swapped.beats.find((beat) => beat.id === "b1")!;
    const editedKey = editedBeat.key;
    editedBeat.key = other.key;
    other.key = editedKey;
    writePlanFile(swapped);
    const refused = cli("render");
    assert.equal(refused.status, 1, `a stale key rendered instead of refusing:\n${refused.stdout}${refused.stderr}`);
    assert.match(refused.stderr, /beat b4 \(type\): the edit was made for a different beat \(key \w+, but b4 is now \w+\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plan edits the render cannot honour stop the CLI with a clear error", { skip: needsFfmpeg }, async () => {
  const dir = buildKindsTake(mkdtempSync(join(tmpdir(), "takeone-kinds-")));
  const fast = ["out_w=160", "out_h=90", "preset=veryfast", "ripple_ms=0", "fade_s=0", "idle_speed=1"];
  // --no-ai: this journey must never ask a model, and the fallback rules are the point.
  const cli = (command: string) => spawnSync(process.execPath,
    ["bin/takeone.mjs", command, dir, "--no-ai", ...fast.flatMap((value) => ["--set", value])],
    { encoding: "utf8", env: { ...process.env, TAKEONE_DIR: dir, TAKEONE_STATE_DIR: join(dir, "state") } });
  const planFile = join(dir, "analysis", "plan.json");
  const baseline = (): Plan => JSON.parse(readFileSync(planFile, "utf8")) as Plan;
  const writePlanFile = (plan: Plan) => writeFileSync(planFile, JSON.stringify(plan));
  try {
    const made = cli("make");
    assert.equal(made.status, 0, made.stderr);
    assert.deepEqual(baseline().beats.map((b) => b.id), ["b1", "b2", "b3", "b4", "b5", "b6"]);
    // make keeps every user edit, including a refused one, so each case starts clean.
    const clean = JSON.stringify(baseline());

    // Every value the render cannot honour names the beat, its kind and the combination.
    const cases: [string, "shot" | "idle" | "follow", string][] = [
      ["b2", "shot", "travel"],
      ["b3", "shot", "scroll"],
      ["b1", "follow", "click"],
      ["b4", "follow", "type"],
      ["b3", "follow", "scroll"],
      ["b5", "follow", "cut"],
      ["b1", "idle", "click"],
    ];
    for (const [id, field, kind] of cases) {
      const plan = JSON.parse(clean) as Plan;
      plan.beats.find((beat) => beat.id === id)![field] = { value: true, by: "user" };
      writePlanFile(plan);
      const run = cli("make");
      assert.equal(run.status, 2, `${id}.${field}=true rendered instead of refusing:\n${run.stderr}`);
      assert.match(run.stderr, new RegExp(
        `takeone make: analysis/plan\\.json: beat ${id} \\(${kind}\\): ${field}=true cannot be honoured`));
    }

    // Values that match what these beats already do stay valid, and a supported
    // edit still renders: shot on the click, follow off it, shot off the scroll.
    const valid = JSON.parse(clean) as Plan;
    const click = valid.beats.find((beat) => beat.id === "b1")!;
    click.shot = { value: true, by: "user" };
    click.follow = { value: false, by: "user" };
    click.idle = { value: false, by: "user" };
    valid.beats.find((beat) => beat.id === "b3")!.shot = { value: false, by: "user" };
    writePlanFile(valid);
    const rendered = cli("make");
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.ok(existsSync(join(dir, "out", "kinds.mp4")), "a valid edited plan stopped rendering");
    const kept = baseline();
    assert.equal(kept.beats.find((beat) => beat.id === "b1")?.shot?.by, "user");

    // The Android tap fallback builds its own beats: no user edit reaches it.
    const meta = JSON.parse(readFileSync(join(dir, "take.json"), "utf8"));
    writeFileSync(join(dir, "take.json"), JSON.stringify({ ...meta, device: "android", planner: { ...meta.planner, mode: "fallback" } }));
    const android = JSON.parse(clean) as Plan;
    android.beats.find((beat) => beat.id === "b1")!.shot = { value: false, by: "user" };
    writePlanFile(android);
    const refused = cli("make");
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /beat b1 \(click\): shot cannot be honoured - this Android take renders the rule-only tap fallback/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("make accepts video-only missing events and silent recorded streams", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    for (const file of ["screen.webm", "frames.tsv", "events.jsonl"]) {
      const path = join(dir, file);
      const original = readFileSync(path);
      rmSync(path);
      await assert.rejects(fastTake(dir, { noAi: true, log: () => {}, warn: () => {} }), (e: unknown) => e instanceof TakeInputError && e.file === file);
      writeFileSync(path, original);
    }
    const eventsPath = join(dir, "events.jsonl");
    const take = JSON.parse(readFileSync(join(dir, "take.json"), "utf8"));
    take.events = "on";
    writeFileSync(join(dir, "take.json"), JSON.stringify(take));
    writeFileSync(eventsPath, "not-json\n");
    await assert.rejects(makeTake(dir, { noAi: true, log: () => {}, warn: () => {} }), (e: unknown) => e instanceof TakeInputError && e.file === "events.jsonl");
    writeFileSync(eventsPath, "");
    const silent = await makeTake(dir, { noAi: true, log: () => {}, warn: () => {} });
    assert.ok(silent.beats.length > 0);
    take.events = "none";
    take.trim = { start: 1000, end: 9000 };
    writeFileSync(join(dir, "take.json"), JSON.stringify(take));
    const result = await fastTake(dir, { noAi: true, log: () => {}, warn: () => {} });
    assert.equal(result.planner.input_tokens, 0);
    assert.deepEqual(result.beats.map((b) => [b.kind, b.t0, b.t1]), [["idle", 1000, 9000]]);
    assert.equal(result.decisions[0]?.decided_by, "heuristic");
    rmSync(eventsPath);
    const missing = await makeTake(dir, { noAi: true, log: () => {}, warn: () => {} });
    assert.deepEqual(missing.beats, result.beats);
    assert.deepEqual(missing.decisions, result.decisions);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("make intersects trim with available video before rendering", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    const framesPath = join(dir, "frames.tsv");
    const lines = readFileSync(framesPath, "utf8").trimEnd().split("\n");
    lines[0] = `90000\t${lines[0]!.split("\t")[1]}`;
    writeFileSync(framesPath, lines.join("\n") + "\n");
    const meta = JSON.parse(readFileSync(join(dir, "take.json"), "utf8"));
    meta.trim = { start: 0, end: 9000 };
    writeFileSync(join(dir, "take.json"), JSON.stringify(meta));
    await fastTake(dir, { noAi: true, log: () => {}, warn: () => {} });
    const saved = JSON.parse(readFileSync(join(dir, "take.json"), "utf8"));
    const beats = JSON.parse(readFileSync(join(dir, "analysis", "beats.json"), "utf8"));
    assert.equal(saved.trim_start, 0);
    assert.equal(saved.trim_end, 8);
    assert.ok(beats.every((b: { t0: number; t1: number; anchor_t: number }) => b.t0 >= 0 && b.anchor_t >= 0 && b.t1 <= 8));
    assert.ok(existsSync(join(dir, "out", "t1.mp4")));
    // An end an earlier run recorded must not survive a re-make once the
    // caller's trim is gone, or the export stays truncated at the stale bound.
    const remade = JSON.parse(readFileSync(join(dir, "take.json"), "utf8"));
    delete remade.trim;
    writeFileSync(join(dir, "take.json"), JSON.stringify(remade));
    const rerun = await fastTake(dir, { noAi: true, log: () => {}, warn: () => {} });
    assert.equal(JSON.parse(readFileSync(join(dir, "take.json"), "utf8")).trim_end, undefined);
    assert.ok(rerun.seconds < 8, `stale trim_end still bounded the export at ${rerun.seconds}s`);

    // record.ts's own trim ends at the recording length it measured, so it
    // bounds nothing: honouring it would export the dead tail past the result.
    writeFileSync(join(dir, "take.json"), JSON.stringify({
      ...remade, auto_trim: true, duration_ms: 9000, trim: { start: 0, end: 9000 },
    }));
    await fastTake(dir, { noAi: true, log: () => {}, warn: () => {} });
    const auto = JSON.parse(readFileSync(join(dir, "take.json"), "utf8"));
    assert.equal(auto.duration, 10);
    assert.equal(auto.trim_end, undefined);
    const lastActivity = Math.max(...JSON.parse(readFileSync(join(dir, "analysis", "beats.json"), "utf8"))
      .flatMap((b: { t1: number }) => [b.t1]));
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", join(dir, "out", "t1.mp4")], { encoding: "utf8" }));
    const seconds = Number(probe.format.duration);
    assert.ok(seconds <= lastActivity + DEFAULTS.outro_s + 0.5,
      `export ran ${seconds}s, past the last activity at ${lastActivity}s plus the outro`);
    assert.ok(seconds < 9, `export kept the recorder's dead tail: ${seconds}s of a 10s take`);

    // record's own trim, then the operator edits that end: the edited value no
    // longer matches what record measured, so it is the caller's and is honoured.
    writeFileSync(join(dir, "take.json"), JSON.stringify({
      ...remade, auto_trim: true, duration_ms: 11000, trim: { start: 1500, end: 10000 },
    }));
    await fastTake(dir, { noAi: true, log: () => {}, warn: () => {} });
    const collision = JSON.parse(readFileSync(join(dir, "take.json"), "utf8"));
    assert.equal(collision.trim_end, 9, "an end the operator edited away from record's must be honoured");

    // A take recorded before the marker existed carries record's own trim with
    // no provenance: its end is the capture length, a fraction short of the
    // muxed video's. Honouring it would put the dead tail back.
    writeFileSync(join(dir, "take.json"), JSON.stringify({
      ...remade, auto_trim: undefined, duration_ms: undefined, trim: { start: 0, end: 10900 },
    }));
    await fastTake(dir, { noAi: true, log: () => {}, warn: () => {} });
    const legacy = JSON.parse(readFileSync(join(dir, "take.json"), "utf8"));
    assert.equal(legacy.trim_end, undefined, "an unmarked trim at the capture length must not bound the export");
    const legacySeconds = Number((JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
      "-of", "json", join(dir, "out", "t1.mp4")], { encoding: "utf8" }))).format.duration);
    assert.ok(legacySeconds <= seconds + 0.5,
      `pre-marker take exported ${legacySeconds}s, past the result instead of closing on it`);

    // Same capture length, but the analysis timeline rounded it down instead of
    // up: record's trim still owns that end, so the dead tail stays trimmed.
    writeFileSync(join(dir, "take.json"), JSON.stringify({
      ...remade, auto_trim: undefined, duration_ms: undefined, trim: { start: 0, end: 11100 },
    }));
    await fastTake(dir, { noAi: true, log: () => {}, warn: () => {} });
    const rounded = JSON.parse(readFileSync(join(dir, "take.json"), "utf8"));
    assert.equal(rounded.trim_end, undefined,
      "a pre-marker trim within one analysis frame of the video end must not bound the export");
    const roundedSeconds = Number((JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
      "-of", "json", join(dir, "out", "t1.mp4")], { encoding: "utf8" }))).format.duration);
    assert.ok(roundedSeconds <= seconds + 0.5,
      `pre-marker take exported ${roundedSeconds}s when the timeline rounded down`);

    // An unmarked trim that ends well inside the recording is the caller's.
    writeFileSync(join(dir, "take.json"), JSON.stringify({
      ...remade, auto_trim: undefined, duration_ms: undefined, trim: { start: 0, end: 6000 },
    }));
    await fastTake(dir, { noAi: true, log: () => {}, warn: () => {} });
    assert.equal(JSON.parse(readFileSync(join(dir, "take.json"), "utf8")).trim_end, 5,
      "an unmarked trim inside the recording must survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("make rejects trims with no video overlap before writing analysis", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    const framesPath = join(dir, "frames.tsv");
    const lines = readFileSync(framesPath, "utf8").trimEnd().split("\n");
    lines[0] = `90000\t${lines[0]!.split("\t")[1]}`;
    writeFileSync(framesPath, lines.join("\n") + "\n");
    const takePath = join(dir, "take.json");
    const original = JSON.parse(readFileSync(takePath, "utf8"));
    for (const trim of [{ start: 0, end: 500 }, { start: 12000, end: 13000 }]) {
      writeFileSync(takePath, JSON.stringify({ ...original, trim }));
      await assert.rejects(fastTake(dir, { noAi: true, log: () => {}, warn: () => {} }),
        (e: unknown) => e instanceof TakeInputError && e.file === "take.json" && /trim does not overlap video/.test(e.message));
      assert.ok(!existsSync(join(dir, "analysis")));
      assert.ok(!existsSync(join(dir, "out", "t1.mp4")));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid first frame clocks report frames.tsv before planning", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    for (const contents of ["", "oops\t0\n", "0\tbad\n"]) {
      writeFileSync(join(dir, "frames.tsv"), contents);
      await assert.rejects(fastTake(dir, { noAi: true, log: () => {}, warn: () => {} }), (e: unknown) => e instanceof TakeInputError && e.file === "frames.tsv" && /invalid first frame timestamp/.test(e.message));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("make --no-ai writes analysis files and heuristic decisions", async () => {
  const dir = newTake();
  try {
    const r = await fastTake(dir, { noAi: true, log: () => {}, warn: () => {} });
    assert.ok(existsSync(join(dir, "analysis", "regions.json")));
    assert.ok(existsSync(join(dir, "analysis", "actions.json")));
    assert.ok(existsSync(join(dir, "analysis", "beats.json")));
    assert.ok(existsSync(join(dir, "analysis", "decisions.jsonl")));
    assert.equal(r.decisions.length, r.beats.length);
    assert.ok(r.beats.length >= 2, `expected several beats, got ${r.beats.length}`);
    for (const d of r.decisions) assert.equal(d.decided_by, "heuristic");
    for (const b of r.beats) {
      assert.ok(b.zones.length >= 1);
      assert.ok(b.zones.length <= 6);
      assert.ok(b.zones.some((z) => z.kind === "all"));
    }
    // take.json gains the planner accounting
    const take = JSON.parse(readFileSync(join(dir, "take.json"), "utf8")) as TakeMeta;
    assert.deepEqual(take.planner, { mode: "fallback", backend: null, model: null, input_tokens: 0, output_tokens: 0, usd: 0, failed: 0, requests: 0, cached: 0, request_tokens: 0, calls_per_min: 0, request_tokens_per_min: 0 });
    // events.jsonl titles stay local: nothing in the analysis files carries the title
    const allAnalysis =
      readFileSync(join(dir, "analysis", "beats.json"), "utf8") +
      readFileSync(join(dir, "analysis", "decisions.jsonl"), "utf8");
    assert.ok(!allAnalysis.includes("Quarterly report"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("perceived cuts enter actions and start cut beats", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    // mpeg4, not VP9: software VP9 stalls weak CI runners (see buildTake).
    // Only the cut beats and click actions are asserted, so the input codec
    // is incidental. Matroska muxer because stock webm allows only VP8/VP9/AV1.
    execFileSync("ffmpeg", [
      "-nostdin", "-f", "lavfi", "-i", "color=c=black:s=320x180:d=5:r=30",
      "-f", "lavfi", "-i", "color=c=white:s=320x180:d=5:r=30",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0", "-c:v", "mpeg4", "-q:v", "2",
      "-f", "matroska", "-y", join(dir, "screen.webm"),
    ], { stdio: "ignore" });
    const r = await fastTake(dir, { noAi: true, log: () => {}, warn: () => {} });
    const cuts = r.beats.filter((b) => b.kind === "cut");
    assert.ok(cuts.length > 0);
    assert.ok(cuts.some((b) => b.actions.some((a) => a.k === "cut")));
    const clicks = r.beats.filter((b) => b.actions.some((a) => a.k === "click"));
    assert.equal(clicks.length, 2);
    assert.ok(clicks[0]!.t0 < cuts[0]!.t0 && cuts[0]!.t0 < clicks[1]!.t0);
    assert.equal(cuts[0]!.window_cls, "chromium");
    const saved = JSON.parse(readFileSync(join(dir, "analysis", "actions.json"), "utf8"));
    assert.ok(saved.actions.some((a: { k: string }) => a.k === "cut"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("make with a key decides via the planner and accounts usage; cache hit costs zero calls", async () => {
  // Twelve asked beats: two chunk calls.
  const dir = newLongTake();
  try {
    let calls = 0;
    const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      return firstZoneReply(String(init?.body));
    }) as typeof fetch;
    const r1 = await fastTake(dir, { apiKey: KEY, fetchImpl: fake, log: () => {}, warn: () => {} });
    assert.ok(calls >= 2, `expected jev calls, got ${calls}`);
    const aiDecisions = r1.decisions.filter((d) => d.decided_by === "ai");
    assert.ok(aiDecisions.length >= 2);
    assert.equal(r1.planner.input_tokens, calls * 800);
    assert.ok(existsSync(join(dir, "analysis", "planner-cache.jsonl")));
    const callsAfterFirst = calls;

    // second run: identical requests, so every call is a cache hit
    const r2 = await fastTake(dir, { apiKey: KEY, fetchImpl: fake, log: () => {}, warn: () => {} });
    assert.equal(calls, callsAfterFirst);
    assert.equal(r2.planner.input_tokens, 0);
    assert.deepEqual(r2.decisions.map((d) => d.decided_by), r1.decisions.map((d) => d.decided_by));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the film call sets the look and ending; a --set key stays pinned", async () => {
  const dir = newLongTake();
  try {
    let filmRequest: { state: { style?: string; timeline: string[] }; questions: { ending: { criteria: Record<string, string> } } } | null = null;
    const r = await fastTake(dir, { apiKey: KEY, style: "calm", set: ["pace=0.9"], log: () => {}, warn: () => {}, fetchImpl: (async (_url, init) => {
      const body = String(init?.body);
      if (JSON.parse(body).state.current_shot !== undefined) return firstZoneReply(body);
      filmRequest = JSON.parse(body);
      const endings = Object.keys(filmRequest!.questions.ending.criteria);
      const last = endings.at(-1)!;
      const answers = {
        theme: { choice: "paper", probabilities: { midnight: 0, paper: 1, aurora: 0, mono: 0, sand: 0, editorial: 0 }, confidence: 1 },
        pace: { probabilities: [0, 0, 0, 1], confidence: 1 },
        opening: { choice: "straight", probabilities: { establish: 0, short: 0, straight: 1 }, confidence: 1 },
        camera_style: { choice: "calm", probabilities: { calm: 1, lively: 0 }, confidence: 1 },
        ending: { choice: last, probabilities: Object.fromEntries(endings.map((id) => [id, id === last ? 1 : 0])), confidence: 1 },
      };
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 500 } }), { status: 200 });
    }) as typeof fetch });
    assert.equal(filmRequest!.state.style, "calm");
    assert.ok(filmRequest!.state.timeline.length >= 2);
    const film = r.take.film!;
    assert.equal(film.theme, "paper");
    assert.equal(film.camera_path, "hold");
    assert.equal(film.establish_s, 0);
    assert.equal(film.pace, undefined);
    assert.deepEqual(film.by, { theme: "ai", opening: "ai", ending: "ai", camera_style: "ai" });
    assert.equal(film.title, undefined, "jev answers carry no text, so the film has no title");
    // The ending is the last beat; the take keeps the outro after it, clamped to the recording's end.
    const beats = JSON.parse(readFileSync(join(dir, "analysis", "beats.json"), "utf8")) as { id: string; t1: number }[];
    const end = beats.find((b) => b.id === film.end_beat)!;
    assert.equal(end.id, beats.at(-1)!.id);
    const saved = JSON.parse(readFileSync(join(dir, "take.json"), "utf8"));
    assert.ok(Math.abs(saved.trim_end - Math.min(saved.duration, end.t1 + DEFAULTS.outro_s)) < 1e-6, `trim_end ${saved.trim_end} for beat end ${end.t1}`);
    assert.equal(saved.film.theme, "paper");
    // A re-render reads the same look from take.json; a --set pin still wins over the film.
    assert.equal(resolveCamera(dir, []).accent, "#e2522f");
    assert.equal(resolveCamera(dir, []).pace, THEMES.paper.pace);
    assert.equal(resolveCamera(dir, ["pace=0.9"]).pace, 0.9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function filmEndingFetch(pickEnding: (endings: string[]) => string): typeof fetch {
  return (async (_url, init) => {
    const body = String(init?.body);
    if (JSON.parse(body).state.current_shot !== undefined) return firstZoneReply(body);
    const endings = Object.keys(JSON.parse(body).questions.ending.criteria);
    const choice = pickEnding(endings);
    const answers = { ...filmAnswers(), ending: { choice, probabilities: Object.fromEntries(endings.map((id) => [id, id === choice ? 1 : 0])), confidence: 1 } };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 500 } }), { status: 200 });
  }) as typeof fetch;
}

function setTakeFields(dir: string, fields: object): void {
  const take = JSON.parse(readFileSync(join(dir, "take.json"), "utf8"));
  writeFileSync(join(dir, "take.json"), JSON.stringify({ ...take, ...fields }));
}

test("a recorder-set trim end is never cut by the film ending", async () => {
  const dir = newLongTake();
  try {
    setTakeFields(dir, { trim: { start: 0, end: 24000 }, auto_trim: true, duration_ms: 24000 });
    const r = await fastTake(dir, { apiKey: KEY, log: () => {}, warn: () => {}, fetchImpl: filmEndingFetch((ends) => ends[0]!) });
    assert.equal(r.take.film?.end_beat, undefined);
    assert.equal(JSON.parse(readFileSync(join(dir, "take.json"), "utf8")).trim_end, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a user-set trim end is kept and the film ending does not replace it", async () => {
  const dir = newLongTake();
  try {
    setTakeFields(dir, { trim: { start: 0, end: 12000 } });
    const r = await fastTake(dir, { apiKey: KEY, log: () => {}, warn: () => {}, fetchImpl: filmEndingFetch((ends) => ends[0]!) });
    assert.equal(r.take.film?.end_beat, undefined);
    const trimEnd = JSON.parse(readFileSync(join(dir, "take.json"), "utf8")).trim_end;
    assert.ok(Math.abs(trimEnd - 12) < 0.15, `trim_end ${trimEnd}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Anthropic answers: the film's forced `decisions` tool input. Beat calls get no
 * answers, so the rules keep them. Text fields only come back on this wire shape. */
function anthropicFilmFetch(film: (timeline: string[]) => Record<string, unknown>): typeof fetch {
  return (async (_url, init) => {
    const { state } = JSON.parse(JSON.parse(String(init?.body)).messages[0].content[0].text) as { state: { timeline?: string[] } };
    const input = state.timeline === undefined ? {} : film(state.timeline);
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "decisions", input }], usage: { input_tokens: 500, output_tokens: 80 } }), { status: 200 });
  }) as typeof fetch;
}

test("the film's AI title and captions render; the take's own title and captions win", async () => {
  const dir = newLongTake();
  try {
    const fetchImpl = anthropicFilmFetch((timeline) => ({
      titled: {
        pick: "true", probabilities: { true: 1, false: 0 }, rationale: "the steps need naming",
        title: "Save a report",
        captions: [{ beat: timeline.at(-1)!.split(",")[0], text: "Open the File menu" }, { beat: "no-such-beat", text: "never shown" }],
      },
    }));
    mkdirSync(join(dir, "test-config", "takeone"), { recursive: true });
    writeFileSync(join(dir, "test-config", "takeone", "planner.json"), JSON.stringify({ backend: "anthropic", auth: "apiKey", model: "claude-opus-5-5" }));
    const r = await fastTake(dir, { apiKey: KEY, fetchImpl, log: () => {}, warn: () => {} });
    assert.equal(r.take.film?.by.titled, "ai");
    assert.equal(r.take.film?.title, "Save a report");
    assert.deepEqual(r.take.film?.captions?.map((c) => c.text), ["Open the File menu"]);
    // The caption starts on the take's clock: the captioned beat's video-relative start.
    const beats = JSON.parse(readFileSync(join(dir, "analysis", "beats.json"), "utf8")) as { id: string; t0: number }[];
    const caption = r.take.film!.captions![0]!;
    assert.equal(caption.t, beats.at(-1)!.t0, `caption t ${caption.t} is not the captioned beat's start ${beats.at(-1)!.t0}`);
    // Its length is reading time on the output clock, not the beat's video-clock span.
    assert.equal(caption.d, 3, `caption d ${caption.d} is not the 3 s reading time`);
    const ass = readFileSync(join(dir, "captions.ass"), "utf8");
    assert.ok(ass.includes("Save a report") && ass.includes("Open the File menu"), "AI title or caption not drawn");
    assert.ok(!ass.includes("never shown"), "caption for a beat outside the timeline was drawn");

    // The take's own title replaces the film's on the next render; the film keeps its text.
    setTakeFields(dir, { title: "My demo" });
    await fastTake(dir, { apiKey: KEY, fetchImpl, log: () => {}, warn: () => {} });
    const own = readFileSync(join(dir, "captions.ass"), "utf8");
    assert.ok(own.includes("My demo") && !own.includes("Save a report"), "take title did not win");
    assert.ok(own.includes("Open the File menu"), "film caption dropped when the take sets a title");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A film answer carrying this AI title and one caption for the first timeline beat. */
function titled(title: string): typeof fetch {
  return anthropicFilmFetch((timeline) => ({
    titled: { pick: "true", probabilities: { true: 1, false: 0 }, rationale: "the steps need naming", title,
      captions: [{ beat: timeline[0]!.split(",")[0], text: "Open the File menu" }] },
  }));
}

/** The take with an Anthropic planner, the backend that returns text fields. */
function planned(dir: string): string {
  mkdirSync(join(dir, "test-config", "takeone"), { recursive: true });
  writeFileSync(join(dir, "test-config", "takeone", "planner.json"), JSON.stringify({ backend: "anthropic", auth: "apiKey", model: "claude-opus-5-5" }));
  return dir;
}

test("an over-long AI title is dropped; a title at the 28-character bound fits the 1080p stage band row", async () => {
  const dir = planned(newLongTake());
  try {
    const long = await fastTake(dir, { apiKey: KEY, fetchImpl: titled("W".repeat(29)), log: () => {}, warn: () => {} });
    assert.equal(long.take.film?.title, undefined, "a title over the bound was kept");
    assert.deepEqual(long.take.film?.captions?.map((c) => c.text), ["Open the File menu"]);
    // W in Inter Bold is the widest glyph this bound measured: the compact 43 px title
    // inks 872 px for 28 of them, inside the 1728 px the 1080p band allows.
    const widest = "W".repeat(28);
    const atBound = mapFilm({ titled: { answer: true, abstained: false, confidence: 1, by: "anthropic", ms: 0, title: widest } as Answer }, [], {}).title;
    assert.equal(atBound, widest, "the planner dropped a title at the bound");
    // The band geometry the 1080p render measures: ink over out_w * 0.9 makes captionLayouts throw.
    const d = { ...DEFAULTS, out_w: 1920, out_h: 1080 };
    const captions = takeCaptions({ width: STREAM_W, height: STREAM_H, title: widest, duration: 4 }, (t) => t, 4);
    assert.deepEqual(captions.filter((c) => c.title).map((c) => c.text), [widest], "the title at the bound is not drawn");
    const text = bandText(captions, [], d);
    const ink = await measureCaptions(dir, captions, text, true);
    const band = bandLayout(STREAM_W, STREAM_H, text, captions, ink);
    assert.ok(band, "the 1080p stage is not band-eligible");
    assert.ok(ink[0]!.w > 28 * Math.round(text.caption_size * 1.6) * 0.5,
      `the title at the bound rendered no ink (w=${ink[0]!.w}); the bundled face did not draw it`);
    assert.doesNotThrow(() => captionLayouts(captions, ink, text, false, band), "a title at the bound does not fit the 1080p band row");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A 6.7-minute take whose beats each carry a click, a typed line, a shortcut
 * and a scroll: the recorder's 30 beats a minute, and enough beats for three
 * film calls on a planner that returns no text, so a middle chunk is exercised. */
function buildChunkFilmTake(dir: string): string {
  execFileSync("ffmpeg", [
    "-nostdin", "-f", "lavfi", "-i", "color=c=gray:s=320x180:d=400:r=10",
    "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska", "-frames:v", "4000", "-y", join(dir, "screen.webm"),
  ], { stdio: "ignore" });
  writeFileSync(join(dir, "frames.tsv"), Array.from({ length: 4000 }, (_, i) => `${i * 3000}\t${i * 100000000}\n`).join(""));
  // Every burst stays one beat (over MERGE_SHORT_MS, and the pointer jumps more
  // than the beat's spread keeps together), two seconds apart: 30 beats a minute.
  const burst = (t: number, x: number): object[] => [
    { t: t - 100, k: "ptr", x, y: 90 },
    { t, k: "btn", b: "left", down: true },
    { t: t + 50, k: "btn", b: "left", down: false },
    { t: t + 80, k: "key", cls: "char", down: true },
    { t: t + 140, k: "key", cls: "char", down: true },
    { t: t + 200, k: "key", cls: "char", down: true },
    { t: t + 280, k: "key", combo: "ctrl+s", down: true },
    { t: t + 360, k: "wheel", dx: 0, dy: 1 },
    { t: t + 420, k: "wheel", dx: 0, dy: 1 },
    { t: t + 900, k: "btn", b: "left", down: true },
    { t: t + 950, k: "btn", b: "left", down: false },
  ];
  const events = [
    { t: 0, k: "win", cls: "chromium", title: "Quarterly board", rect: [0, 0, 280, 150] },
    ...Array.from({ length: 199 }, (_, i) => 300 + i * 2000).flatMap((t, i) => burst(t, i % 2 === 0 ? 60 : 240)),
  ];
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(dir, "take.json"), JSON.stringify({ id: "t1", stream: { w: STREAM_W, h: STREAM_H }, scale: 1, offset_ms: 0, pointer: "hyprland" }));
  return dir;
}

test("a long take's film is planned in chunks under the cap and joined into one film", async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-take-"));
  try {
    buildChunkFilmTake(dir);
    // First the default, text-less planner: its middle chunk must still plan its
    // beats, so no beat is skipped between the film calls.
    mkdirSync(join(dir, "test-config", "takeone"), { recursive: true });
    writeFileSync(join(dir, "test-config", "takeone", "planner.json"), JSON.stringify({ backend: "jev", auth: "apiKey", model: "jev-latest" }));
    const quietParts: { state: { timeline: string[] }; questions: Record<string, any> }[] = [];
    const quietFetch = (async (_url, init) => {
      const { state, questions } = JSON.parse(String(init?.body)) as { state: { timeline?: string[] }; questions: Record<string, any> };
      let answers: Record<string, unknown>;
      if (state.timeline === undefined) {
        answers = chunkAnswers(String(init?.body), firstZoneAnswers) as Record<string, unknown>;
      } else {
        quietParts.push({ state: state as { timeline: string[] }, questions });
        const ends = questions.ending ? Object.keys((questions.ending as { criteria: Record<string, string> }).criteria) : [];
        answers = {
          ...(questions.theme ? filmAnswers() : {}),
          ...(questions.ending ? { ending: { pick: ends[0], probabilities: Object.fromEntries(ends.map((id) => [id, id === ends[0] ? 1 : 0])), confidence: 1 } } : {}),
        };
      }
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 800 } }), { status: 200 });
    }) as typeof fetch;
    const quiet = await fastTake(dir, { apiKey: KEY, fetchImpl: quietFetch, camera: { ...FAST, fps: 6 }, log: () => {}, warn: () => {} });
    const beats = JSON.parse(readFileSync(join(dir, "analysis", "beats.json"), "utf8")) as { id: string }[];
    assert.ok(quietParts.length >= 3, `the text-less take was planned in ${quietParts.length} film call(s), so no middle chunk was exercised`);
    const quietPlanned = quietParts.flatMap((part) => part.state.timeline.map((line) => line.split(",")[0]!));
    assert.deepEqual(quietPlanned, beats.map((b) => b.id), "the text-less film calls skip beats in a middle chunk");
    for (const part of quietParts) {
      assert.ok(Object.keys(part.questions).length > 0, "a film call asks nothing");
      const tokens = Math.ceil(JSON.stringify({ model: "jev-latest", state: part.state, questions: part.questions }).length / 3.5);
      assert.ok(tokens <= 4000, `a text-less film call is over the 4,000-token cap: ${tokens}`);
    }
    assert.ok(!quietParts.some((part) => "titled" in part.questions), "the text-less planner was asked for captions");
    assert.ok("theme" in quietParts[0]!.questions && "theme" in quietParts[1]!.questions, "the middle chunk does not ask the film-wide questions");
    assert.ok("ending" in quietParts.at(-1)!.questions, "the last chunk does not ask the ending");
    assert.equal(quiet.take.film?.by.titled, undefined, "a text-less planner returned a title");

    // Then the text-returning planner: same coverage, and its captions join.
    writeFileSync(join(dir, "test-config", "takeone", "planner.json"), JSON.stringify({ backend: "anthropic", auth: "apiKey", model: "claude-opus-5-5" }));
    // The film calls, in order: their state and questions as the planner received them.
    const parts: { state: { timeline: string[]; before_this_chunk?: string }; questions: Record<string, Record<string, unknown>> }[] = [];
    const fetchImpl = (async (_url, init) => {
      const { state, questions } = JSON.parse(JSON.parse(String(init?.body)).messages[0].content[0].text) as { state: { timeline?: string[] }; questions: Record<string, unknown> };
      let input: Record<string, unknown>;
      if (state.timeline === undefined) {
        input = chunkAnswers(String(init?.body), firstZoneAnswers) as Record<string, unknown>;
      } else {
        parts.push({ state, questions } as (typeof parts)[number]);
        const first = state.timeline[0]!.split(",")[0]!;
        // The first call asks the film-wide questions; every call captions its own beats.
        input = {
          ...(questions.theme ? {
            theme: { pick: "paper", probabilities: { midnight: 0, paper: 1, aurora: 0, mono: 0, sand: 0, editorial: 0 }, confidence: 1 },
            pace: { probabilities: [0, 1, 0, 0], confidence: 1 },
            opening: { pick: "establish", probabilities: { establish: 1, short: 0, straight: 0 }, confidence: 1 },
            camera_style: { pick: "calm", probabilities: { calm: 1, lively: 0 }, confidence: 1 },
            titled: { pick: "true", probabilities: { true: 1, false: 0 }, title: "Quarterly board", captions: [{ beat: first, text: `opens on ${first}` }] },
          } : {
            titled: { pick: "true", probabilities: { true: 1, false: 0 }, captions: [{ beat: first, text: `carries on at ${first}` }] },
          }),
          ...(questions.ending ? (() => {
            const ends = Object.keys((questions.ending as { options: Record<string, string> }).options);
            return { ending: { pick: ends[0], probabilities: Object.fromEntries(ends.map((id) => [id, id === ends[0] ? 1 : 0])), confidence: 1 } };
          })() : {}),
        };
      }
      return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "decisions", input }], usage: { input_tokens: 500, output_tokens: 80 } }), { status: 200 });
    }) as typeof fetch;
    const r = await fastTake(dir, { apiKey: KEY, fetchImpl, camera: { ...FAST, fps: 6 }, log: () => {}, warn: () => {} });
    assert.ok(parts.length >= 3, `the take was planned in ${parts.length} film call(s)`);
    for (const part of parts) {
      // The planner's own estimate: the body it builds is this state and these questions.
      const tokens = Math.ceil(JSON.stringify({ model: "jev-latest", state: part.state, questions: part.questions }).length / 3.5);
      assert.ok(tokens <= 4000, `a film call is over the 4,000-token cap: ${tokens}`);
    }
    // Split, not trimmed: every beat is planned once, in order.
    const planned = parts.flatMap((part) => part.state.timeline.map((line) => line.split(",")[0]!));
    assert.deepEqual(planned, beats.map((b) => b.id), "the film calls cover every beat once, in order");
    // Each call after the first is told what the call before it planned.
    assert.equal(parts[0]!.state.before_this_chunk, undefined);
    const lastOfFirst = parts[0]!.state.timeline.at(-1)!.split(",")[0]!;
    assert.ok(parts[1]!.state.before_this_chunk!.includes(lastOfFirst), `no summary of the earlier beats: ${parts[1]!.state.before_this_chunk}`);
    assert.ok(!parts[1]!.state.before_this_chunk!.includes(parts[0]!.state.timeline[0]!), "the summary repeats the whole previous chunk, not a short part of it");
    assert.ok(parts[1]!.state.before_this_chunk!.length < 1000, `the summary of the chunk before is not short: ${parts[1]!.state.before_this_chunk!.length} characters`);
    // The last call holds the take's last beats, so it is the one that picks the ending.
    assert.deepEqual(Object.keys((parts.at(-1)!.questions.ending as { options: object }).options), beats.slice(-3).map((b) => b.id));
    // The chunk plans join into one film: the first call's look and title, the
    // last call's ending, and every call's captions.
    const film = r.take.film!;
    assert.equal(film.theme, "paper");
    assert.equal(film.camera_path, "hold");
    assert.equal(film.title, "Quarterly board");
    assert.equal(film.end_beat, beats.at(-3)!.id);
    assert.deepEqual(film.captions?.map((c) => c.text), parts.map((part, i) =>
      `${i === 0 ? "opens on" : "carries on at"} ${part.state.timeline[0]!.split(",")[0]}`));
    assert.equal(film.by.titled, "ai");
    // The render wrote the joined text: the title and a caption from each call.
    const ass = readFileSync(join(dir, "captions.ass"), "utf8");
    assert.ok(ass.includes("Quarterly board") && ass.includes(`opens on ${beats[0]!.id}`) && ass.includes(film.captions![1]!.text), "the joined film text was not drawn");
    assert.equal(JSON.parse(readFileSync(join(dir, "take.json"), "utf8")).film.theme, "paper");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A take long enough for three film chunks, each beat's timeline line as long
 * as a real one that carries a click, a typed line, a shortcut and a scroll. */
function filmChunkBeats(count: number): Beat[] {
  return Array.from({ length: count }, (_, i) => {
    const t = i * 1000;
    return {
      id: `b${i + 1}`, t0: t, t1: t + 800, anchor_t: t + 400, window_cls: "chromium", kind: "type", zones: [],
      actions: [
        { k: "click", t: t + 100, x: 30, y: 20, window_cls: "chromium" },
        { k: "type", t0: t + 200, t1: t + 300, window_cls: "chromium" },
        { k: "shortcut", t: t + 400, combo: "ctrl+s", window_cls: "chromium" },
        { k: "scroll", t0: t + 500, t1: t + 600, x: 30, y: 20, dx: 0, dy: 1, detents: 1, window_cls: "chromium" },
      ],
    } satisfies Beat;
  });
}

test("a take of three film chunks asks no request that has nothing to ask", () => {
  const beats = filmChunkBeats(200);
  const ctx = { seconds: 200, source: "320x180", device: "desktop", brightness: "dark" as const, beats };
  const quiet = planFilm({ ...ctx, text: false });
  assert.ok(quiet, "a take this long got no film plan");
  const asked = quiet.calls.map((call) => (call.state.timeline as string[]).map((line) => line.split(",")[0]!));
  for (const call of quiet.calls) {
    assert.ok(Object.keys(call.questions).length > 0, `a film call asks no question for beats ${(call.state.timeline as string[])[0]}`);
  }
  const covered = asked.flat();
  assert.ok(quiet.calls.length >= 3, `the take was planned in ${quiet.calls.length} film call(s), so no middle chunk was exercised`);
  assert.deepEqual(covered, beats.map((b) => b.id), "a middle chunk was skipped: the film calls do not cover every beat once, in order");
  assert.ok("theme" in quiet.calls[0]!.questions && "ending" in quiet.calls.at(-1)!.questions, "the look and the ending were asked in the wrong call");
  // A middle chunk of a text-less planner asks the film-wide questions instead of
  // nothing: it must still plan its beats.
  for (const middle of quiet.calls.slice(1, -1)) {
    assert.ok(Object.keys(middle.questions).length > 0);
    assert.ok("theme" in middle.questions, "a middle chunk asks nothing about the take");
  }
  assert.ok(!quiet.calls.some((call) => "titled" in call.questions), "a planner that returns no text was asked for captions");
  for (let k = 1; k < quiet.calls.length; k++) {
    const previous = quiet.calls[k - 1]!.state.timeline as string[];
    const summary = quiet.calls[k]!.state.before_this_chunk as string;
    assert.ok(summary.includes(`${previous.at(-1)!.split(",")[0]!}, `), `call ${k + 1} is not told the beat before it: ${summary}`);
  }
  assert.equal(quiet.tokens, quiet.calls.reduce((n, c) => n + c.tokens, 0), "a chunk that was not asked is priced");
  // The same take with a planner that captions every chunk covers every beat once.
  const loud = planFilm({ ...ctx, text: true });
  assert.ok(loud);
  assert.deepEqual(loud.calls.flatMap((call) => (call.state.timeline as string[]).map((line) => line.split(",")[0]!)), beats.map((b) => b.id),
    "the text take's chunks do not cover every beat once, in order");
});

test("live API shape: Android tap hints stay planner decisions", async () => {
  const dir = newTake();
  try {
    const takePath = join(dir, "take.json");
    writeFileSync(takePath, JSON.stringify({ ...JSON.parse(readFileSync(takePath, "utf8")), device: "android" }));
    const tapStates: { beat: { hint?: string }; zones: Record<string, { shows: string }> }[] = [];
    const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
      const beats = JSON.parse(String(init?.body)).state.beats as Record<string, { device_hint?: string; zones: Record<string, { shows: string }> }>;
      for (const b of Object.values(beats)) if (b.device_hint) tapStates.push({ beat: { hint: b.device_hint }, zones: b.zones });
      const answer = {
        model: "jev-1.13.0",
        answers: chunkAnswers(String(init?.body), (names) => {
          const choiceProbs = Object.fromEntries(names.map((name, i) => [name, i === 0 ? 0.95 : 0.05 / (names.length - 1 || 1)]));
          return {
          focus_start: { type: "choice", choice: names[0], confidence: 0.93, probabilities: choiceProbs },
          focus_end: { type: "choice", choice: names[0], confidence: 0.65, probabilities: choiceProbs },
          // A live spread: Jev's tightness confidence sits under 0.5 even when it
          // leans to level 2, so the median must decide, not argmax-then-widen.
          tightness: { type: "score", score: 1.45, confidence: 0.27, probabilities: { 0: 0.22, 1: 0.2, 2: 0.49, 3: 0.09 } },
          new_subject: { type: "noul", noul: 0.27 },
          key_moment: { type: "score", score: 0.01, confidence: 0.99, probabilities: { 0: 1, 1: 0, 2: 0 } },
          };
        }),
        usage: { input_tokens: 874, output_tokens: 131 },
      };
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as typeof fetch;
    const r = await fastTake(dir, { apiKey: KEY, fetchImpl: fake, log: () => {}, warn: () => {} });
    const aiDecisions = r.decisions.filter((d) => d.decided_by === "ai");
    assert.ok(aiDecisions.length >= 2, `expected jev decisions from the live response shape, got ${aiDecisions.length}`);
    assert.ok(aiDecisions.every((d) => d.input_tokens === 874));
    assert.ok(aiDecisions.every((d) => d.p === 0.27));
    assert.ok(tapStates.length > 0, "Android taps reach the planner");
    assert.match(tapStates[0]!.beat.hint ?? "", /first candidate zone is the tapped control/);
    assert.equal(tapStates[0]!.zones.z1!.shows, "the tapped control");
    const tapBeats = r.beats.filter((beat) => beat.hint);
    assert.ok(tapBeats.length > 0);
    for (const beat of tapBeats) assert.deepEqual(beat.zones[0]!.boxes, [beat.zones[0]!.bbox]);
    assert.deepEqual(aiDecisions.map((d) => d.L), aiDecisions.map(() => 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sparse object-keyed score probabilities fall back to the heuristic", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
      const answer = {
        answers: chunkAnswers(String(init?.body), (names) => {
          const choiceProbs = Object.fromEntries(names.map((name, i) => [name, i === 0 ? 0.95 : 0.05 / (names.length - 1 || 1)]));
          return {
          focus_start: { choice: names[0], confidence: 0.93, probabilities: choiceProbs },
          focus_end: { choice: names[0], confidence: 0.93, probabilities: choiceProbs },
          // level 0 omitted: a sparse score must not silently decide as L=0
          tightness: { confidence: 0.9, probabilities: { 1: 0.1, 2: 0.2, 3: 0.7 } },
          new_subject: { noul: 0.27 },
          };
        }),
        usage: { input_tokens: 500 },
      };
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as typeof fetch;
    const r = await fastTake(dir, { apiKey: KEY, fetchImpl: fake, log: () => {}, warn: () => {} });
    assert.ok(r.decisions.every((d) => d.decided_by === "heuristic"));
    assert.ok(r.planner.failed >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("single-zone beats use the heuristic without planner tokens", async () => {
  const dir = newTake();
  try {
    const bodies: string[] = [];
    let calls = 0;
    const r = await fastTake(dir, { apiKey: KEY, log: () => {}, warn: () => {}, fetchImpl: (async (_url, init) => {
      const body = String(init?.body);
      calls++;
      bodies.push(...beatViews(body));
      return firstZoneReply(body);
    }) as typeof fetch });
    const single = r.beats.map((b, i) => ({ b, d: r.decisions[i]! })).filter(({ b }) => b.zones.length === 1);
    assert.ok(single.length > 0);
    assert.ok(single.every(({ d }) => d.decided_by === "heuristic" && d.input_tokens === undefined));
    assert.ok(bodies.every((body) => Object.keys(JSON.parse(body).state.zones).length >= 2));
    assert.equal(r.planner.input_tokens, calls * 800);
    assert.equal(r.planner.failed, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a single-chunk take reserves every request twice", async () => {
  const dir = newTake();
  try {
    const path = join(dir, "events.jsonl");
    const events = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    events.splice(events.findIndex((e) => e.t === 6500), 0, { t: 6400, k: "ptr", x: 20, y: 30 });
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const bodies: string[] = [];
    const logs: string[] = [];
    await fastTake(dir, { apiKey: KEY, film: false, maxTokens: 100000, log: (s) => logs.push(s), warn: () => {}, fetchImpl: (async (_url, init) => {
      bodies.push(String(init?.body));
      return firstZoneReply(String(init?.body));
    }) as typeof fetch });
    const planned = Number(logs.find((s) => s.startsWith("preflight:"))!.match(/(\d+) planned tokens/)![1]);
    // One chunk is the largest chunk, so its re-ask is reserved alongside it.
    assert.equal(bodies.length, 1);
    assert.ok(planned >= bodies.reduce((sum, body) => sum + Math.ceil(body.length / 3.5), 0) * 2 - 1200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight reserves re-asks and current shots distinguish viewport positions", { skip: needsFfmpeg }, async () => {
  const dir = newLongTake();
  try {
    const bodies: string[] = [];
    const logs: string[] = [];
    await fastTake(dir, { apiKey: KEY, film: false, maxTokens: 100000, log: (s) => logs.push(s), warn: () => {}, fetchImpl: (async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response("boom", { status: 500 });
    }) as typeof fetch });
    const planned = Number(logs.find((s) => s.startsWith("preflight:"))!.match(/(\d+) planned tokens/)![1]);
    // Two chunks fail: the first is asked once more, the second keeps the rules.
    assert.equal(bodies.length, 3);
    assert.equal(bodies[1], bodies[0], "the re-ask repeats the first chunk");
    const tokens = (body: string) => Math.ceil(body.length / 3.5);
    assert.ok(planned >= tokens(bodies[0]!) + tokens(bodies[2]!) + Math.max(tokens(bodies[0]!), tokens(bodies[2]!)));
    const shots = bodies.map((body) => JSON.parse(body).state.current_shot);
    assert.ok(new Set(shots).size > 1);
    assert.ok(bodies.every((body) => tokens(body) <= 4000), "every chunk stays under the 4,000-token cap");
    await assert.rejects(fastTake(dir, { apiKey: KEY, maxTokens: planned - 1, log: () => {}, warn: () => {}, fetchImpl: (async () => { throw new Error("called"); }) as typeof fetch }), PreflightRefusal);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the next chunk starts from the shot the previous chunk decided", async () => {
  const dir = newLongTake();
  try {
    const requests: any[] = [];
    const r = await fastTake(dir, { apiKey: KEY, log: () => {}, warn: () => {}, fetchImpl: (async (_url, init) => {
      const body = String(init?.body);
      requests.push(...beatViews(body).map((view) => JSON.parse(view)));
      // The planner overrules the rules: every beat ends on its last zone.
      const answers = chunkAnswers(body, (names) => {
        const chosen = names[names.length - 1]!;
        const probabilities = Object.fromEntries(names.map((name) => [name, name === chosen ? 1 : 0]));
        return { ...firstZoneAnswers(names), focus_start: { choice: chosen, probabilities, confidence: 1 }, focus_end: { choice: chosen, probabilities, confidence: 1 } };
      });
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 800 } }), { status: 200 });
    }) as typeof fetch });
    assert.ok(requests.length >= 5, JSON.stringify({ beats: r.beats.map((b) => [b.kind, b.zones.map((z) => z.kind)]), shots: requests.map((q) => q.state.current_shot) }));
    // Twelve beats ask as two chunks of six; the seventh beat opens the second chunk.
    assert.equal(requests.filter((q) => q.state.current_shot !== undefined).length, 2);
    const last = r.beats[5]!;
    const d = r.decisions[5]!;
    assert.equal(d.decided_by, "ai");
    const z = last.zones.find((x) => x.name === d.B)!;
    const rect = frameRect(z, d.L, { stream: { w: 320, h: 180 }, winRect: [0, 0, 280, 150] });
    assert.equal(requests[6]!.state.current_shot, `Framing ${z.desc.shows} at ${rect.join(",")}.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every planner failure mode falls back to the heuristic and counts as failed", async () => {
  const modes: Array<{ name: string; tokens: number; impl: (body: string) => Response }> = [
    { name: "500", tokens: 0, impl: () => new Response("boom", { status: 500 }) },
    { name: "malformed", tokens: 0, impl: () => new Response("not json", { status: 200 }) },
    {
      name: "bad probabilities",
      tokens: 10,
      impl: (body) =>
        new Response(
          JSON.stringify({
            answers: chunkAnswers(body, () => ({
              focus_start: { choice: "z1", probabilities: { z1: 0.9, z2: 0.2 }, confidence: 0.9 },
            })),
            usage: { input_tokens: 10 },
          }),
          { status: 200 },
        ),
    },
  ];
  for (const m of modes) {
    const dir = newTake();
    let calls = 0;
    try {
      const r = await fastTake(dir, { apiKey: KEY, fetchImpl: (async (_url, init) => { calls++; return m.impl(String(init?.body)); }) as typeof fetch, log: () => {}, warn: () => {} });
      assert.equal(r.decisions.filter((d) => d.decided_by === "ai").length, 0, m.name);
      assert.equal(r.planner.failed, r.beats.filter((b) => b.zones.length >= 2).length, m.name);
      assert.equal(r.planner.input_tokens, calls * m.tokens, m.name);
      assert.equal(JSON.parse(readFileSync(join(dir, "take.json"), "utf8")).planner.mode, "fallback", m.name);
      // nothing ever waits on or fails because of Jev: the run still succeeded
      assert.ok(r.beats.length >= 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("oversize beat request falls back without aborting other beats", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    const path = join(dir, "events.jsonl");
    const events = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    events.find((e) => e.t === 4200).combo = "Ctrl+" + "X".repeat(6000);
    events.find((e) => e.k === "win").rect = [0, 0, 280, 150];
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    let calls = 0;
    const r = await fastTake(dir, { apiKey: KEY, maxTokens: 100000, log: () => {}, warn: () => {}, fetchImpl: (async () => {
      calls++;
      return new Response("boom", { status: 500 });
    }) as typeof fetch });
    const shortcut = r.beats.find((b) => b.actions.some((a) => a.k === "shortcut"))!;
    assert.ok(shortcut);
    assert.equal(r.decisions.find((d) => d.beat === shortcut.id)?.decided_by, "heuristic");
    assert.ok(calls > 0);
    assert.ok(r.planner.failed >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed planner answers are not cached across runs", async () => {
  const dir = newTake();
  try {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response(JSON.stringify(calls <= 10 ? { answers: { focus_start: { choice: "bad" } } } : plannerAnswers()), { status: 200 });
    }) as typeof fetch;
    const first = await fastTake(dir, { apiKey: KEY, fetchImpl: fake, log: () => {}, warn: () => {} });
    assert.ok(first.decisions.every((d) => d.decided_by === "heuristic"));
    const before = calls;
    await fastTake(dir, { apiKey: KEY, fetchImpl: fake, log: () => {}, warn: () => {} });
    assert.ok(calls > before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid caps refuse before any planner call", async () => {
  const dir = newTake();
  try {
    let calls = 0;
    for (const maxTokens of [NaN, Infinity, 0, -1]) {
      await assert.rejects(fastTake(dir, { apiKey: KEY, maxTokens, fetchImpl: (async () => { calls++; throw new Error("unexpected"); }) as typeof fetch, log: () => {}, warn: () => {} }), PreflightRefusal);
    }
    assert.equal(calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight refuses above --max-tokens before any call", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await assert.rejects(
      fastTake(dir, { apiKey: KEY, fetchImpl: fake, maxTokens: 10, log: () => {}, warn: () => {} }),
      (e: unknown) => e instanceof PreflightRefusal && /--no-ai/.test(e.message),
    );
    assert.equal(calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("screen words are read by default with a planner and titles are redacted", async () => {
  const dir = newTake();
  try {
    const path = join(dir, "events.jsonl");
    const events = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    events[0].cls = "PrivateCustomerName";
    events[0].title = "12345abcdefghijklmnop";
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const boom = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const normal = await fastTake(dir, { noAi: true, log: () => {}, warn: () => {} });
    assert.ok(!JSON.stringify(normal.beats.flatMap((b) => b.zones.map((z) => z.desc))).includes("PrivateCustomerName"));
    // AI on, no flags: screen words are read (window label appended, redacted)
    const opted = await fastTake(dir, { apiKey: KEY, fetchImpl: boom, log: () => {}, warn: () => {} });
    const descriptions = JSON.stringify(opted.beats.flatMap((b) => b.zones.map((z) => z.desc)));
    assert.ok(descriptions.includes("[redacted]"));
    assert.ok(!descriptions.includes("PrivateCustomerName"));
    assert.ok(descriptions.includes("[redacted]"));
    assert.ok(!descriptions.includes("12345abcdefghijklmnop"));
    // --no-screen-text opts out even with a planner
    const off = await fastTake(dir, { apiKey: KEY, fetchImpl: boom, noScreenText: true, log: () => {}, warn: () => {} });
    assert.ok(!JSON.stringify(off.beats.flatMap((b) => b.zones.map((z) => z.desc))).includes("[redacted]"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zones never leak window titles without a planner; beats carry word-only descriptions", async () => {
  const dir = newTake();
  try {
    const r = await fastTake(dir, { noAi: true, log: () => {}, warn: () => {} });
    const beats: Beat[] = r.beats;
    for (const b of beats) {
      for (const z of b.zones) {
        const desc = JSON.stringify(z.desc);
        assert.ok(!/\d/.test(desc), `digits in zone desc: ${desc}`);
        assert.ok(!desc.includes("Quarterly report"));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
