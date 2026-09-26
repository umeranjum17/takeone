import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTaps } from "../taps.js";
import { evdevProbe } from "../doctor.js";
import { EV_KEY, EV_REL, REL_WHEEL, REL_HWHEEL, REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES } from "../evdev.js";

test("pre-consent input stays in memory until approval and is discarded on cancellation", async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-consent-taps-"));
  const deviceDir = join(base, "devices");
  await mkdir(deviceDir);
  const key = Buffer.alloc(24);
  key.writeUInt16LE(EV_KEY, 16);
  key.writeUInt16LE(31, 18);
  key.writeInt32LE(1, 20);
  await writeFile(join(deviceDir, "fake-event-kbd"), key);
  await writeFile(join(deviceDir, "fake-event-mouse"), "");
  const eventsPath = join(base, "events.jsonl");
  try {
    const options = { eventsPath, t0ns: process.hrtime.bigint(), deviceDir, evdevPollHz: 200 };
    const cancelled = await startTaps(options);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.notEqual(cancelled.summary.firstInputMs, null);
    await assert.rejects(stat(eventsPath));
    await cancelled.stop();
    await assert.rejects(stat(eventsPath));

    const approved = await startTaps(options);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await assert.rejects(stat(eventsPath));
    await approved.confirmConsent();
    await approved.stop();
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events[0].k, "key");
    assert.ok(events[0].t >= 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("input is captured before stream geometry is available", async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-early-input-"));
  const deviceDir = join(base, "devices");
  await mkdir(deviceDir);
  const key = Buffer.alloc(24);
  key.writeUInt16LE(EV_KEY, 16);
  key.writeUInt16LE(30, 18);
  key.writeInt32LE(1, 20);
  await writeFile(join(deviceDir, "early-event-kbd"), key);
  await writeFile(join(deviceDir, "early-event-mouse"), "");
  try {
    const eventsPath = join(base, "events.jsonl");
    const taps = await startTaps({ eventsPath, t0ns: process.hrtime.bigint(), deviceDir, evdevPollHz: 200 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(taps.pointerMode, "none");
    taps.setMapping(null);
    await taps.confirmConsent();
    await taps.stop();
    const early = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(early.length, 1);
    assert.equal(early[0].k, "key");
    assert.ok(early[0].t >= 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("one unreadable evdev device disables all event taps and doctor readiness", async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-partial-input-"));
  const deviceDir = join(base, "devices");
  await mkdir(deviceDir);
  await writeFile(join(deviceDir, "one-event-mouse"), "");
  await writeFile(join(deviceDir, "two-event-kbd"), "");
  await chmod(join(deviceDir, "two-event-kbd"), 0);
  try {
    const eventsPath = join(base, "events.jsonl");
    const taps = await startTaps({ eventsPath, mapping: null, t0ns: process.hrtime.bigint(), deviceDir });
    assert.equal(taps.eventsMode, "none");
    assert.ok(taps.warnings.some((warning) => warning.includes("group 'input'")));
    await taps.confirmConsent();
    await taps.stop();
    assert.equal(await readFile(eventsPath, "utf8"), "");
    assert.equal((await evdevProbe(deviceDir)).ok, false);
  } finally {
    await chmod(join(deviceDir, "two-event-kbd"), 0o600);
    await rm(base, { recursive: true, force: true });
  }
});

test("an unreadable evdev directory reports the missing input group", { skip: process.getuid?.() === 0 }, async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-device-dir-"));
  const deviceDir = join(base, "devices");
  await mkdir(deviceDir);
  await chmod(deviceDir, 0);
  try {
    const taps = await startTaps({ eventsPath: join(base, "events.jsonl"), mapping: null, t0ns: process.hrtime.bigint(), deviceDir });
    assert.equal(taps.eventsMode, "none");
    assert.ok(taps.warnings.some((warning) => warning.includes("group 'input'")));
    await taps.stop();
    const check = await evdevProbe(deviceDir);
    assert.equal(check.ok, false);
    assert.match(check.detail, /group 'input'/);
  } finally {
    await chmod(deviceDir, 0o700);
    await rm(base, { recursive: true, force: true });
  }
});

test("a missing mouse or keyboard class disables events and doctor readiness", async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-missing-class-"));
  const deviceDir = join(base, "devices");
  await mkdir(deviceDir);
  try {
    for (const kind of ["mouse", "kbd"]) {
      const path = join(deviceDir, `only-event-${kind}`);
      await writeFile(path, "");
      const taps = await startTaps({ eventsPath: join(base, "events.jsonl"), mapping: null, t0ns: process.hrtime.bigint(), deviceDir });
      assert.equal(taps.eventsMode, "none");
      await taps.stop();
      assert.equal((await evdevProbe(deviceDir)).ok, false);
      await rm(path);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("shortcuts retain modifiers across keyboards and both physical Ctrl keys", async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-modifiers-"));
  const deviceDir = join(base, "devices");
  await mkdir(deviceDir);
  const key = (code: number, value: number): Buffer => {
    const record = Buffer.alloc(24);
    record.writeUInt16LE(EV_KEY, 16);
    record.writeUInt16LE(code, 18);
    record.writeInt32LE(value, 20);
    return record;
  };
  await writeFile(join(deviceDir, "a-event-kbd"), Buffer.concat([key(29, 1), key(97, 1), key(29, 0), key(31, 1)]));
  await writeFile(join(deviceDir, "b-event-kbd"), key(31, 1));
  await writeFile(join(deviceDir, "c-event-mouse"), "");
  try {
    const eventsPath = join(base, "events.jsonl");
    const taps = await startTaps({ eventsPath, t0ns: process.hrtime.bigint(), deviceDir, evdevPollHz: 200 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await taps.confirmConsent();
    await taps.stop();
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.filter((event) => event.combo).map((event) => event.combo), ["Ctrl+S", "Ctrl+S"]);
    assert.ok(events.every((event) => !Object.hasOwn(event, "code")));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("an evdev device lost mid-recording fails completion", async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-device-loss-"));
  const deviceDir = join(base, "devices");
  await mkdir(deviceDir);
  await symlink("/dev/null", join(deviceDir, "gone-event-kbd"));
  await writeFile(join(deviceDir, "good-event-mouse"), "");
  try {
    const taps = await startTaps({ eventsPath: join(base, "events.jsonl"), mapping: null, t0ns: process.hrtime.bigint(), deviceDir, evdevPollHz: 200 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await assert.rejects(taps.stop(), /evdev device closed/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("wheel reports prefer high-resolution values on both axes from the first report", async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-wheel-"));
  const deviceDir = join(base, "devices");
  await mkdir(deviceDir);
  const record = (type: number, code: number, value: number): Buffer => {
    const buf = Buffer.alloc(24);
    buf.writeUInt16LE(type, 16);
    buf.writeUInt16LE(code, 18);
    buf.writeInt32LE(value, 20);
    return buf;
  };
  const syn = record(0, 0, 0);
  await writeFile(join(deviceDir, "fake-event-mouse"), Buffer.concat([
    record(EV_REL, REL_WHEEL, 1), record(EV_REL, REL_WHEEL_HI_RES, 120),
    record(EV_REL, REL_HWHEEL, -1), record(EV_REL, REL_HWHEEL_HI_RES, -120), syn,
    record(EV_REL, REL_WHEEL, -1), record(EV_REL, REL_HWHEEL, 1), syn,
  ]));
  await writeFile(join(deviceDir, "other-event-mouse"), Buffer.concat([
    record(EV_REL, REL_WHEEL, -1), record(EV_REL, REL_HWHEEL, 1), syn,
  ]));
  await writeFile(join(deviceDir, "fake-event-kbd"), "");
  try {
    const eventsPath = join(base, "events.jsonl");
    const taps = await startTaps({ eventsPath, mapping: null, t0ns: process.hrtime.bigint(), deviceDir, evdevPollHz: 200 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await taps.confirmConsent();
    await taps.stop();
    const wheels = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
      .filter((event) => event.k === "wheel").map(({ dx, dy }) => [dx, dy]);
    assert.deepEqual(wheels, [[0, 1], [-1, 0], [0, -1], [1, 0]]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("video-only tap never reads or writes Hyprland events; unmapped pointer is none", async () => {
  const base = await mkdtemp(join(tmpdir(), "takeone-taps-"));
  const socketDir = join(base, "hypr", "test");
  const emptyDevices = join(base, "empty");
  const readableDevices = join(base, "readable");
  await mkdir(socketDir, { recursive: true });
  await mkdir(emptyDevices);
  await mkdir(readableDevices);
  await writeFile(join(readableDevices, "fake-event-mouse"), "");
  await writeFile(join(readableDevices, "fake-event-kbd"), "");
  let requests = 0;
  let delayReply = false;
  let emptyCursor = false;
  let invalidWindow = false;
  let serverClosed = false;
  const server = createServer((conn) => {
    conn.on("data", (data) => {
      requests++;
      const cursor = data.toString().includes("cursorpos");
      const reply = cursor ? (emptyCursor ? "" : '{"x":10,"y":10}') : invalidWindow ? "not-json" : JSON.stringify({
        class: "Private", title: "Secret", address: "0x1", at: [0, 0], size: [100, 100],
      });
      if (delayReply) setTimeout(() => conn.end(reply), 160);
      else conn.end(reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(join(socketDir, ".socket.sock"), resolve));
  const oldRuntime = process.env.XDG_RUNTIME_DIR;
  const oldSig = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  process.env.XDG_RUNTIME_DIR = base;
  process.env.HYPRLAND_INSTANCE_SIGNATURE = "test";
  try {
    const eventsPath = join(base, "events.jsonl");
    const mapping = { monitor: { name: "test", x: 0, y: 0, width: 100, height: 100, scale: 1 }, scale: 1 };
    const videoOnly = await startTaps({ eventsPath, mapping, t0ns: process.hrtime.bigint(), deviceDir: emptyDevices });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await videoOnly.confirmConsent();
    await videoOnly.stop();
    assert.equal(videoOnly.eventsMode, "none");
    assert.equal(videoOnly.pointerMode, "none");
    assert.equal(requests, 0);
    assert.equal(await readFile(eventsPath, "utf8"), "");

    const unmapped = await startTaps({ eventsPath, mapping: null, t0ns: process.hrtime.bigint(), deviceDir: readableDevices });
    assert.equal(unmapped.pointerMode, "none");
    await unmapped.stop();

    delayReply = true;
    const beforeMapped = requests;
    const mapped = await startTaps({ eventsPath, mapping, t0ns: process.hrtime.bigint(), deviceDir: readableDevices, pollHz: 200 });
    const deadline = Date.now() + 1000;
    while (requests === beforeMapped && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(requests > beforeMapped);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(requests, beforeMapped + 1, "pointer polls must not overlap while IPC is pending");
    await mapped.confirmConsent();
    await mapped.stop();
    assert.equal(await readFile(eventsPath, "utf8"), "");

    delayReply = false;
    emptyCursor = true;
    const cleanClose = await startTaps({ eventsPath, mapping, t0ns: process.hrtime.bigint(), deviceDir: readableDevices });
    const cleanDeadline = Date.now() + 1000;
    while (cleanClose.pointerMode === "mapped" && Date.now() < cleanDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cleanClose.pointerMode, "none");
    await cleanClose.stop();

    emptyCursor = false;
    invalidWindow = true;
    const malformed = await startTaps({ eventsPath, mapping, t0ns: process.hrtime.bigint(), deviceDir: readableDevices });
    const malformedDeadline = Date.now() + 1000;
    while (malformed.pointerMode === "mapped" && Date.now() < malformedDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(malformed.pointerMode, "none");
    await malformed.stop();

    invalidWindow = false;
    const runtimeLoss = await startTaps({ eventsPath, mapping, t0ns: process.hrtime.bigint(), deviceDir: readableDevices });
    await runtimeLoss.confirmConsent();
    const before = requests;
    const activeDeadline = Date.now() + 1000;
    while (requests === before && Date.now() < activeDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(requests > before);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    serverClosed = true;
    const lossDeadline = Date.now() + 1000;
    while (runtimeLoss.pointerMode === "mapped" && Date.now() < lossDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(runtimeLoss.pointerMode, "none");
    assert.ok(runtimeLoss.warnings.some((warning) => warning.includes("ipc unavailable")));
    await runtimeLoss.stop();
    const recorded = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(recorded.some((event) => event.k === "ptr"));
    assert.ok(recorded.some((event) => event.k === "ptr-lost"));
    assert.equal(recorded.at(-1).rect, null);
  } finally {
    if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = oldRuntime;
    if (oldSig === undefined) delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
    else process.env.HYPRLAND_INSTANCE_SIGNATURE = oldSig;
    if (!serverClosed) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(base, { recursive: true, force: true });
  }
});
