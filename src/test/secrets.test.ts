import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { overrideStore, type Keystore } from "@byokit/secrets";
import { JEV_SECRET, loadApiKey, keyStatus, setKeyFromStdin } from "../secrets.js";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(fn: (root: string, legacy: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "takeone-secrets-"));
  mkdirSync(join(root, ".config", "takeone"), { recursive: true });
  return fn(root, join(root, ".config", "takeone", "env")).finally(() => rmSync(root, { recursive: true, force: true }));
}
function options(root: string, store: Keystore) {
  return { env: { HOME: root, XDG_CONFIG_HOME: join(root, ".config") }, store };
}

test("host override wins without opening a store or migrating", () => fixture(async (root, legacy) => {
  writeFileSync(legacy, "TYPESAFE_API_KEY=legacy-key\n");
  const store: Keystore = {
    get: async () => { throw Error("must not read"); },
    set: async () => { throw Error("must not write"); },
    delete: async () => { throw Error("must not delete"); },
  };
  assert.equal(await loadApiKey({ ...options(root, store), env: { HOME: root, TYPESAFE_API_KEY: "host-key" } }), "host-key");
  assert.equal(readFileSync(legacy, "utf8"), "TYPESAFE_API_KEY=legacy-key\n");
}));

test("migration verifies the BYOKit store, removes key lines, and runs once", () => fixture(async (root, legacy) => {
  const store = overrideStore({});
  writeFileSync(legacy, "# settings\nOTHER=keep\nTYPESAFE_API_KEY=legacy-key\nlegacy-key\n");
  assert.equal(await loadApiKey(options(root, store)), "legacy-key");
  assert.equal(await store.get(JEV_SECRET), "legacy-key");
  assert.equal(readFileSync(legacy, "utf8"), "# settings\nOTHER=keep\n");
  assert.equal(await loadApiKey(options(root, store)), "legacy-key");
}));

test("key-only legacy file is deleted; existing different stored key wins", () => fixture(async (root, legacy) => {
  const store = overrideStore({});
  writeFileSync(legacy, "legacy-key\n");
  assert.equal(await loadApiKey(options(root, store)), "legacy-key");
  assert.equal(existsSync(legacy), false);
  writeFileSync(legacy, "TYPESAFE_API_KEY=stale-key\n");
  assert.equal(await loadApiKey(options(root, store)), "legacy-key");
  assert.equal(readFileSync(legacy, "utf8"), "TYPESAFE_API_KEY=stale-key\n");
}));

test("migration resumes verified cleanup without rewriting a matching stored key", () => fixture(async (root, legacy) => {
  const memory = overrideStore({ [JEV_SECRET]: "legacy-key" });
  const store: Keystore = {
    get: (name) => memory.get(name),
    set: async () => { throw Error("must not rewrite"); },
    delete: (name) => memory.delete(name),
  };
  writeFileSync(legacy, "# settings\nOTHER=keep\nTYPESAFE_API_KEY=legacy-key\nlegacy-key\n");
  assert.equal(await loadApiKey(options(root, store)), "legacy-key");
  assert.equal(readFileSync(legacy, "utf8"), "# settings\nOTHER=keep\n");
  writeFileSync(legacy, "legacy-key\n");
  assert.equal(await loadApiKey(options(root, store)), "legacy-key");
  assert.equal(existsSync(legacy), false);
}));

test("failed writes and failed verification preserve plaintext", () => fixture(async (root, legacy) => {
  for (const failure of ["write", "verify"]) {
    const source = "TYPESAFE_API_KEY=legacy-key\n";
    writeFileSync(legacy, source);
    const store: Keystore = {
      get: async () => null,
      set: async () => { if (failure === "write") throw Error("fake failure"); },
      delete: async () => false,
    };
    await assert.rejects(loadApiKey(options(root, store)));
    assert.equal(readFileSync(legacy, "utf8"), source);
  }
}));

test("stdin setter validates one line and presence probes never migrate", () => fixture(async (root, legacy) => {
  const store = overrideStore({});
  writeFileSync(legacy, "TYPESAFE_API_KEY=legacy-key\n");
  assert.equal((await keyStatus(options(root, store))).available, false);
  assert.equal(existsSync(legacy), true);
  await setKeyFromStdin((async function* () { yield Buffer.from("stdin-"); yield "key\n"; })(), options(root, store));
  assert.equal(await store.get(JEV_SECRET), "stdin-key");
  assert.equal((await keyStatus(options(root, store))).available, true);
  for (const invalid of ["", "\n", "one\ntwo", "x".repeat(16_385)]) {
    await assert.rejects(setKeyFromStdin((async function* () { yield invalid; })(), options(root, store)));
    assert.equal(await store.get(JEV_SECRET), "stdin-key");
  }
}));

test("CLI stores piped input in BYOKit's sealed fallback and never echoes secrets", () => fixture(async (root) => {
  const passPath = join(root, "pass-input");
  writeFileSync(passPath, "test-passphrase", { mode: 0o600 });
  const run = (args: string[], input: string, pass = passPath) => {
    const fd = openSync(pass, "r");
    try {
      return spawnSync(process.execPath, ["--import", join(here, "fake-secrets.js"), join(here, "../cli.js"), ...args], {
        input, encoding: "utf8", timeout: 10_000,
        env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, ".config"), TYPESAFE_API_KEY: "", TAKEONE_TEST_NO_KEYRING: "1", TAKEONE_SECRETS_PASSPHRASE_FD: "3" },
        stdio: ["pipe", "pipe", "pipe", fd],
      });
    } finally { closeSync(fd); }
  };
  const set = run(["key", "set"], "stdin-secret\n");
  assert.equal(set.status, 0, set.stderr);
  assert.ok(!(set.stdout + set.stderr).includes("stdin-secret"));
  const sealed = join(root, ".config", "takeone", "secrets.json");
  assert.ok(!readFileSync(sealed, "utf8").includes("stdin-secret"));
  assert.equal(statSync(sealed).mode & 0o777, 0o600);
  const hello = run(["capture", "hello"], "");
  assert.equal(hello.status, 0, hello.stderr);
  assert.equal(JSON.parse(hello.stdout).planner.available, true);
  assert.ok(!hello.stdout.includes("stdin-secret"));
  const before = readFileSync(sealed, "utf8");
  writeFileSync(passPath, "wrong-passphrase");
  const wrong = run(["key", "set"], "replacement-secret");
  assert.equal(wrong.status, 1);
  assert.ok(!(wrong.stdout + wrong.stderr).includes("replacement-secret"));
  assert.equal(readFileSync(sealed, "utf8"), before);
  const argv = run(["key", "set", "argv-secret"], "");
  assert.equal(argv.status, 2);
  assert.ok(!(argv.stdout + argv.stderr).includes("argv-secret"));
}));

test("migration finds the old HOME path when XDG config moved", () => fixture(async (root, legacy) => {
  const store = overrideStore({});
  writeFileSync(legacy, "TYPESAFE_API_KEY=home-key\n");
  const xdg = join(root, "xdg");
  mkdirSync(join(xdg, "takeone"), { recursive: true });
  const extra = join(xdg, "takeone", "env");
  writeFileSync(extra, "TYPESAFE_API_KEY=xdg-key\n");
  const o = { env: { HOME: root, XDG_CONFIG_HOME: xdg }, store };
  assert.equal(await loadApiKey(o), "home-key");
  assert.equal(existsSync(legacy), false);
  await store.delete(JEV_SECRET);
  assert.equal(await loadApiKey(o), null);
  assert.equal(readFileSync(extra, "utf8"), "TYPESAFE_API_KEY=xdg-key\n");
}));

test("migration preserves a legacy file changed during store write", () => fixture(async (root, legacy) => {
  writeFileSync(legacy, "TYPESAFE_API_KEY=old-key\n");
  const memory = overrideStore({});
  const store: Keystore = {
    get: (name) => memory.get(name),
    set: async (name, key) => {
      await memory.set(name, key);
      writeFileSync(legacy, "TYPESAFE_API_KEY=new-key\nOTHER=new\n");
    },
    delete: (name) => memory.delete(name),
  };
  await assert.rejects(loadApiKey(options(root, store)), /changed during migration/);
  assert.equal(readFileSync(legacy, "utf8"), "TYPESAFE_API_KEY=new-key\nOTHER=new\n");
  assert.equal(await loadApiKey(options(root, store)), "old-key");
  assert.equal(readFileSync(legacy, "utf8"), "TYPESAFE_API_KEY=new-key\nOTHER=new\n");
  writeFileSync(legacy, "TYPESAFE_API_KEY=old-key\nOTHER=new\n");
  assert.equal(await loadApiKey(options(root, store)), "old-key");
  assert.equal(readFileSync(legacy, "utf8"), "OTHER=new\n");
}));
