import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTaps } from "../taps.js";

test("macOS desktop takes carry no Hyprland warning", async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-taps-mac-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const hyprSignature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  Object.defineProperty(process, "platform", { value: "darwin" });
  delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
  try {
    const taps = await startTaps({
      eventsPath: join(base, "events.jsonl"),
      t0ns: process.hrtime.bigint(),
      deviceDir: join(base, "no-input"),
      mapping: null,
    });
    await taps.stop();
    assert.equal(taps.pointerMode, "none");
    assert.deepEqual(taps.warnings.filter((w) => /hyprland/i.test(w)), []);
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (hyprSignature !== undefined) process.env.HYPRLAND_INSTANCE_SIGNATURE = hyprSignature;
    await rm(base, { recursive: true, force: true });
  }
});

test("Linux takes with no readable input devices keep the evdev warning", async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-taps-linux-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    const taps = await startTaps({
      eventsPath: join(base, "events.jsonl"),
      t0ns: process.hrtime.bigint(),
      deviceDir: join(base, "no-input"),
      mapping: null,
    });
    await taps.stop();
    assert.ok(taps.warnings.includes("no evdev mouse/keyboard devices found; recording video only with events:'none'"));
  } finally {
    Object.defineProperty(process, "platform", platform);
    await rm(base, { recursive: true, force: true });
  }
});
