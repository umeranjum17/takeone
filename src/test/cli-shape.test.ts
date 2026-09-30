import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { formatDoctor, runDoctor, type DoctorCheck } from "../doctor.js";
import { overrideStore } from "@byokit/secrets";
import { toonTable } from "../toon.js";
import { computeTrim } from "../record.js";

test("doctor output is a TOON table with a stable shape", () => {
  const checks: DoctorCheck[] = [
    { check: "engine", ok: true, detail: "/path/to/desklink-host (prebuilt)" },
    { check: "engine-protocol", ok: false, detail: "protocol 2, wayland, vp9 sw" },
    { check: "hyprland", ok: true, detail: "1 monitor(s): HDMI-A-1 3840x2160@1.5" },
    { check: "evdev", ok: true, detail: "3 readable device(s)" },
    { check: "ffmpeg", ok: true, detail: "ffmpeg version n9.0.1" },
    { check: "state-dir", ok: true, detail: "/home/x/.local/state/takeone" },
    { check: "takes-root", ok: true, detail: "/home/x/Videos/takeone" },
  ];
  const out = formatDoctor(checks);
  const lines = out.split("\n");
  assert.equal(lines[0], "doctor[7]{check,ok,detail}:");
  assert.ok(lines[1]!.startsWith("  engine,true,"));
  assert.ok(lines[1]!.includes("desklink-host (prebuilt)"));
  assert.ok(lines[3]!.startsWith("  hyprland,true,"));
  // every check name appears exactly once, in order
  const names = checks.map((c) => c.check);
  let cursor = 1;
  for (const name of names) {
    const found = lines.findIndex((line, i) => i >= cursor && line.startsWith(`  ${name},`));
    assert.ok(found >= cursor, `${name} missing or out of order`);
    cursor = found + 1;
  }
});

test("doctor leaves an existing probe symlink and its target untouched", { timeout: 20_000 }, async () => {
  const base = await mkdtemp(join(process.cwd(), ".doctor-test-"));
  const state = join(base, "state");
  await mkdir(state);
  const target = join(state, "important");
  const probe = join(state, ".doctor-probe");
  await writeFile(target, "keep this");
  await symlink(target, probe);
  const previousState = process.env.TAKEONE_STATE_DIR;
  const previousRoot = process.env.TAKEONE_DIR;
  const previousHypr = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  process.env.TAKEONE_STATE_DIR = state;
  process.env.TAKEONE_DIR = join(base, "takes");
  delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
  try {
    const checks = await runDoctor({ env: {}, store: overrideStore({}) });
    assert.equal(checks.find((check) => check.check === "state-dir")?.ok, true);
    assert.equal(await readFile(target, "utf8"), "keep this");
    assert.equal(await readlink(probe), target);
    assert.deepEqual((await readdir(state)).sort(), [".doctor-probe", "important"]);
  } finally {
    if (previousState === undefined) delete process.env.TAKEONE_STATE_DIR;
    else process.env.TAKEONE_STATE_DIR = previousState;
    if (previousRoot === undefined) delete process.env.TAKEONE_DIR;
    else process.env.TAKEONE_DIR = previousRoot;
    if (previousHypr === undefined) delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
    else process.env.HYPRLAND_INSTANCE_SIGNATURE = previousHypr;
    await rm(base, { recursive: true, force: true });
  }
});

test("a detail containing a comma is quoted, not split", () => {
  const out = formatDoctor([{ check: "evdev", ok: false, detail: "missing group, add user" }]);
  assert.ok(out.includes('"missing group, add user"'));
});

test("toonTable renders empty tables as a bare header", () => {
  assert.equal(toonTable("takes", ["id"], []), "takes[0]{id}:");
});

test("computeTrim keeps the final action and trims only before the first input", () => {
  const duration = 30_000;
  const trim = computeTrim({ inputMs: [2000] }, duration);
  assert.equal(trim.start, 1500);
  assert.equal(trim.end, duration);
});

test("computeTrim: an early first input keeps the whole start", () => {
  const trim = computeTrim({ inputMs: [400] }, 10_000);
  assert.equal(trim.start, 0);
  assert.equal(trim.end, 10_000);
});

test("computeTrim leaves the end intact", () => {
  const duration = 30_000;
  const trim = computeTrim({ inputMs: [3000] }, duration);
  assert.equal(trim.start, 2500);
  assert.equal(trim.end, duration);
});

test("computeTrim: no input at all leaves the take untrimmed", () => {
  const trim = computeTrim({ inputMs: [] }, 8_000);
  assert.deepEqual(trim, { start: 0, end: 8000 });
});

test("computeTrim anchors on the first input more than 1 s after the first frame", () => {
  // Share click in the consent dialog at 3 s, first frame at 4 s, then the
  // terminal is left at 4.6 s (too early) and the demo starts at 9 s.
  const trim = computeTrim({ inputMs: [3000, 4600, 9000, 9100] }, 60_000, 4000);
  assert.deepEqual(trim, { start: 8500, end: 60_000 });
});
