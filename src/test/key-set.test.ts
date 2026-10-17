/** `takeone key set` provider choice: flags, validation and planner.json, via the built CLI. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../cli.js");

function home(): { home: string; passphrase: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "takeone-keyset-"));
  const passphrase = join(dir, "passphrase");
  writeFileSync(passphrase, "test-passphrase");
  return { home: dir, passphrase, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function childEnv(h: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["TYPESAFE_API_KEY", "TAKEONE_NO_KEYRING", "TAKEONE_SECRETS_PASSPHRASE_FD",
    "TAKEONE_TEST_NO_KEYRING", "TAKEONE_TEST_KEYRING_FAILURE", "TAKEONE_TEST_KEYRING_KEY", "XDG_CONFIG_HOME"]) {
    delete env[name];
  }
  // Sealed store only: no OS keyring is touched, and the store dir is throwaway.
  return { ...env, HOME: h, XDG_CONFIG_HOME: join(h, ".config"), TAKEONE_NO_KEYRING: "1", TAKEONE_SECRETS_PASSPHRASE_FD: "3" };
}

function run(args: string[], h: { home: string; passphrase: string }, input?: string) {
  const passFd = openSync(h.passphrase, "r");
  try {
    return spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      input,
      stdio: ["pipe", "pipe", "pipe", passFd],
      env: childEnv(h.home),
    });
  } finally {
    closeSync(passFd);
  }
}

function plannerJson(h: string): Record<string, unknown> | null {
  const p = join(h, ".config", "takeone", "planner.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown> : null;
}

test("key set records the provider choice and stores the key", () => {
  const h = home();
  try {
    const r = run(["key", "set", "--backend", "jev", "--model", "jev-latest"], h, "sk-test-key\n");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /jev \(jev-latest\)/);
    assert.deepEqual(plannerJson(h.home), { backend: "jev", auth: "apiKey", model: "jev-latest" });
    // The stored key answers through the sealed store alone.
    const helloFd = openSync(h.passphrase, "r");
    try {
      const hello = spawnSync(process.execPath, [cli, "capture", "hello"], {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe", helloFd],
        env: childEnv(h.home),
      });
      assert.equal(hello.status, 0, hello.stderr);
      assert.equal(JSON.parse(hello.stdout).planner.available, true);
    } finally {
      closeSync(helloFd);
    }
  } finally {
    h.cleanup();
  }
});

test("key set --via openrouter records the route", () => {
  const h = home();
  try {
    const r = run(["key", "set", "--via", "openrouter"], h, "sk-test-key\n");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(plannerJson(h.home), { backend: "jev", auth: "apiKey", via: "openrouter" });
  } finally {
    h.cleanup();
  }
});

test("key set without flags keeps the old Jev-only behaviour", () => {
  const h = home();
  try {
    const r = run(["key", "set"], h, "sk-test-key\n");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Jev key stored/);
    assert.equal(plannerJson(h.home), null, "flagless key set writes no planner.json");
  } finally {
    h.cleanup();
  }
});

test("key set rejects unknown backends and missing models", () => {
  const h = home();
  try {
    for (const args of [
      ["key", "set", "--backend", "bogus", "--model", "x"],
      ["key", "set", "--backend", "openai"],
      ["key", "set", "--backend", "anthropic"],
      ["key", "set", "--backend", "opencode-go"],
      ["key", "set", "--bogus"],
    ]) {
      const r = run(args, h, "sk-test-key\n");
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.status} ${r.stderr}`);
      assert.equal(plannerJson(h.home), null, `${args.join(" ")} wrote planner.json`);
    }
  } finally {
    h.cleanup();
  }
});
