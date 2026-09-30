/** Real `capture` output validated against the vendored recorder-protocol-1.json.
 * No validator dependency: the schema only uses type/required/properties/enum/
 * pattern/items/oneOf/const, so a small hand check covers the whole file. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../cli.js");
// Works from both src/test (ts) and dist/test (built js).
const schemaPath = join(here, "../../test/fixtures/recorder-protocol-1.json");

type Schema = { [k: string]: any };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkType(v: unknown, t: string): boolean {
  switch (t) {
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "string": return typeof v === "string";
    case "boolean": return typeof v === "boolean";
    case "array": return Array.isArray(v);
    case "object": return isObj(v);
    case "null": return v === null;
    default: throw new Error(`unsupported schema type: ${t}`);
  }
}

/** All error strings; empty means the value conforms. */
function validate(s: Schema, v: unknown, path: string): string[] {
  const errs: string[] = [];
  if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(v)) {
    errs.push(`${path}: not the const ${JSON.stringify(s.const)}`);
  }
  if (s.type !== undefined) {
    if (!checkType(v, s.type)) {
      errs.push(`${path}: expected ${s.type}, got ${JSON.stringify(v)?.slice(0, 80)}`);
      return errs;
    }
  }
  if (s.enum !== undefined && !s.enum.includes(v)) errs.push(`${path}: not in enum`);
  if (typeof v === "string" && s.pattern !== undefined && !new RegExp(s.pattern).test(v)) {
    errs.push(`${path}: fails pattern ${s.pattern}`);
  }
  if (Array.isArray(v) && s.items !== undefined) {
    v.forEach((e, i) => errs.push(...validate(s.items, e, `${path}[${i}]`)));
  }
  if (isObj(v)) {
    for (const k of s.required ?? []) if (!(k in v)) errs.push(`${path}: missing required ${k}`);
    for (const [k, sub] of Object.entries(s.properties ?? {})) {
      if (k in v) errs.push(...validate(sub as Schema, v[k], `${path}.${k}`));
    }
  }
  if (s.oneOf !== undefined) {
    const matches = (s.oneOf as Schema[]).filter((sub) => validate(sub, v, path).length === 0);
    if (matches.length !== 1) errs.push(`${path}: oneOf matched ${matches.length}, want exactly 1`);
  }
  return errs;
}

const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Schema;

function assertWire(label: string, line: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    assert.fail(`${label}: stdout is not JSON: ${line.slice(0, 120)}`);
  }
  const errs = validate(schema, value, label);
  assert.deepEqual(errs, [], `${label} breaks recorder-protocol-1.json`);
  return value;
}

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", join(here, "fake-secrets.js"), cli, ...args], {
    encoding: "utf8",
    timeout: 300_000,
    env: { ...process.env, ...env },
  });
}

test("vendored schema is the pinned BYOKit text", () => {
  const sha = createHash("sha256").update(readFileSync(schemaPath)).digest("hex");
  assert.equal(sha, "be4c63efb56bca64ce3b6a7fa9a32535c7ba6e5b965518ae025f4524f18647f0");
});

test("capture hello conforms to recorder-protocol-1.json", () => {
  const home = mkdtempSync(join(tmpdir(), "takeone-capschema-"));
  try {
    const r = run(["capture", "hello"], { HOME: home, TYPESAFE_API_KEY: "" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split("\n").length, 1);
    assertWire("hello", r.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("capture error envelopes conform to recorder-protocol-1.json", () => {
  const home = mkdtempSync(join(tmpdir(), "takeone-capschema-"));
  try {
    const cases: { args: string[]; status: number }[] = [
      { args: ["capture", "bogus"], status: 2 },
      { args: ["capture", "hello", "extra"], status: 2 },
      { args: ["capture", "make"], status: 2 },
      { args: ["capture", "make", join(home, "nope"), "--no-planner"], status: 1 },
    ];
    for (const c of cases) {
      const r = run(c.args, { HOME: home });
      assert.equal(r.status, c.status, c.args.join(" "));
      assertWire(`error ${c.args.join(" ")}`, r.stdout);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

let ffmpegCache: boolean | undefined;
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

test("capture make --no-planner output conforms to recorder-protocol-1.json", {
  skip: hasFfmpeg() ? undefined : "requires system ffmpeg on PATH",
}, () => {
  const home = mkdtempSync(join(tmpdir(), "takeone-capschema-"));
  const dir = mkdtempSync(join(tmpdir(), "takeone-capschema-take-"));
  try {
    execFileSync("ffmpeg", [
      "-nostdin", "-f", "lavfi", "-i", "color=c=gray:s=320x180:d=4:r=30",
      "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska", "-frames:v", "120", "-y", join(dir, "screen.webm"),
    ], { stdio: "ignore" });
    const lines: string[] = [];
    for (let i = 0; i < 120; i++) lines.push(`${i * 3000}\t${i * 33333333}`);
    writeFileSync(join(dir, "frames.tsv"), lines.join("\n") + "\n");
    writeFileSync(join(dir, "events.jsonl"),
      [{ t: 100, k: "win", cls: "chromium", title: "Report", rect: [0, 0, 320, 180] },
       { t: 400, k: "ptr", x: 200, y: 90 }].map((e) => JSON.stringify(e)).join("\n") + "\n");
    writeFileSync(join(dir, "take.json"), JSON.stringify({
      id: "t1", stream: { w: 320, h: 180 }, scale: 1, offset_ms: 0, pointer: "hyprland",
    }));
    const r = run(["capture", "make", dir, "--no-planner",
      "--set", "preset=veryfast", "--set", "out_w=320", "--set", "out_h=180",
      "--set", "ripple_ms=0", "--set", "fade_s=0"], { HOME: home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split("\n").length, 1);
    const out = assertWire("make", r.stdout) as { out: string };
    assert.ok(existsSync(out.out) && out.out.endsWith(".mp4"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
