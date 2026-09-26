// End-to-end planner test over a synthetic take: a tiny webm generated with
// ffmpeg, plus events and frames.tsv written in code.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTake, PreflightRefusal } from "../src/make.ts";
import { main } from "../src/cli.ts";
import type { Beat, Decision, JevAnswers, TakeMeta } from "../src/types.ts";
import { STREAM } from "./helpers.ts";

const STREAM_W = 320;
const STREAM_H = 180;
const KEY = "test-key-000";

function buildTake(dir: string): string {
  const webm = join(dir, "screen.webm");
  // 10 s solid grey at 30 fps: no change regions, deterministic beats from events
  execFileSync("ffmpeg", [
    "-nostdin", "-f", "lavfi", "-i", "color=c=gray:s=320x180:d=10:r=30",
    "-c:v", "libvpx-vp9", "-frames:v", "300", "-y", webm,
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

test("make --no-jev writes analysis files and heuristic decisions", async () => {
  const dir = newTake();
  try {
    const r = await makeTake(dir, { noJev: true, log: () => {}, warn: () => {} });
    assert.ok(existsSync(join(dir, "analysis", "regions.json")));
    assert.ok(existsSync(join(dir, "analysis", "actions.json")));
    assert.ok(existsSync(join(dir, "analysis", "beats.json")));
    assert.ok(existsSync(join(dir, "analysis", "decisions.json")));
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
      readFileSync(join(dir, "analysis", "decisions.json"), "utf8");
    assert.ok(!allAnalysis.includes("Quarterly report"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("perceived cuts enter actions and start cut beats", async () => {
  const dir = newTake();
  try {
    execFileSync("ffmpeg", [
      "-nostdin", "-f", "lavfi", "-i", "color=c=black:s=320x180:d=5:r=30",
      "-f", "lavfi", "-i", "color=c=white:s=320x180:d=5:r=30",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0", "-c:v", "libvpx-vp9", "-y", join(dir, "screen.webm"),
    ], { stdio: "ignore" });
    const r = await makeTake(dir, { noJev: true, log: () => {}, warn: () => {} });
    const cuts = r.beats.filter((b) => b.kind === "cut");
    assert.ok(cuts.length > 0);
    assert.ok(cuts.some((b) => b.actions.some((a) => a.k === "cut")));
    const saved = JSON.parse(readFileSync(join(dir, "analysis", "actions.json"), "utf8"));
    assert.ok(saved.actions.some((a: { k: string }) => a.k === "cut"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("make with a key decides via Jev and accounts usage; cache hit costs zero calls", async () => {
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
    const r1 = await makeTake(dir, { apiKey: KEY, fetchImpl: fake, log: () => {}, warn: () => {} });
    assert.ok(calls >= 2, `expected jev calls, got ${calls}`);
    const jevDecisions = r1.decisions.filter((d) => d.decided_by === "jev");
    assert.ok(jevDecisions.length >= 2);
    assert.equal(r1.jev.input_tokens, calls * 800);
    assert.ok(existsSync(join(dir, "analysis", "decisions.jsonl")));
    const callsAfterFirst = calls;

    // second run: identical requests, so every call is a cache hit
    const r2 = await makeTake(dir, { apiKey: KEY, fetchImpl: fake, log: () => {}, warn: () => {} });
    assert.equal(calls, callsAfterFirst);
    assert.equal(r2.jev.input_tokens, 0);
    assert.deepEqual(r2.decisions.map((d) => d.decided_by), r1.decisions.map((d) => d.decided_by));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight reserves re-asks and current shots distinguish viewport positions", async () => {
  const dir = newTake();
  try {
    const path = join(dir, "events.jsonl");
    const events = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    events.splice(events.findIndex((e) => e.t === 6500), 0, { t: 6400, k: "ptr", x: 20, y: 30 });
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const bodies: string[] = [];
    const logs: string[] = [];
    await makeTake(dir, { apiKey: KEY, maxTokens: 100000, log: (s) => logs.push(s), warn: () => {}, fetchImpl: (async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response("boom", { status: 500 });
    }) as typeof fetch });
    const planned = Number(logs.find((s) => s.startsWith("preflight:"))!.match(/(\d+) planned tokens/)![1]);
    assert.ok(planned >= bodies.reduce((sum, body) => sum + Math.ceil(body.length / 3.5), 0) * 2 - 1200);
    const shots = bodies.map((body) => JSON.parse(body).state.current_shot);
    assert.ok(new Set(shots).size > 1);
    await assert.rejects(makeTake(dir, { apiKey: KEY, maxTokens: planned - 1, log: () => {}, warn: () => {}, fetchImpl: (async () => { throw new Error("called"); }) as typeof fetch }), PreflightRefusal);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every Jev failure mode falls back to the heuristic and counts as failed", async () => {
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
      const r = await makeTake(dir, { apiKey: KEY, fetchImpl: (async () => m.impl()) as typeof fetch, log: () => {}, warn: () => {} });
      assert.equal(r.decisions.filter((d) => d.decided_by === "jev").length, 0, m.name);
      assert.equal(r.jev.failed, r.beats.length, m.name);
      // nothing ever waits on or fails because of Jev: the run still succeeded
      assert.ok(r.beats.length >= 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("malformed Jev answers are not cached across runs", async () => {
  const dir = newTake();
  try {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response(JSON.stringify(calls <= 10 ? { answers: { focus_start: { choice: "bad" } } } : jevAnswers()), { status: 200 });
    }) as typeof fetch;
    const first = await makeTake(dir, { apiKey: KEY, fetchImpl: fake, log: () => {}, warn: () => {} });
    assert.ok(first.decisions.every((d) => d.decided_by === "heuristic"));
    const before = calls;
    await makeTake(dir, { apiKey: KEY, fetchImpl: fake, log: () => {}, warn: () => {} });
    assert.ok(calls > before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid caps refuse before any Jev call", async () => {
  const dir = newTake();
  try {
    let calls = 0;
    for (const maxTokens of [NaN, Infinity, 0, -1]) {
      await assert.rejects(makeTake(dir, { apiKey: KEY, maxTokens, fetchImpl: (async () => { calls++; throw new Error("unexpected"); }) as typeof fetch, log: () => {}, warn: () => {} }), PreflightRefusal);
    }
    assert.equal(calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight refuses above --max-tokens before any call", async () => {
  const dir = newTake();
  try {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await assert.rejects(
      makeTake(dir, { apiKey: KEY, fetchImpl: fake, maxTokens: 10, log: () => {}, warn: () => {} }),
      (e: unknown) => e instanceof PreflightRefusal && /--no-jev/.test(e.message),
    );
    assert.equal(calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zones never leak window titles without --screen-text; beats carry word-only descriptions", async () => {
  const dir = newTake();
  try {
    const r = await makeTake(dir, { noJev: true, log: () => {}, warn: () => {} });
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
