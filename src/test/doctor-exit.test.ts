/**
 * `takeone doctor` exit code, end to end: only a check every capture route needs
 * (ffmpeg, the state dir, the takes root) may fail the exit. Optional rows (the
 * planner key, motion shell, Hyprland, evdev, xcrun, engine) print false and exit 0.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));

async function runDoctor(binDir: string, base: string) {
  return spawnSync(process.execPath, [join(here, "../cli.js"), "doctor"], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: binDir,
      HOME: base,
      XDG_CONFIG_HOME: join(base, "config"),
      XDG_CACHE_HOME: join(base, "cache"),
      XDG_STATE_HOME: join(base, "xdg-state"),
      TAKEONE_DIR: join(base, "takes"),
      TAKEONE_STATE_DIR: join(base, "state"),
    },
  });
}

test("doctor exits 0 when only optional rows are false", async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-doctor-optional-"));
  try {
    const binDir = join(base, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "ffmpeg"), "#!/bin/sh\necho 'ffmpeg version stub'\n");
    await chmod(join(binDir, "ffmpeg"), 0o755);

    const result = await runDoctor(binDir, base);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /^  ffmpeg,true,all,/m);
    assert.match(result.stdout, /^  state-dir,true,all,/m);
    assert.match(result.stdout, /^  takes-root,true,all,/m);
    assert.match(result.stdout, /^  ai-planner,false,planner,/m);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("doctor exits 1 when a check every route needs (ffmpeg) is false", async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-doctor-required-"));
  try {
    const binDir = join(base, "bin");
    await mkdir(binDir, { recursive: true });

    const result = await runDoctor(binDir, base);
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /^  ffmpeg,false,all,/m);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
