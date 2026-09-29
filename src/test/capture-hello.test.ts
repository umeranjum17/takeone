/** `takeone capture hello` shape + capture-scoped error envelope, via the built CLI. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../cli.js");

function repoVersion(): string {
  let dir = here;
  for (let i = 0; i < 5; i++) {
    try {
      return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error("package.json not found");
}

function run(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, ...extraEnv },
  });
}

test("capture hello prints the protocol v1 shape and exits 0", async () => {
  const home = await mkdtemp(join(tmpdir(), "takeone-cap-"));
  try {
    const r = run(["capture", "hello"], { TYPESAFE_API_KEY: "test-key", HOME: home });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      protocol: 1,
      recorder: { name: "takeone", version: repoVersion() },
      sources: ["screen", "x11"],
      android: false,
      planner: { available: true, needsKey: true },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("capture hello reports no planner without a key, never printing it", async () => {
  const home = await mkdtemp(join(tmpdir(), "takeone-cap-"));
  try {
    // empty key counts as no key; empty HOME hides ~/.config/takeone/env
    const r = run(["capture", "hello"], { HOME: home, TYPESAFE_API_KEY: "" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.planner, { available: false, needsKey: true });
    assert.ok(!r.stdout.includes("test-key"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("unknown or missing capture verb prints the envelope on stdout and exits 2", () => {
  for (const args of [["capture", "bogus"], ["capture"], ["capture", "hello", "extra"]]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(" "));
    const out = JSON.parse(r.stdout);
    assert.equal(out.error.code, "invalid-arguments");
    assert.equal(typeof out.error.message, "string");
    assert.equal(typeof out.error.hint, "string");
  }
});
