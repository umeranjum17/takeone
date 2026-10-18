/** `takeone capture make` over a tiny synthetic take, via the built CLI. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { makeTake } from "../make.ts";
import { IDLE_GAP_MS } from "../beats/segment.ts";
import { idleSqueezes } from "../render/pace.ts";
import { DEFAULTS } from "../camera/defaults.ts";
import type { Beat as RenderBeat } from "../camera/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../cli.js");

let ffmpegCache: boolean | undefined;
/** Video tests skip explicitly where system ffmpeg is absent (CI installs it). */
function hasFfmpeg(): boolean {
  ffmpegCache ??= ((): boolean => {
    try {
      execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  return ffmpegCache;
}
const needsFfmpeg = hasFfmpeg() ? undefined : "requires system ffmpeg on PATH";

// Tiny test renders: 320x180 veryfast keeps CI encodes to seconds.
const FAST_SET = ["--set", "preset=veryfast", "--set", "out_w=320", "--set", "out_h=180",
  "--set", "ripple_ms=0", "--set", "fade_s=0"];

function buildTake(): string {
  const dir = mkdtempSync(join(tmpdir(), "takeone-capmake-"));
  // 10 s solid grey at 30 fps; mpeg4/matroska keeps weak CI runners moving
  // (software VP9 stalls them; the input codec is incidental).
  execFileSync("ffmpeg", [
    "-nostdin", "-f", "lavfi", "-i", "color=c=gray:s=320x180:d=10:r=30",
    "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska", "-frames:v", "300", "-y", join(dir, "screen.webm"),
  ], { stdio: "ignore" });
  const lines: string[] = [];
  for (let i = 0; i < 300; i++) lines.push(`${i * 3000}\t${i * 33333333}`);
  writeFileSync(join(dir, "frames.tsv"), lines.join("\n") + "\n");
  const events = [
    { t: 100, k: "win", cls: "chromium", title: "Quarterly report", rect: [0, 0, 320, 180] },
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
  writeFileSync(join(dir, "take.json"), JSON.stringify({
    id: "t1", stream: { w: 320, h: 180 }, scale: 1, offset_ms: 0, pointer: "hyprland",
  }, null, 1));
  return dir;
}

/** Video-only take with a long static middle: grey 6 s, white 2 s, grey 6 s, white 3 s. */
function buildVideoOnlyStaticMiddleTake(): string {
  const dir = mkdtempSync(join(tmpdir(), "takeone-vidonlymid-"));
  execFileSync("ffmpeg", [
    "-nostdin",
    "-f", "lavfi", "-i", "color=c=gray:s=320x180:d=6:r=30",
    "-f", "lavfi", "-i", "color=c=white:s=320x180:d=2:r=30",
    "-f", "lavfi", "-i", "color=c=gray:s=320x180:d=6:r=30",
    "-f", "lavfi", "-i", "color=c=white:s=320x180:d=3:r=30",
    "-filter_complex", "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0",
    "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska", "-y", join(dir, "screen.webm"),
  ], { stdio: "ignore" });
  const lines: string[] = [];
  for (let i = 0; i < 510; i++) lines.push(`${i * 3000}\t${i * 33333333}`);
  writeFileSync(join(dir, "frames.tsv"), lines.join("\n") + "\n");
  writeFileSync(join(dir, "take.json"), JSON.stringify({
    id: "t1", stream: { w: 320, h: 180 }, scale: 1, offset_ms: 0, pointer: "none", events: "none",
  }, null, 1));
  return dir;
}

/** Video-only take: 5 s of static grey, then a hard cut to white. No events.jsonl. */
function buildVideoOnlyTake(): string {
  const dir = mkdtempSync(join(tmpdir(), "takeone-videonly-"));
  execFileSync("ffmpeg", [
    "-nostdin",
    "-f", "lavfi", "-i", "color=c=gray:s=320x180:d=5:r=30",
    "-f", "lavfi", "-i", "color=c=white:s=320x180:d=5:r=30",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0",
    "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska", "-y", join(dir, "screen.webm"),
  ], { stdio: "ignore" });
  const lines: string[] = [];
  for (let i = 0; i < 300; i++) lines.push(`${i * 3000}\t${i * 33333333}`);
  writeFileSync(join(dir, "frames.tsv"), lines.join("\n") + "\n");
  writeFileSync(join(dir, "take.json"), JSON.stringify({
    id: "t1", stream: { w: 320, h: 180 }, scale: 1, offset_ms: 0, pointer: "none", events: "none",
  }, null, 1));
  return dir;
}

function writeKeyFile(dir: string, key = "sk-test-key"): string {
  const path = join(dir, "key");
  writeFileSync(path, key);
  return path;
}

function run(args: string[], o: { env?: NodeJS.ProcessEnv; keyFile?: string } = {}) {
  let keyFd: number | undefined;
  try {
    const stdio: ("ignore" | "pipe" | number)[] = ["ignore", "pipe", "pipe"];
    if (o.keyFile !== undefined) {
      keyFd = openSync(o.keyFile, "r");
      stdio.push(keyFd); // array index 3 becomes the child's fd 3
    }
    return spawnSync(process.execPath, ["--import", join(here, "fake-secrets.js"), cli, ...args], {
      encoding: "utf8",
      timeout: 300_000,
      stdio: stdio as ["ignore", "pipe", "pipe", number?],
      env: { ...process.env, ...o.env },
    });
  } finally {
    if (keyFd !== undefined) closeSync(keyFd);
  }
}

function withHome() {
  const home = mkdtempSync(join(tmpdir(), "takeone-caphome-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("capture make --no-planner renders and prints one JSON object", { skip: needsFfmpeg }, async () => {
  const { home, cleanup } = withHome();
  const dir = buildTake();
  try {
    const r = run(["capture", "make", dir, "--no-planner", ...FAST_SET], { env: { HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split("\n").length, 1, "stdout carries exactly one JSON object");
    const out = JSON.parse(r.stdout);
    assert.equal(out.out, join(dir, "out", "t1.mp4"));
    assert.ok(out.seconds > 0);
    assert.ok(out.beats > 0);
    assert.deepEqual(out.planner, { planned_tokens: 0, input_tokens: 0, usd: 0, failed: false });
    assert.ok(Array.isArray(out.warnings));
    assert.ok(existsSync(join(dir, "out", "t1.mp4")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});

test("capture make --plan-only prices the plan without network or render", { skip: needsFfmpeg }, async () => {
  const { home, cleanup } = withHome();
  const dir = buildTake();
  try {
    const keyFile = writeKeyFile(dir);
    const r = run(["capture", "make", dir, "--plan-only", "--planner-key-fd", "3"], {
      env: { HOME: home }, keyFile,
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.out, null);
    assert.equal(out.seconds, 0);
    assert.ok(out.beats > 0);
    assert.ok(out.planner.planned_tokens > 0);
    assert.ok(out.planner.usd > 0);
    assert.equal(out.planner.input_tokens, 0);
    assert.ok(!existsSync(join(dir, "out")), "plan-only renders nothing");
    assert.ok(!r.stdout.includes("sk-test-key") && !r.stderr.includes("sk-test-key"),
      "the fd key is never printed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});

test("doctor, make and capture never read the planner key from the environment", { skip: needsFfmpeg }, async () => {
  const { home, cleanup } = withHome();
  const dir = buildTake();
  const env = { HOME: home, TYPESAFE_API_KEY: "bogus-env-key" };
  try {
    // All three read the key the same way: an env key is no key.
    const doctor = run(["doctor"], { env });
    assert.match(doctor.stdout, /ai-planner,false,planner,"?AI planner off/, doctor.stdout);
    const hello = run(["capture", "hello"], { env });
    assert.equal(hello.status, 0, hello.stderr);
    assert.equal(JSON.parse(hello.stdout).planner.available, false);
    const made = run(["make", dir, ...FAST_SET], { env });
    assert.equal(made.status, 0, made.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, "take.json"), "utf8")).planner.mode, "fallback");
    for (const r of [doctor, hello, made]) assert.ok(!r.stdout.includes("bogus-env-key") && !r.stderr.includes("bogus-env-key"));
    // A bogus env key must behave exactly like no key: zero planned tokens and
    // no preflight refusal even under --max-tokens 1.
    const r = run(["capture", "make", dir, "--plan-only", "--max-tokens", "1"], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).planner,
      { planned_tokens: 0, input_tokens: 0, usd: 0, failed: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});

test("capture make --title/--captions land in take.json", { skip: needsFfmpeg }, async () => {
  const { home, cleanup } = withHome();
  const dir = buildTake();
  try {
    const captionsFile = join(dir, "captions.json");
    writeFileSync(captionsFile, JSON.stringify([
      { t: 1.5, text: "Hello world" },
      { t: 5, d: 2, text: "Second" },
    ]));
    const r = run(["capture", "make", dir, "--no-planner",
      "--title", "Smoke title", "--captions", captionsFile, ...FAST_SET], { env: { HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    const take = JSON.parse(readFileSync(join(dir, "take.json"), "utf8"));
    assert.equal(take.title, "Smoke title");
    assert.deepEqual(take.captions, [
      { t: 1.5, text: "Hello world" },
      { t: 5, text: "Second", d: 2 },
    ]);
    assert.ok(existsSync(join(dir, "out", "t1.mp4")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});

test("capture make refusal carries planned and cap with exit 1", { skip: needsFfmpeg }, async () => {
  const { home, cleanup } = withHome();
  const dir = buildTake();
  try {
    const keyFile = writeKeyFile(dir);
    const r = run(["capture", "make", dir, "--plan-only", "--planner-key-fd", "3", "--max-tokens", "1"], {
      env: { HOME: home }, keyFile,
    });
    assert.equal(r.status, 1, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error.code, "preflight-refused");
    assert.ok(out.error.planned > 0 && out.error.cap === 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});

test("capture make render failure uses the envelope with exit 1", { skip: needsFfmpeg }, async () => {
  const { home, cleanup } = withHome();
  const dir = buildTake();
  try {
    const takePath = join(dir, "take.json");
    const take = JSON.parse(readFileSync(takePath, "utf8"));
    take.id = "../../other";
    writeFileSync(takePath, JSON.stringify(take));
    const r = run(["capture", "make", dir, "--no-planner", ...FAST_SET], { env: { HOME: home } });
    assert.equal(r.status, 1, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error.code, "render-failed");
    assert.equal(typeof out.error.message, "string");
    assert.equal(typeof out.error.hint, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});

test("capture make with an fd key stops loudly when planner.json names account auth", async () => {
  const { home, cleanup } = withHome();
  const dir = buildTake();
  try {
    mkdirSync(join(home, ".config", "takeone"), { recursive: true });
    writeFileSync(join(home, ".config", "takeone", "planner.json"), JSON.stringify({
      backend: "opencode-go",
      auth: "account",
      model: "opencode-go/muse-spark-1.3-contributor",
    }));
    const keyFile = writeKeyFile(dir);
    const r = run(["capture", "make", dir, "--plan-only", "--planner-key-fd", "3"], {
      env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") }, keyFile,
    });
    assert.equal(r.status, 1, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error.code, "planner-config");
    assert.match(out.error.message, /account sign-in/);
    assert.ok(!existsSync(join(dir, "out")), "nothing rendered on a planner-config stop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});

test("capture make usage errors use the envelope with exit 2", { skip: needsFfmpeg }, async () => {
  const { home, cleanup } = withHome();
  const dir = buildTake();
  try {
    const keyFile = writeKeyFile(dir);
    const cases: { args: string[]; keyFile?: string }[] = [
      { args: ["capture", "make"] },
      { args: ["capture", "make", dir, "--no-planner", "--planner-key-fd", "3"], keyFile },
      { args: ["capture", "make", dir, "--planner-key-fd", "99"] },
      { args: ["capture", "make", dir, "--max-tokens", "banana"] },
      { args: ["capture", "make", dir, "--captions", join(dir, "missing.json")] },
      { args: ["capture", "make", dir, "--bogus"] },
    ];
    for (const c of cases) {
      const r = run(c.args, { env: { HOME: home }, ...(c.keyFile ? { keyFile: c.keyFile } : {}) });
      assert.equal(r.status, 2, c.args.join(" "));
      assert.equal(JSON.parse(r.stdout).error.code, "invalid-arguments");
    }
    const missing = run(["capture", "make", join(dir, "nope"), "--no-planner"], { env: { HOME: home } });
    assert.equal(missing.status, 1);
    assert.equal(JSON.parse(missing.stdout).error.code, "take-input");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});

test("makeTake planOnly prices the plan with zero planner calls", { skip: needsFfmpeg }, async () => {
  const dir = buildTake();
  try {
    let calls = 0;
    const r = await makeTake(dir, {
      planOnly: true,
      apiKey: "test-key",
      fetchImpl: (() => {
        calls++;
        throw new Error("plan-only must make no planner calls");
      }) as unknown as typeof fetch,
      log: () => {},
      warn: () => {},
    });
    assert.equal(calls, 0);
    assert.ok(r.planned.planned_tokens > 0);
    assert.ok(r.planned.usd !== null);
    assert.ok(r.planned.usd > 0);
    assert.equal(r.out, null);
    assert.equal(r.seconds, 0);
    assert.ok(r.beats.length > 0);
    assert.ok(!existsSync(join(dir, "out")), "plan-only renders nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Video-only takes (no input events) open just before the first visual
  // change: 5 s of static grey, then a hard cut, plans its first beat at 4.5 s.
  const silent = buildVideoOnlyTake();
  try {
    const v = await makeTake(silent, {
      planOnly: true,
      apiKey: null,
      log: () => {},
      warn: () => {},
    });
    assert.ok(v.beats.length > 0);
    assert.equal(v.beats[0]!.t0, 4500);
    assert.ok(v.beats.some((b) => b.kind === "change" || b.kind === "cut"));
  } finally {
    rmSync(silent, { recursive: true, force: true });
  }
  // A long static stretch in the middle of a video-only take becomes an idle
  // beat, so the render's shared idle pacing squeezes it like event idle time:
  // changes at ~6/8/14 s leave the 8-14 s gap static.
  const mid = buildVideoOnlyStaticMiddleTake();
  try {
    const v = await makeTake(mid, {
      planOnly: true,
      apiKey: null,
      log: () => {},
      warn: () => {},
    });
    assert.equal(v.beats[0]!.t0, 5500);
    const idle = v.beats.find((b) => b.kind === "idle" && b.t1 - b.t0 >= IDLE_GAP_MS
      && b.t0 >= 7000 && b.t0 <= 9000 && b.t1 >= 13000 && b.t1 <= 15000);
    assert.ok(idle, `no idle beat spans the static middle: ${JSON.stringify(v.beats.map((b) => [b.kind, b.t0, b.t1]))}`);
    for (const b of v.beats) {
      if (b.kind !== "change" && b.kind !== "cut") continue;
      assert.ok(b.t1 <= 9000 || b.t0 >= 13000,
        `change beat spans the static middle: ${b.kind} ${b.t0}-${b.t1}`);
    }
    // The render path sees that gap as squeezable idle time (video seconds;
    // the fixture's video clock starts at 0 and the head trim starts at 5.5 s).
    const renderBeats: RenderBeat[] = v.beats.map((b) => ({
      id: b.id, t0: b.t0 / 1000, t1: b.t1 / 1000, anchor_t: b.anchor_t / 1000,
      kind: b.kind, actions: [],
      zones: b.zones.map((z) => ({ name: z.name, type: z.kind, bbox: z.bbox,
        ...(z.t !== undefined ? { t_change: z.t / 1000 } : {}) })),
    }));
    const squeezes = idleSqueezes(renderBeats, 5.5, 17, DEFAULTS);
    const mid_ = squeezes.find((s) => s.b - s.a >= 3
      && s.a + 5.5 >= 8 && s.a + 5.5 <= 10.5 && s.b + 5.5 >= 12.5 && s.b + 5.5 <= 14);
    assert.ok(mid_, `no idle squeeze covers the static middle: ${JSON.stringify(squeezes)}`);
  } finally {
    rmSync(mid, { recursive: true, force: true });
  }
});
