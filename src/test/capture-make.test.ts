/** `takeone capture make` over a tiny synthetic take, via the built CLI. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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

/** A PATH with only the ffmpeg tools: planner discovery must not see the
 * developer's installed Claude or Codex CLI. */
function ffmpegToolsPath(home: string): string {
  const dir = join(home, "bin");
  mkdirSync(dir);
  for (const name of ["ffmpeg", "ffprobe"]) {
    const found = (process.env.PATH ?? "").split(delimiter).map((entry) => join(entry, name)).find((path) => existsSync(path));
    if (found !== undefined) symlinkSync(found, join(dir, name));
  }
  return dir;
}

/** What the signed-in Claude stand-in below costs a planned take, from capture make's own report. */
const PLANNER_STATS = { planned_tokens: 5360, input_tokens: 2, usd: 0, failed: false };

/** A home whose only AI is the signed-in Claude stand-in below, with the ffmpeg tools on PATH:
 * what `--planner-account` resolves in these tests. */
function accountEnv(home: string): NodeJS.ProcessEnv {
  const tools = ffmpegToolsPath(home);
  const engine = join(home, "engine");
  signedInClaudeCli(engine);
  return { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: `${engine}${delimiter}${tools}` };
}

/** A stand-in for the person's installed Claude CLI, signed in through a
 * claude.ai subscription: `auth status` reports the sign-in, `-p` answers the
 * decided schema and appends one line to `calls` so a test can prove the
 * account actually served the run. */
function signedInClaudeCli(binDir: string, calls?: string): string {
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, "claude");
  writeFileSync(bin, `#!${process.execPath}
${calls === undefined ? "" : `const { appendFileSync } = require("node:fs");`}
const args = process.argv.slice(2);
if (args.includes("auth") && args.includes("status")) {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }) + "\\n");
} else if (args[0] === "-p") {
  ${calls === undefined ? "" : `appendFileSync(${JSON.stringify(calls)}, args.join(" ") + "\\n");`}
  const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
  const answers = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    if (property.properties?.ranking) answers[name] = { ranking: property.properties.ranking.items.enum, confidence: 0.9 };
    else {
      const keys = Object.keys(property.properties.probabilities.properties);
      answers[name] = { probabilities: Object.fromEntries(keys.map((key, index) => [key, keys.length === 1 ? 1 : index === 0 ? 0.9 : 0.1 / (keys.length - 1)])), pick: keys[0] };
      for (const key of property.required) if (!(key in answers[name])) answers[name][key] = "fixture";
    }
  }
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: "fixture", structured_output: answers, usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
} else process.exit(2);
`);
  chmodSync(bin, 0o755);
  return bin;
}

test("doctor and make use a signed-in installed Claude CLI without a planner key", { skip: needsFfmpeg }, async () => {
  const { home, cleanup } = withHome();
  const dir = mkdtempSync(join(tmpdir(), "takeone-cli-account-"));
  const binDir = join(dir, "bin");
  signedInClaudeCli(binDir);
  const take = buildTake();
  try {
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    };
    const doctor = run(["doctor"], { env });
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(doctor.stdout, /ai-planner,true,planner,.*found and using signed-in Claude account/);
    const made = run(["make", take, ...FAST_SET], { env });
    assert.equal(made.status, 0, made.stderr);
    assert.match(made.stdout, /AI planner: signed-in Claude account/);
    assert.match(made.stdout, /choices by AI/);
    assert.equal(JSON.parse(readFileSync(join(take, "take.json"), "utf8")).planner.mode, "ai");
    assert.ok(!/set a key|paste.*key/i.test(made.stdout + made.stderr));
  } finally {
    rmSync(take, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});

// This used to prove capture stayed on local rules; it now proves capture never plans on its own:
// without a host key or --planner-account it stops, and the account is used only when the flag allows it.
test("capture make without a planner key stays local even when an account is signed in", { skip: needsFfmpeg }, async () => {
  const { home, cleanup } = withHome();
  const dir = mkdtempSync(join(tmpdir(), "takeone-cap-account-off-"));
  const calls = join(dir, "claude-calls.log");
  const binDir = join(dir, "bin");
  signedInClaudeCli(binDir, calls);
  const take = buildTake();
  try {
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: `${binDir}:${ffmpegToolsPath(home)}` };
    const stopped = run(["capture", "make", take, ...FAST_SET], { env });
    assert.equal(stopped.status, 1, stopped.stderr);
    const stop = JSON.parse(stopped.stdout);
    // Capture's host-owned credential contract: no host key and no flag, no account and no local rules.
    assert.equal(stop.error.code, "planner-unavailable");
    assert.match(stop.error.message, /needs an AI engine/);
    assert.match(stop.error.hint, /--planner-key-fd 3.*--planner-account/);
    assert.equal(stop.planner, undefined);
    assert.ok(!existsSync(join(take, "out")) && !existsSync(join(take, "analysis")), "nothing planned or rendered on the stop");
    assert.ok(!existsSync(calls), "the signed-in account was never asked");
    // With the flag the same take plans through that account.
    const r = run(["capture", "make", take, "--planner-account", ...FAST_SET], { env });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.planner, PLANNER_STATS);
    assert.equal(out.warnings.includes("no planner key; using heuristic policy for all beats"), false, out.warnings.join("; "));
    assert.equal(JSON.parse(readFileSync(join(take, "take.json"), "utf8")).planner.mode, "ai");
    assert.ok(existsSync(join(take, "out", "t1.mp4")));
    assert.ok(existsSync(calls), "the account answered once the flag allowed it");
  } finally {
    rmSync(take, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});

test("capture make --planner-account plans through the user's signed-in account", { skip: needsFfmpeg }, async () => {
  const { home, cleanup } = withHome();
  const dir = mkdtempSync(join(tmpdir(), "takeone-cap-account-on-"));
  const calls = join(dir, "claude-calls.log");
  const binDir = join(dir, "bin");
  signedInClaudeCli(binDir, calls);
  const take = buildTake();
  try {
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: `${binDir}:${ffmpegToolsPath(home)}` };
    const r = run(["capture", "make", take, "--planner-account", ...FAST_SET], { env });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.out, join(take, "out", "t1.mp4"));
    assert.equal(out.beats > 0, true);
    // The account served the run: tokens were spent and the film was asked.
    assert.ok(out.planner.input_tokens > 0, JSON.stringify(out.planner));
    assert.equal(out.planner.failed, false);
    assert.ok(!out.warnings.some((w: string) => /no planner key|fallback rules/.test(w)), out.warnings.join("; "));
    assert.match(r.stderr, /AI planner: signed-in Claude account/);
    assert.equal(JSON.parse(readFileSync(join(take, "take.json"), "utf8")).planner.mode, "ai");
    assert.ok(existsSync(calls), "the account's CLI answered the planner calls");
    assert.ok(existsSync(join(take, "out", "t1.mp4")));
    // Capture stays privacy-scoped: window titles are dropped whatever plans.
    assert.ok(!readFileSync(join(take, "events.jsonl"), "utf8").includes("Quarterly report"));
  } finally {
    rmSync(take, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});

test("capture make --planner-account stops loudly when the user has no account", { skip: needsFfmpeg }, async () => {
  const { home, cleanup } = withHome();
  const dir = buildTake();
  try {
    // No claude or codex on PATH and no stored key: nothing can serve the run.
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: ffmpegToolsPath(home) };
    const r = run(["capture", "make", dir, "--planner-account", ...FAST_SET], { env });
    assert.equal(r.status, 1, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error.code, "planner-unavailable");
    assert.match(out.error.message, /signed-in account or stored key was not found/);
    assert.match(out.error.hint, /--planner-key-fd 3/);
    // The honest stop: no local-rules film and nothing rendered behind it.
    assert.ok(!existsSync(join(dir, "out")), "nothing rendered on a planner-unavailable stop");
    assert.ok(!r.stderr.includes("fallback rules"), r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});

// The off switch is refused now; the run that renders and prints one JSON object is the account's.
test("capture make --no-planner renders and prints one JSON object", { skip: needsFfmpeg }, async () => {
  const { home, cleanup } = withHome();
  const dir = buildTake();
  try {
    const refused = run(["capture", "make", dir, "--no-planner", ...FAST_SET], { env: { HOME: home } });
    assert.equal(refused.status, 2, refused.stderr);
    assert.equal(JSON.parse(refused.stdout).error.code, "invalid-arguments");
    assert.match(JSON.parse(refused.stdout).error.message, /unknown capture make option: --no-planner/);
    assert.ok(!existsSync(join(dir, "out")) && !existsSync(join(dir, "analysis")));
    const r = run(["capture", "make", dir, "--planner-account", ...FAST_SET], { env: accountEnv(home) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split("\n").length, 1, "stdout carries exactly one JSON object");
    const out = JSON.parse(r.stdout);
    assert.equal(out.out, join(dir, "out", "t1.mp4"));
    assert.ok(out.seconds > 0);
    assert.ok(out.beats > 0);
    assert.deepEqual(out.planner, PLANNER_STATS);
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

test("doctor, make and capture never read the planner key from the environment", async () => {
  const { home, cleanup } = withHome();
  const dir = buildTake();
  const env = { HOME: home, PATH: ffmpegToolsPath(home), TYPESAFE_API_KEY: "bogus-env-key" };
  try {
    // All three read the key the same way: an env key is no key.
    const doctor = run(["doctor"], { env });
    assert.match(doctor.stdout, /ai-planner,false,planner,"?AI planner unavailable/, doctor.stdout);
    assert.match(doctor.stdout, /sign in with claude, codex login or opencode auth login, or store a key with takeone key set/, doctor.stdout);
    const hello = run(["capture", "hello"], { env });
    assert.equal(hello.status, 0, hello.stderr);
    assert.equal(JSON.parse(hello.stdout).planner.available, false);
    const made = run(["make", dir, ...FAST_SET], { env });
    assert.equal(made.status, 3, made.stderr);
    assert.match(made.stderr, /takeone needs an AI engine/);
    assert.ok(!existsSync(join(dir, "analysis")) && !existsSync(join(dir, "out")));
    // An unreadable secret store also stops before writing any result.
    const storeDown = run(["make", dir, ...FAST_SET], { env: { ...env, TAKEONE_TEST_KEYRING_FAILURE: "1" } });
    assert.equal(storeDown.status, 3, storeDown.stderr);
    assert.match(storeDown.stderr, /takeone needs an AI engine/);
    assert.ok(!existsSync(join(dir, "analysis")) && !existsSync(join(dir, "out")));
    // doctor says what is wrong with the store and, as every stop does, how to set an engine up.
    const doctorStoreDown = run(["doctor"], { env: { ...env, TAKEONE_TEST_KEYRING_FAILURE: "1" } });
    assert.match(doctorStoreDown.stdout, /AI planner store unavailable: .*; sign in with claude, codex login or opencode auth login, or store a key with takeone key set/, doctorStoreDown.stdout);
    // The offline flag is gone from the shipped CLI, whatever the account state: it is an unknown
    // option, refused before the take is read, and nothing is planned or rendered.
    const removed = [env, { ...env, TAKEONE_TEST_KEYRING_FAILURE: "1" }].map((state) => run(["make", dir, "--no-ai", ...FAST_SET], { env: state }));
    for (const r of removed) {
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /unknown option: --no-ai/);
      assert.ok(!existsSync(join(dir, "analysis")) && !existsSync(join(dir, "out")));
    }
    // What replaces it is an engine on this computer: a signed-in Claude CLI serves the run, with the
    // secret store down as well, and the take records that the engine planned it.
    const engine = join(home, "engine");
    signedInClaudeCli(engine);
    const engineEnv = { ...env, PATH: `${engine}${delimiter}${env.PATH}` };
    const local = run(["make", dir, ...FAST_SET], { env: engineEnv });
    assert.equal(local.status, 0, local.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, "take.json"), "utf8")).planner.mode, "ai");
    const localStoreDown = run(["make", dir, ...FAST_SET], { env: { ...engineEnv, TAKEONE_TEST_KEYRING_FAILURE: "1" } });
    assert.equal(localStoreDown.status, 0, localStoreDown.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, "take.json"), "utf8")).planner.mode, "ai");
    for (const r of [doctor, hello, made, storeDown, local, localStoreDown, ...removed]) assert.ok(!r.stdout.includes("bogus-env-key") && !r.stderr.includes("bogus-env-key"));
    // A bogus env key must behave exactly like no key: capture make stops with
    // planner-unavailable, never a preflight refusal and never a plan.
    const r = run(["capture", "make", dir, "--plan-only", "--max-tokens", "1"], { env });
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).planner,
      undefined);
    assert.equal(JSON.parse(r.stdout).error.code, "planner-unavailable");
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
    const r = run(["capture", "make", dir, "--planner-account",
      "--title", "Smoke title", "--captions", captionsFile, ...FAST_SET], { env: accountEnv(home) });
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
    const r = run(["capture", "make", dir, "--planner-account", ...FAST_SET], { env: accountEnv(home) });
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
      { args: ["capture", "make", dir, "--no-planner", "--planner-account"] },
      { args: ["capture", "make", dir, "--no-planner"] },
      { args: ["capture", "make", dir, "--planner-account", "--planner-key-fd", "3"], keyFile },
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
    const missing = run(["capture", "make", join(dir, "nope"), "--planner-account"], { env: { HOME: home } });
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
      maxTokens: 100000,
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
      apiKey: "test-key",
      maxTokens: 100000,
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
      apiKey: "test-key",
      maxTokens: 100000,
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
