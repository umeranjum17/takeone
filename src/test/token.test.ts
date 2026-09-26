import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { consumeToken, saveToken, tokenPath } from "../token.js";

async function tempStateDir(): Promise<string> {
  const dir = join(tmpdir(), `takeone-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

test("saveToken writes atomically with mode 0600; consume reads and deletes", async () => {
  const dir = await tempStateDir();
  try {
    await saveToken(dir, "token-abc123");
    const path = tokenPath(dir);
    assert.equal(await readFile(path, "utf8"), "token-abc123");
    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    // atomic write leaves no temp files behind
    const files = (await import("node:fs/promises")).readdir;
    assert.deepEqual(await files(dir), ["portal-token"]);
    assert.equal(await consumeToken(dir), "token-abc123");
    // single use: second consume finds nothing
    assert.equal(await consumeToken(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a replacement token overwrites the saved one", async () => {
  const dir = await tempStateDir();
  try {
    await saveToken(dir, "first");
    await saveToken(dir, "second");
    assert.equal(await consumeToken(dir), "second");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("consume with no saved token returns null", async () => {
  const dir = await tempStateDir();
  try {
    assert.equal(await consumeToken(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("state dir is created private (0700) when missing", async () => {
  const parent = join(tmpdir(), `takeone-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const dir = join(parent, "state");
  try {
    await saveToken(dir, "deep");
    const mode = (await stat(dir)).mode & 0o777;
    assert.equal(mode, 0o700, `expected 0700, got ${mode.toString(8)}`);
    assert.equal(await consumeToken(dir), "deep");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("an unreadable token file behaves like none (null)", async () => {
  const dir = await tempStateDir();
  try {
    await saveToken(dir, "secret");
    await chmod(tokenPath(dir), 0o000);
    assert.equal(await consumeToken(dir), null);
    await chmod(tokenPath(dir), 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
