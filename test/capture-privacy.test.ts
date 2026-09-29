/** Capture privacy switches: titles dropped, cache hashes only, no coords in current_shot. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTake, type MakeOptions, type MakeResult } from "../src/make.ts";
import { main } from "../src/cli.ts";
import { DecisionCache } from "../src/decide/jev.ts";
import { DEFAULTS } from "../src/camera/defaults.ts";
import type { JevAnswers, TakeMeta } from "../src/types.ts";
import { hasFfmpeg } from "./helpers.ts";

const needsFfmpeg = hasFfmpeg() ? undefined : "requires system ffmpeg and ffprobe on PATH";
const TITLE = "Quarterly report";
const KEY = "test-key-000";
const FAST = { ...DEFAULTS, preset: "veryfast", out_w: 320, out_h: 180, ripple_ms: 0, fade_s: 0 };
function fastTake(dir: string, opts: MakeOptions = {}): Promise<MakeResult> {
  return makeTake(dir, { camera: FAST, log: () => {}, warn: () => {}, ...opts });
}

function buildTake(): string {
  const dir = mkdtempSync(join(tmpdir(), "takeone-capriv-"));
  execFileSync("ffmpeg", [
    "-nostdin", "-f", "lavfi", "-i", "color=c=gray:s=320x180:d=10:r=30",
    "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska", "-frames:v", "300", "-y", join(dir, "screen.webm"),
  ], { stdio: "ignore" });
  const lines: string[] = [];
  for (let i = 0; i < 300; i++) lines.push(`${i * 3000}\t${i * 33333333}`);
  writeFileSync(join(dir, "frames.tsv"), lines.join("\n") + "\n");
  const events = [
    { t: 100, k: "win", cls: "chromium", title: TITLE, rect: [0, 0, 320, 180] },
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
  const take: TakeMeta = { id: "t1", stream: { w: 320, h: 180 }, scale: 1, offset_ms: 0, pointer: "hyprland" };
  writeFileSync(join(dir, "take.json"), JSON.stringify(take, null, 1));
  return dir;
}

/** Every file under dir, except the rendered video binaries. */
function takeFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!p.endsWith(".mp4")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Stub planner: valid answers shaped to each request's zones; records bodies. */
function stubPlanner(bodies: string[]): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body);
    bodies.push(body);
    const names = Object.keys(JSON.parse(body).state.zones);
    const probabilities = Object.fromEntries(names.map((name, i) => [name, i === 0 ? 1 : 0]));
    const answers: JevAnswers = {
      focus_start: { choice: names[0], probabilities, confidence: 1 },
      focus_end: { choice: names[0], probabilities, confidence: 1 },
      tightness: { probabilities: [0.1, 0.1, 0.7, 0.1], confidence: 0.9 },
      new_subject: { p: 0.2 },
    };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 800 } }), { status: 200 });
  }) as typeof fetch;
}

test("DecisionCache omitRequestBody stores hash and response only, hits still work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-capcache-"));
  try {
    const path = join(dir, "jev-cache.jsonl");
    const cache = new DecisionCache(path, { omitRequestBody: true });
    const body = JSON.stringify({ secret: "request-body-marker" });
    cache.put(body, { ok: true });
    const raw = readFileSync(path, "utf8");
    assert.ok(!raw.includes("request-body-marker"), "no request body on disk");
    const line = JSON.parse(raw.trim());
    assert.equal(typeof line.key, "string");
    assert.equal(line.key.length, 64);
    assert.deepEqual(line.response, { ok: true });
    assert.ok(cache.get(body), "in-memory hit");
    assert.deepEqual(new DecisionCache(path).get(body)?.response, { ok: true }, "reloaded hit");

    const plain = new DecisionCache(join(dir, "plain.jsonl"));
    plain.put(body, { ok: true });
    assert.ok(readFileSync(join(dir, "plain.jsonl"), "utf8").includes("request-body-marker"),
      "standalone cache keeps the body");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture make drops titles, coords and cache bodies; standalone keeps them", { skip: needsFfmpeg }, async () => {
  const dir = buildTake();
  try {
    const bodies: string[] = [];
    const r = await fastTake(dir, { capture: true, apiKey: KEY, fetchImpl: stubPlanner(bodies) });
    assert.ok(bodies.length > 0, "planner was consulted");
    for (const b of bodies) {
      const shot = JSON.parse(b).state.current_shot as string;
      assert.ok(!/\d,\d/.test(shot), `current_shot carries no coordinates: ${shot}`);
    }
    for (const f of takeFiles(dir)) {
      assert.ok(!readFileSync(f, "utf8").includes(TITLE), `no title in ${f}`);
    }
    const cachePath = join(dir, "analysis", "jev-cache.jsonl");
    assert.ok(existsSync(cachePath));
    const raw = readFileSync(cachePath, "utf8");
    assert.ok(!raw.includes("Framing"), "no request prompt text in the cache file");
    for (const line of raw.trim().split("\n")) {
      const e = JSON.parse(line);
      assert.equal(e.request, "");
      assert.equal(typeof e.key, "string");
      assert.ok(e.response !== undefined);
    }
    assert.ok(r.decisions.some((d) => d.decided_by === "jev"));

    // Cache hits still work: a second run makes no planner calls.
    const calls = bodies.length;
    await fastTake(dir, { capture: true, apiKey: KEY, fetchImpl: stubPlanner(bodies) });
    assert.equal(bodies.length, calls, "second run is all cache hits");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("standalone make keeps coords, cache bodies and titles", { skip: needsFfmpeg }, async () => {
  const dir = buildTake();
  try {
    const bodies: string[] = [];
    await fastTake(dir, { apiKey: KEY, fetchImpl: stubPlanner(bodies) });
    assert.ok(bodies.length > 0);
    assert.ok(bodies.map((b) => JSON.parse(b).state.current_shot as string).join(" ").match(/\d,\d/),
      "standalone current_shot keeps coordinates");
    assert.ok(readFileSync(join(dir, "events.jsonl"), "utf8").includes(TITLE), "standalone keeps titles");
    const line = JSON.parse(readFileSync(join(dir, "analysis", "jev-cache.jsonl"), "utf8").trim().split("\n")[0]!);
    assert.ok(typeof line.request === "string" && line.request.includes("current_shot"),
      "standalone cache keeps the request body");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture make via the CLI scrubs the take dir; takeone make does not", { skip: needsFfmpeg }, async () => {
  const dir = buildTake();
  try {
    const sets = ["--set", "preset=veryfast", "--set", "out_w=320", "--set", "out_h=180",
      "--set", "ripple_ms=0", "--set", "fade_s=0"];
    assert.equal(await main(["capture", "make", dir, "--no-planner", ...sets]), 0);
    assert.ok(statSync(join(dir, "out", "t1.mp4")).size > 0);
    for (const f of takeFiles(dir)) {
      assert.ok(!readFileSync(f, "utf8").includes(TITLE), `no title in ${f}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const plain = buildTake();
  try {
    const sets = ["--set", "preset=veryfast", "--set", "out_w=320", "--set", "out_h=180",
      "--set", "ripple_ms=0", "--set", "fade_s=0"];
    assert.equal(await main(["make", plain, "--no-jev", ...sets]), 0);
    assert.ok(readFileSync(join(plain, "events.jsonl"), "utf8").includes(TITLE),
      "standalone make leaves events.jsonl alone");
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});
