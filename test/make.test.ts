// End-to-end planner test over a synthetic take: a tiny webm generated with
// ffmpeg, plus events and frames.tsv written in code.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTake, PreflightRefusal, TakeInputError, type MakeOptions, type MakeResult } from "../src/make.ts";
import { main } from "../src/cli.ts";
import { frameRect } from "../src/decide/mapping.ts";
import type { Beat, Decision, JevAnswers, TakeMeta } from "../src/types.ts";
import { STREAM, hasFfmpeg } from "./helpers.ts";
import { DEFAULTS } from "../src/camera/defaults.ts";

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
  return makeTake(dir, { apiKey: null, camera: FAST, log: () => {}, warn: () => {}, ...opts });
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

function jevAnswers(): unknown {
  const answers: JevAnswers = {
    focus_start: { choice: "z1", probabilities: { z1: 0.9, z2: 0.1 }, confidence: 0.8 },
    focus_end: { choice: "z1", probabilities: { z1: 0.9, z2: 0.1 }, confidence: 0.8 },
    tightness: { probabilities: [0.1, 0.1, 0.7, 0.1], confidence: 0.9 },
    new_subject: { p: 0.2 },
  };
  return { answers, usage: { input_tokens: 800 } };
}

test("make --no-jev renders the agreed beat/decision files into a tiny test MP4", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    // --set is test-only plumbing: full-size slow output stays the default.
    assert.equal(await main(["make", dir, "--no-jev",
      "--set", "preset=veryfast", "--set", "out_w=320", "--set", "out_h=180",
      "--set", "ripple_ms=0", "--set", "fade_s=0"]), 0);
    const output = join(dir, "out", "t1.mp4");
    assert.ok(existsSync(output));
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=width,height,nb_read_frames", "-of", "json", output], { encoding: "utf8" }));
    assert.deepEqual([probe.streams[0].width, probe.streams[0].height], [320, 180]);
    // Idle squeezing shortens the 10 s take; the video still matches the solved camera path.
    const cameraFrames = JSON.parse(readFileSync(join(dir, "camera.json"), "utf8")).length;
    const frames = Number(probe.streams[0].nb_read_frames);
    assert.ok(frames < 300 && Math.abs(frames - cameraFrames) <= 1, `${frames} frames vs ${cameraFrames} camera samples`);
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
    await fastTake(dir, { noJev: true });
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

    await fastTake(dir, { noJev: true, log: () => {}, warn: () => {} });
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

test("make accepts video-only missing events and silent recorded streams", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    for (const file of ["screen.webm", "frames.tsv", "events.jsonl"]) {
      const path = join(dir, file);
      const original = readFileSync(path);
      rmSync(path);
      await assert.rejects(fastTake(dir, { noJev: true, log: () => {}, warn: () => {} }), (e: unknown) => e instanceof TakeInputError && e.file === file);
      writeFileSync(path, original);
    }
    const eventsPath = join(dir, "events.jsonl");
    const take = JSON.parse(readFileSync(join(dir, "take.json"), "utf8"));
    take.events = "on";
    writeFileSync(join(dir, "take.json"), JSON.stringify(take));
    writeFileSync(eventsPath, "not-json\n");
    await assert.rejects(makeTake(dir, { noJev: true, log: () => {}, warn: () => {} }), (e: unknown) => e instanceof TakeInputError && e.file === "events.jsonl");
    writeFileSync(eventsPath, "");
    const silent = await makeTake(dir, { noJev: true, log: () => {}, warn: () => {} });
    assert.ok(silent.beats.length > 0);
    take.events = "none";
    take.trim = { start: 1000, end: 9000 };
    writeFileSync(join(dir, "take.json"), JSON.stringify(take));
    const result = await fastTake(dir, { noJev: true, log: () => {}, warn: () => {} });
    assert.equal(result.jev.input_tokens, 0);
    assert.deepEqual(result.beats.map((b) => [b.kind, b.t0, b.t1]), [["idle", 1000, 9000]]);
    assert.equal(result.decisions[0]?.decided_by, "heuristic");
    rmSync(eventsPath);
    const missing = await makeTake(dir, { noJev: true, log: () => {}, warn: () => {} });
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
    await fastTake(dir, { noJev: true, log: () => {}, warn: () => {} });
    const saved = JSON.parse(readFileSync(join(dir, "take.json"), "utf8"));
    const beats = JSON.parse(readFileSync(join(dir, "analysis", "beats.json"), "utf8"));
    assert.equal(saved.trim_start, 0);
    assert.equal(saved.trim_end, 8);
    assert.ok(beats.every((b: { t0: number; t1: number; anchor_t: number }) => b.t0 >= 0 && b.anchor_t >= 0 && b.t1 <= 8));
    assert.ok(existsSync(join(dir, "out", "t1.mp4")));
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
      await assert.rejects(fastTake(dir, { noJev: true, log: () => {}, warn: () => {} }),
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
      await assert.rejects(fastTake(dir, { noJev: true, log: () => {}, warn: () => {} }), (e: unknown) => e instanceof TakeInputError && e.file === "frames.tsv" && /invalid first frame timestamp/.test(e.message));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("make --no-jev writes analysis files and heuristic decisions", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    const r = await fastTake(dir, { noJev: true, log: () => {}, warn: () => {} });
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
    // take.json gains the jev accounting
    const take = JSON.parse(readFileSync(join(dir, "take.json"), "utf8")) as TakeMeta;
    assert.deepEqual(take.jev, { input_tokens: 0, usd: 0, failed: 0 });
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
    const r = await fastTake(dir, { noJev: true, log: () => {}, warn: () => {} });
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

test("make with a key decides via Jev and accounts usage; cache hit costs zero calls", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    let calls = 0;
    const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      const names = Object.keys(JSON.parse(String(init?.body)).state.zones);
      const probabilities = Object.fromEntries(names.map((name, i) => [name, i === 0 ? 1 : 0]));
      const answer = jevAnswers() as { answers: JevAnswers; usage: { input_tokens: number } };
      answer.answers.focus_start = { choice: names[0], probabilities, confidence: 1 };
      answer.answers.focus_end = { choice: names[0], probabilities, confidence: 1 };
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as typeof fetch;
    const r1 = await fastTake(dir, { apiKey: KEY, fetchImpl: fake, log: () => {}, warn: () => {} });
    assert.ok(calls >= 2, `expected jev calls, got ${calls}`);
    const jevDecisions = r1.decisions.filter((d) => d.decided_by === "jev");
    assert.ok(jevDecisions.length >= 2);
    assert.equal(r1.jev.input_tokens, calls * 800);
    assert.ok(existsSync(join(dir, "analysis", "jev-cache.jsonl")));
    const callsAfterFirst = calls;

    // second run: identical requests, so every call is a cache hit
    const r2 = await fastTake(dir, { apiKey: KEY, fetchImpl: fake, log: () => {}, warn: () => {} });
    assert.equal(calls, callsAfterFirst);
    assert.equal(r2.jev.input_tokens, 0);
    assert.deepEqual(r2.decisions.map((d) => d.decided_by), r1.decisions.map((d) => d.decided_by));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live API shape: object-keyed score probabilities and noul still decide via Jev", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
      const names = Object.keys(JSON.parse(String(init?.body)).state.zones);
      const choiceProbs = Object.fromEntries(names.map((name, i) => [name, i === 0 ? 0.95 : 0.05 / (names.length - 1 || 1)]));
      const answer = {
        model: "jev-1.13.0",
        answers: {
          focus_start: { type: "choice", choice: names[0], confidence: 0.93, probabilities: choiceProbs },
          focus_end: { type: "choice", choice: names[0], confidence: 0.65, probabilities: choiceProbs },
          tightness: { type: "score", score: 1.02, confidence: 0, probabilities: { 0: 0.61, 1: 0.01, 2: 0.13, 3: 0.25 } },
          new_subject: { type: "noul", noul: 0.27 },
          key_moment: { type: "score", score: 0.01, confidence: 0.99, probabilities: { 0: 1, 1: 0, 2: 0 } },
        },
        usage: { input_tokens: 874, output_tokens: 131 },
      };
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as typeof fetch;
    const r = await fastTake(dir, { apiKey: KEY, fetchImpl: fake, log: () => {}, warn: () => {} });
    const jevDecisions = r.decisions.filter((d) => d.decided_by === "jev");
    assert.ok(jevDecisions.length >= 2, `expected jev decisions from the live response shape, got ${jevDecisions.length}`);
    assert.ok(jevDecisions.every((d) => d.input_tokens === 874));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sparse object-keyed score probabilities fall back to the heuristic", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
      const names = Object.keys(JSON.parse(String(init?.body)).state.zones);
      const choiceProbs = Object.fromEntries(names.map((name, i) => [name, i === 0 ? 0.95 : 0.05 / (names.length - 1 || 1)]));
      const answer = {
        answers: {
          focus_start: { choice: names[0], confidence: 0.93, probabilities: choiceProbs },
          focus_end: { choice: names[0], confidence: 0.93, probabilities: choiceProbs },
          // level 0 omitted: a sparse score must not silently decide as L=0
          tightness: { confidence: 0.9, probabilities: { 1: 0.1, 2: 0.2, 3: 0.7 } },
          new_subject: { noul: 0.27 },
        },
        usage: { input_tokens: 500 },
      };
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as typeof fetch;
    const r = await fastTake(dir, { apiKey: KEY, fetchImpl: fake, log: () => {}, warn: () => {} });
    assert.ok(r.decisions.every((d) => d.decided_by === "heuristic"));
    assert.ok(r.jev.failed >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("single-zone beats use the heuristic without Jev tokens", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    const bodies: string[] = [];
    const r = await fastTake(dir, { apiKey: KEY, log: () => {}, warn: () => {}, fetchImpl: (async (_url, init) => {
      const body = String(init?.body);
      bodies.push(body);
      const names = Object.keys(JSON.parse(body).state.zones);
      const probabilities = Object.fromEntries(names.map((name, i) => [name, i === 0 ? 1 : 0]));
      const response = jevAnswers() as { answers: JevAnswers };
      response.answers.focus_start = { choice: names[0], probabilities, confidence: 1 };
      response.answers.focus_end = { choice: names[0], probabilities, confidence: 1 };
      return new Response(JSON.stringify(response), { status: 200 });
    }) as typeof fetch });
    const single = r.beats.map((b, i) => ({ b, d: r.decisions[i]! })).filter(({ b }) => b.zones.length === 1);
    assert.ok(single.length > 0);
    assert.ok(single.every(({ d }) => d.decided_by === "heuristic" && d.input_tokens === undefined));
    assert.ok(bodies.every((body) => Object.keys(JSON.parse(body).state.zones).length >= 2));
    assert.equal(r.jev.input_tokens, bodies.length * 800);
    assert.equal(r.jev.failed, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight reserves re-asks and current shots distinguish viewport positions", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    const path = join(dir, "events.jsonl");
    const events = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    events.splice(events.findIndex((e) => e.t === 6500), 0, { t: 6400, k: "ptr", x: 20, y: 30 });
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const bodies: string[] = [];
    const logs: string[] = [];
    await fastTake(dir, { apiKey: KEY, maxTokens: 100000, log: (s) => logs.push(s), warn: () => {}, fetchImpl: (async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response("boom", { status: 500 });
    }) as typeof fetch });
    const planned = Number(logs.find((s) => s.startsWith("preflight:"))!.match(/(\d+) planned tokens/)![1]);
    assert.ok(planned >= bodies.reduce((sum, body) => sum + Math.ceil(body.length / 3.5), 0) * 2 - 1200);
    const shots = bodies.map((body) => JSON.parse(body).state.current_shot);
    assert.ok(new Set(shots).size > 1);
    await assert.rejects(fastTake(dir, { apiKey: KEY, maxTokens: planned - 1, log: () => {}, warn: () => {}, fetchImpl: (async () => { throw new Error("called"); }) as typeof fetch }), PreflightRefusal);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dependent re-asks use the preceding finalized shot", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    const events = [
      { t: 0, k: "win", cls: "chromium", title: "App", rect: [0, 0, 320, 180] },
      ...[500, 2700, 4900].flatMap((t, i) => [
        { t: t - 100, k: "ptr", x: 40 + i * 60, y: 80 },
        { t, k: "btn", b: "left", down: true },
        { t: t + 800, k: "ptr", x: 120 + i * 60, y: 100 },
        { t: t + 900, k: "btn", b: "left", down: false },
      ]),
    ];
    writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const requests: any[] = [];
    const r = await fastTake(dir, { apiKey: KEY, log: () => {}, warn: () => {}, fetchImpl: (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      const names = Object.keys(request.state.zones);
      const chosen = requests.length === 4 ? names[0]! : names[names.length - 1]!;
      const probabilities = Object.fromEntries(names.map((name) => [name, name === chosen ? 1 : 0]));
      const answer = jevAnswers() as { answers: JevAnswers };
      answer.answers.focus_start = { choice: chosen, probabilities, confidence: 1 };
      answer.answers.focus_end = { choice: chosen, probabilities, confidence: 1 };
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as typeof fetch });
    assert.ok(requests.length >= 5, JSON.stringify({ beats: r.beats.map((b) => [b.kind, b.zones.map((z) => z.kind)]), shots: requests.map((q) => q.state.current_shot) }));
    const drags = r.beats.filter((b) => b.kind === "drag");
    const second = drags[1]!;
    const d = r.decisions.find((x) => x.beat === second.id)!;
    const z = second.zones.find((x) => x.name === d.B)!;
    const rect = frameRect(z, d.L, { stream: { w: 320, h: 180 }, winRect: [0, 0, 320, 180] });
    assert.equal(requests[4]!.state.current_shot, `Framing ${z.desc.shows} at ${rect.join(",")}.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every Jev failure mode falls back to the heuristic and counts as failed", { skip: needsFfmpeg }, async () => {
  const modes: Array<{ name: string; impl: () => Response }> = [
    { name: "500", impl: () => new Response("boom", { status: 500 }) },
    { name: "malformed", impl: () => new Response("not json", { status: 200 }) },
    {
      name: "bad probabilities",
      impl: () =>
        new Response(
          JSON.stringify({
            answers: {
              focus_start: { choice: "z1", probabilities: { z1: 0.9, z2: 0.2 }, confidence: 0.9 },
            },
            usage: { input_tokens: 10 },
          }),
          { status: 200 },
        ),
    },
  ];
  for (const m of modes) {
    const dir = newTake();
    try {
      const r = await fastTake(dir, { apiKey: KEY, fetchImpl: (async () => m.impl()) as typeof fetch, log: () => {}, warn: () => {} });
      assert.equal(r.decisions.filter((d) => d.decided_by === "jev").length, 0, m.name);
      assert.equal(r.jev.failed, r.beats.filter((b) => b.zones.length >= 2).length, m.name);
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
    assert.ok(r.jev.failed >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed Jev answers are not cached across runs", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response(JSON.stringify(calls <= 10 ? { answers: { focus_start: { choice: "bad" } } } : jevAnswers()), { status: 200 });
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

test("invalid caps refuse before any Jev call", { skip: needsFfmpeg }, async () => {
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
      (e: unknown) => e instanceof PreflightRefusal && /--no-jev/.test(e.message),
    );
    assert.equal(calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("raw window identity requires screen-text opt-in and titles are redacted", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    const path = join(dir, "events.jsonl");
    const events = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    events[0].cls = "PrivateCustomerName";
    events[0].title = "12345abcdefghijklmnop";
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const normal = await fastTake(dir, { noJev: true, log: () => {}, warn: () => {} });
    assert.ok(!JSON.stringify(normal.beats.flatMap((b) => b.zones.map((z) => z.desc))).includes("PrivateCustomerName"));
    const opted = await fastTake(dir, { noJev: true, screenText: true, log: () => {}, warn: () => {} });
    const descriptions = JSON.stringify(opted.beats.flatMap((b) => b.zones.map((z) => z.desc)));
    assert.ok(descriptions.includes("[redacted]"));
    assert.ok(!descriptions.includes("PrivateCustomerName"));
    assert.ok(descriptions.includes("[redacted]"));
    assert.ok(!descriptions.includes("12345abcdefghijklmnop"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zones never leak window titles without --screen-text; beats carry word-only descriptions", { skip: needsFfmpeg }, async () => {
  const dir = newTake();
  try {
    const r = await fastTake(dir, { noJev: true, log: () => {}, warn: () => {} });
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
