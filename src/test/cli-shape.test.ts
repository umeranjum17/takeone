import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDoctor, type DoctorCheck } from "../doctor.js";
import { structuredError, toonTable } from "../toon.js";
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

test("a detail containing a comma is quoted, not split", () => {
  const out = formatDoctor([{ check: "evdev", ok: false, detail: "missing group, add user" }]);
  assert.ok(out.includes('"missing group, add user"'));
});

test("structured errors are JSON with code, message and hint", () => {
  const line = structuredError("consent-cancelled", "the dialog was cancelled", "run again");
  const parsed = JSON.parse(line) as { error: { code: string; message: string; hint: string } };
  assert.deepEqual(parsed, {
    error: { code: "consent-cancelled", message: "the dialog was cancelled", hint: "run again" },
  });
});

test("toonTable renders empty tables as a bare header", () => {
  assert.equal(toonTable("takes", ["id"], []), "takes[0]{id}:");
});

test("computeTrim keeps the final action and trims only before the first input", () => {
  const duration = 30_000;
  const trim = computeTrim({ firstInputMs: 2000 }, duration);
  assert.equal(trim.start, 1500);
  assert.equal(trim.end, duration);
});

test("computeTrim: an early first input keeps the whole start", () => {
  const trim = computeTrim({ firstInputMs: 400 }, 10_000);
  assert.equal(trim.start, 0);
  assert.equal(trim.end, 10_000);
});

test("computeTrim leaves the end intact", () => {
  const duration = 30_000;
  const trim = computeTrim({ firstInputMs: 3000 }, duration);
  assert.equal(trim.start, 2500);
  assert.equal(trim.end, duration);
});

test("computeTrim: no input at all leaves the take untrimmed", () => {
  const trim = computeTrim({ firstInputMs: null }, 8_000);
  assert.deepEqual(trim, { start: 0, end: 8000 });
});
