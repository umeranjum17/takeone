/**
 * P8 unit tests, all runnable on Linux: pure helpers, take.json writing
 * from a fixture mp4, and the not-macOS / flag-shape refusals through the
 * built CLI. The live simctl path is acceptance-tested on the Mac.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  isMacOS,
  moveRawIntoTake,
  offsetMsFromStartLine,
  parseBootedDevices,
  selectSimulator,
  probeVideoSize,
  refuseUnlessMac,
  writeIosTake,
  IosRecordError,
} from "../ios/record.js";

const here = dirname(fileURLToPath(import.meta.url));

test("macOS gate refuses with the capture-style error anywhere else", () => {
  assert.equal(isMacOS("darwin"), true);
  assert.equal(isMacOS("linux"), false);
  assert.doesNotThrow(() => refuseUnlessMac("darwin"));
  try {
    refuseUnlessMac("linux");
    assert.fail("should have thrown");
  } catch (error) {
    assert.ok(error instanceof IosRecordError);
    assert.equal(error.code, "unsupported-platform");
    assert.match(error.message, /macOS/);
    assert.match(error.hint, /Xcode/);
  }
});

test("booted devices parse from simctl JSON, empty when none is booted", () => {
  const json = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [
        { udid: "AAA", state: "Shutdown", name: "iPhone 16" },
        { udid: "BBB", state: "Booted", name: "iPhone 16 Pro" },
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [{ udid: "CCC", state: "Shutdown" }],
    },
  });
  assert.deepEqual(parseBootedDevices(json), ["BBB"]);
  assert.deepEqual(parseBootedDevices(JSON.stringify({ devices: {} })), []);
  assert.deepEqual(parseBootedDevices("not json"), []);
});

test("non-array device groups are skipped instead of throwing", () => {
  const json = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-6": { udid: "AAA", state: "Booted" },
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3": "odd-string-group",
      "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
        { udid: "BBB", state: "Booted" },
        null,
        "junk",
        { udid: "CCC", state: "Shutdown" },
      ],
    },
  });
  assert.deepEqual(parseBootedDevices(json), ["BBB"]);
  assert.deepEqual(parseBootedDevices(JSON.stringify({ devices: { bogus: 42 } })), []);
});

test("moveRawIntoTake falls back to copy+unlink on EXDEV", async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-ios-move-"));
  try {
    const exdev: NodeJS.ErrnoException = Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    const raw = join(base, "raw.mov");
    const dest = join(base, "take", "screen.webm");
    await mkdir(join(base, "take"));
    await writeFile(raw, "video-bytes");
    await moveRawIntoTake(raw, dest, () => Promise.reject(exdev));
    assert.equal(await readFile(dest, "utf8"), "video-bytes");
    await assert.rejects(stat(raw));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("moveRawIntoTake removes the temp file and reports the real error", async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-ios-move-"));
  try {
    // Missing source: simctl wrote nothing.
    const missing = join(base, "never-wrote.mov");
    await assert.rejects(moveRawIntoTake(missing, join(base, "screen.webm")), /simctl wrote no video file/);
    await assert.rejects(stat(missing));

    // Any other rename failure surfaces its own message, not the no-file one.
    const raw = join(base, "raw.mov");
    await writeFile(raw, "video-bytes");
    const boom: NodeJS.ErrnoException = Object.assign(new Error("disk on fire"), { code: "EIO" });
    await assert.rejects(
      moveRawIntoTake(raw, join(base, "screen.webm"), () => Promise.reject(boom)),
      /disk on fire/,
    );
    await assert.rejects(stat(raw));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("offset_ms measures spawn to the recorder start line, else zero", () => {
  assert.equal(offsetMsFromStartLine(1000, 1012.34), 12.3);
  assert.equal(offsetMsFromStartLine(1000, null), 0);
});

test("take.json is written from a fixture mp4 with no events file", { timeout: 60_000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-ios-"));
  try {
    const fixture = join(base, "fixture.mp4");
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=s=1080x1920:d=2:r=30",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      fixture,
    ]);
    assert.deepEqual(probeVideoSize(fixture), { w: 1080, h: 1920 });

    const takeDir = join(base, "take");
    await mkdir(takeDir);
    const { takeJson, frames } = await writeIosTake(takeDir, fixture, 12.3);
    assert.deepEqual(takeJson.stream, { w: 1080, h: 1920 });
    assert.equal(takeJson.offset_ms, 12.3);
    assert.equal(takeJson.pointer, "none");
    assert.equal(takeJson.events, "none");
    assert.ok(frames > 0);
    const onDisk = JSON.parse(await readFile(join(takeDir, "take.json"), "utf8"));
    assert.deepEqual(onDisk, takeJson);
    assert.equal(await readFile(join(takeDir, "frames.tsv"), "utf8"), "0\t0\n");
    await assert.rejects(stat(join(takeDir, "events.jsonl")));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("record --ios-sim refuses on Linux and rejects conflicting flags", () => {
  const base = mkdtempSync(join(tmpdir(), "takeone-ios-flags-"));
  function run(args: string[]): { status: number | null; stderr: string } {
    const result = spawnSync(process.execPath, [join(here, "../cli.js"), ...args], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, TAKEONE_DIR: join(base, "takes"), TAKEONE_STATE_DIR: join(base, "state") },
    });
    return { status: result.status, stderr: result.stderr };
  }
  try {
    const refused = run(["record", "--ios-sim"]);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /unsupported-platform/);

    for (const args of [
      ["record", "--ios-sim", "--android", "emulator-5554"],
      ["record", "--ios-sim", "--fps", "30"],
      ["record", "--ios-sim", "--touch-offset-ms", "5"],
      ["record", "--ios-sim", "--ios-sim"],
      ["record", "--ios-udid", "4B99DA96-A371-4E6A-B80D-54997B1AFB48"],
      ["record", "--ios-sim", "--ios-udid"],
    ]) {
      const result = run(args);
      assert.equal(result.status, 1, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, /invalid-arguments/);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});


test("explicit Simulator selection is isolated from other booted devices", () => {
  const own = "4B99DA96-A371-4E6A-B80D-54997B1AFB48";
  const other = "22A5721E-B243-45E8-A9BC-681C439A966D";
  const json = JSON.stringify({ devices: { runtime: [
    { udid: other, state: "Booted" }, { udid: own, state: "Booted" },
  ] } });
  assert.equal(selectSimulator(json, own.toLowerCase()), own);
  assert.equal(selectSimulator(json), "booted");
  for (const invalid of ["booted", "--help", "", "not-a-uuid"]) {
    assert.throws(() => selectSimulator(json, invalid), (e: unknown) => e instanceof IosRecordError && e.code === "invalid-simulator");
  }
  for (const devices of [[], [{ udid: own, state: "Shutdown" }], [{ udid: other, state: "Booted" }]]) {
    assert.throws(() => selectSimulator(JSON.stringify({ devices: { runtime: devices } }), own),
      (e: unknown) => e instanceof IosRecordError && e.code === "no-simulator");
  }
});
