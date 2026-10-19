// End-to-end planner test over a synthetic take: a tiny webm generated with
// ffmpeg, plus events and frames.tsv written in code.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTake, PreflightRefusal, TakeInputError, type MakeOptions, type MakeResult } from "../src/make.ts";
import { PlannerUnavailable } from "../src/decide/planner.ts";
import { ConfigError } from "@byokit/decide";
import { main, resolveCamera } from "../src/cli.ts";
import { frameRect } from "../src/decide/mapping.ts";
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
