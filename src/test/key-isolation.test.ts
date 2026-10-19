/** TAKEONE_NO_KEYRING isolation, via the built CLI: a keyring that answers must
  * never surface its key into an isolated run, and the sealed file keeps working. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../cli.js");

/** A key the fake keyring holds; an isolated run must never see it. */
const POISON = "sk-host-keyring-key";

function childEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Each case declares its own credential env; nothing may leak in from the runner.
  for (const name of ["TYPESAFE_API_KEY", "TAKEONE_NO_KEYRING", "TAKEONE_SECRETS_PASSPHRASE_FD",
    "TAKEONE_TEST_NO_KEYRING", "TAKEONE_TEST_KEYRING_FAILURE", "TAKEONE_TEST_KEYRING_KEY", "XDG_CONFIG_HOME"]) {
    delete env[name];
  }
  return { ...env, PATH: "", ...extra };
}

function run(args: string[], env: NodeJS.ProcessEnv, o: { keyFile?: string; input?: string } = {}) {
  let keyFd: number | undefined;
  try {
    const stdio: ("ignore" | "pipe" | number)[] = [o.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"];
    if (o.keyFile !== undefined) {
      keyFd = openSync(o.keyFile, "r"); // array index 3 becomes the child's fd 3
      stdio.push(keyFd);
    }
    return spawnSync(process.execPath, ["--import", join(here, "fake-secrets.js"), cli, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      input: o.input,
      stdio: stdio as ["ignore", "pipe", "pipe", number?],
      env,
    });
  } finally {
    if (keyFd !== undefined) closeSync(keyFd);
  }
}

/** planner availability for `capture hello` in a throwaway HOME. */
function planner(home: string, extra: NodeJS.ProcessEnv, keyFile?: string): { available: boolean; out: string } {
  const r = run(["capture", "hello"], childEnv({ HOME: home, ...extra }), { keyFile });
  assert.equal(r.status, 0, r.stderr);
  return { available: JSON.parse(r.stdout).planner.available as boolean, out: r.stdout + r.stderr };
}

function isolatedHome(): { home: string; passphrase: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "takeone-keyring-"));
  const passphrase = join(home, "passphrase");
  writeFileSync(passphrase, "test-passphrase");
  return { home, passphrase, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("a keyring key answers while TAKEONE_NO_KEYRING is unset (control)", () => {
  const { home, cleanup } = isolatedHome();
  try {
    assert.equal(planner(home, { TAKEONE_TEST_KEYRING_KEY: POISON }).available, true, "the fake keyring did not answer");
  } finally {
    cleanup();
  }
});

test("TAKEONE_NO_KEYRING cuts the keyring off and the sealed file keeps working", () => {
  const { home, passphrase, cleanup } = isolatedHome();
  try {
    // A host keyring holding a key must not surface it into an isolated run.
    assert.equal(planner(home, { TAKEONE_TEST_KEYRING_KEY: POISON, TAKEONE_NO_KEYRING: "1" }).available, false,
      "the keyring key surfaced into an isolated run");
    // Sealing under isolation writes the sealed file, not the (here poisoned) keyring...
    const seeded = run(["key", "set"],
      childEnv({ HOME: home, TAKEONE_TEST_KEYRING_KEY: POISON, TAKEONE_NO_KEYRING: "1", TAKEONE_SECRETS_PASSPHRASE_FD: "3" }),
      { keyFile: passphrase, input: "sk-isolated-key\n" });
    assert.equal(seeded.status, 0, seeded.stderr);
    // ...so the next isolated run reads that key from the sealed file alone.
    const sealed = planner(home, { TAKEONE_TEST_KEYRING_KEY: POISON, TAKEONE_NO_KEYRING: "1", TAKEONE_SECRETS_PASSPHRASE_FD: "3" }, passphrase);
    assert.equal(sealed.available, true, "the sealed key was not readable without the keyring");
    assert.ok(!sealed.out.includes(POISON) && !seeded.stdout.includes("sk-isolated-key"),
      "a key surfaced into the output");
  } finally {
    cleanup();
  }
});

test("TAKEONE_NO_KEYRING=0, false or empty leaves the keyring enabled", () => {
  const { home, cleanup } = isolatedHome();
  try {
    for (const value of ["0", "false", ""]) {
      assert.equal(planner(home, { TAKEONE_TEST_KEYRING_KEY: POISON, TAKEONE_NO_KEYRING: value }).available, true,
        `TAKEONE_NO_KEYRING=${JSON.stringify(value)} disabled the keyring`);
    }
  } finally {
    cleanup();
  }
});
