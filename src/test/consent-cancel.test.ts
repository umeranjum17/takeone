/**
 * A consent prompt nobody answers must be cancelled, not left behind: on the
 * deadline the engine is shut down cleanly (its exit withdraws the portal
 * request) and a structured consent-timeout error is thrown. `takeone stop`
 * while waiting does the same.
 *
 * The fake engine hangs on session.open when FAKE_HANG_OPEN is set; EngineClient
 * spawns it with the caller's env, so the hook is set on the test process.
 * EngineClient.stop() awaits the engine's exit (SIGTERM fallback), so by the
 * time startCapture rejects, the engine process is already gone.
 */

import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { startCapture, RecordError } from "../session.js";

const here = dirname(fileURLToPath(import.meta.url));

const ENGINE = {
  command: process.execPath,
  args: [join(here, "fake-engine.js")],
  origin: "test",
} as const;

async function tempDirs(): Promise<{ takeDir: string; stateDir: string }> {
  const base = join(tmpdir(), `takeone-consent-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const takeDir = join(base, "take");
  const stateDir = join(base, "state");
  await mkdir(takeDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  return { takeDir, stateDir };
}

async function cleanup(base: string): Promise<void> {
  delete process.env.FAKE_HANG_OPEN;
  await rm(base, { recursive: true, force: true });
}

test("consent timeout shuts the engine down and throws a structured error", { timeout: 20_000 }, async () => {
  const { takeDir, stateDir } = await tempDirs();
  process.env.FAKE_HANG_OPEN = "1";
  try {
    await assert.rejects(
      startCapture({
        engine: ENGINE as unknown as Parameters<typeof startCapture>[0]["engine"],
        takeDir,
        stateDir,
        fps: 30,
        bitrateKbps: 40_000,
        savedToken: null,
        consentTimeoutMs: 500,
      }),
      (error: unknown) => {
        assert.ok(error instanceof RecordError);
        assert.equal(error.code, "consent-timeout");
        assert.match(error.hint, /picker/);
        return true;
      },
    );
  } finally {
    await cleanup(join(takeDir, ".."));
  }
});

test("a stop while waiting on consent cancels it as consent-cancelled", { timeout: 20_000 }, async () => {
  const { takeDir, stateDir } = await tempDirs();
  process.env.FAKE_HANG_OPEN = "1";
  let cancel!: () => void;
  const interrupted = new Promise<void>((resolveP) => {
    cancel = resolveP;
  });
  try {
    const capturePromise = startCapture({
      engine: ENGINE as unknown as Parameters<typeof startCapture>[0]["engine"],
      takeDir,
      stateDir,
      fps: 30,
      bitrateKbps: 40_000,
      savedToken: null,
      interrupted,
      consentTimeoutMs: 60_000,
    });
    cancel(); // the stop, while the open is still waiting on consent
    await assert.rejects(capturePromise, (error: unknown) => {
      assert.ok(error instanceof RecordError);
      assert.equal(error.code, "consent-cancelled");
      return true;
    });
  } finally {
    await cleanup(join(takeDir, ".."));
  }
});
