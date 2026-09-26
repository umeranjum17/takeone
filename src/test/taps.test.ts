import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTaps } from "../taps.js";
import { EV_REL, REL_WHEEL, REL_HWHEEL, REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES } from "../evdev.js";

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
  try {
    const eventsPath = join(base, "events.jsonl");
    const taps = await startTaps({ eventsPath, mapping: null, t0ns: process.hrtime.bigint(), deviceDir, evdevPollHz: 200 });
    await new Promise((resolve) => setTimeout(resolve, 50));
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
  let requests = 0;
  const server = createServer((conn) => {
    conn.on("data", (data) => {
      requests++;
      conn.end(data.toString().includes("cursorpos") ? '{"x":10,"y":10}' : JSON.stringify({
        class: "Private", title: "Secret", address: "0x1", at: [0, 0], size: [100, 100],
      }));
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
    await videoOnly.stop();
    assert.equal(videoOnly.eventsMode, "none");
    assert.equal(videoOnly.pointerMode, "none");
    assert.equal(requests, 0);
    assert.equal(await readFile(eventsPath, "utf8"), "");

    const unmapped = await startTaps({ eventsPath, mapping: null, t0ns: process.hrtime.bigint(), deviceDir: readableDevices });
    assert.equal(unmapped.pointerMode, "none");
    await unmapped.stop();
  } finally {
    if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = oldRuntime;
    if (oldSig === undefined) delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
    else process.env.HYPRLAND_INSTANCE_SIGNATURE = oldSig;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(base, { recursive: true, force: true });
  }
});
