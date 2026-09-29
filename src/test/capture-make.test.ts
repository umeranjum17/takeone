/** `takeone capture make` over a tiny synthetic take, via the built CLI. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { makeTake } from "../make.ts";

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
    return spawnSync(process.execPath, [cli, ...args], {
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
    assert.deepEqual(out.planner, { planned_tokens: 0, input_tokens: 0, usd: 0, failed: 0 });
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

test("capture make never reads the planner key from the environment", { skip: needsFfmpeg }, async () => {
  const { home, cleanup } = withHome();
  const dir = buildTake();
  try {
    // A bogus env key must behave exactly like no key: zero planned tokens and
    // no preflight refusal even under --max-tokens 1.
    const r = run(["capture", "make", dir, "--plan-only", "--max-tokens", "1"], {
      env: { HOME: home, TYPESAFE_API_KEY: "bogus-env-key" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).planner,
      { planned_tokens: 0, input_tokens: 0, usd: 0, failed: 0 });
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
    assert.ok(out.planned > 0 && out.cap === 1);
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
    assert.ok(r.planned.usd > 0);
    assert.equal(r.out, null);
    assert.equal(r.seconds, 0);
    assert.ok(r.beats.length > 0);
    assert.ok(!existsSync(join(dir, "out")), "plan-only renders nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
