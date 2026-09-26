import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listTakes, parsePidFile, parseTakeId, processStartTicks } from "../takes.js";

async function tempRoot(): Promise<string> {
  const dir = join(tmpdir(), `takeone-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

const TAKE_JSON = JSON.stringify({
  id: "20260101-000001",
  started_at: "2026-01-01T00:00:00.000Z",
  stopped_at: "2026-01-01T00:01:00.000Z",
  pointer: "mapped",
  clock: { offset_ms: 40, median_ms: 0, spread_ms: 2, frames: 1800 },
});

test("take ids match YYYYMMDD-HHMMSS", () => {
  assert.equal(parseTakeId("20260926-051122"), "20260926-051122");
  assert.equal(parseTakeId("20260926-051122-1"), "20260926-051122-1");
  assert.equal(parseTakeId("20260926-051122-0"), null);
  assert.equal(parseTakeId("not-a-take"), null);
  assert.equal(parseTakeId("2026092-051122"), null);
});

test("listing reports complete takes with take.json and skips foreign entries", async () => {
  const root = await tempRoot();
  try {
    await mkdir(join(root, "20260101-000001"));
    await writeFile(join(root, "20260101-000001", "take.json"), TAKE_JSON);
    await mkdir(join(root, "20260101-000001-1"));
    await writeFile(join(root, "20260101-000001-1", "take.json"), TAKE_JSON);
    await mkdir(join(root, "random-dir"));
    await writeFile(join(root, "notes.txt"), "hello");

    const takes = await listTakes(root, null);
    assert.equal(takes.length, 2);
    assert.ok(takes.some((entry) => entry.id === "20260101-000001-1" && entry.status === "complete"));
    const take = takes.find((entry) => entry.id === "20260101-000001")!;
    assert.equal(take.id, "20260101-000001");
    assert.equal(take.status, "complete");
    assert.equal(take.durationMs, 60_000);
    assert.equal(take.frames, 1800);
    assert.equal(take.pointer, "mapped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a take without take.json is incomplete; the live pid file marks recording", async () => {
  const root = await tempRoot();
  try {
    const recordingDir = join(root, "20260101-000002");
    await mkdir(recordingDir);
    await mkdir(join(root, "20260101-000003"));

    const recording = { pid: process.pid, take: recordingDir };
    const takes = await listTakes(root, recording);
    const byId = new Map(takes.map((t) => [t.id, t]));
    assert.equal(byId.get("20260101-000002")?.status, "recording");
    assert.equal(byId.get("20260101-000003")?.status, "incomplete");

    // Without the live marker both are incomplete.
    const none = await listTakes(root, null);
    assert.ok(none.every((t) => t.status === "incomplete"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("newest take sorts first", async () => {
  const root = await tempRoot();
  try {
    for (const id of ["20260101-000001", "20260102-000001", "20260103-000001"]) {
      await mkdir(join(root, id));
    }
    const takes = await listTakes(root, null);
    assert.deepEqual(
      takes.map((t) => t.id),
      ["20260103-000001", "20260102-000001", "20260101-000001"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parsePidFile validates content and liveness", () => {
  const start_ticks = processStartTicks(process.pid);
  assert.ok(start_ticks !== null);
  assert.deepEqual(parsePidFile(JSON.stringify({ pid: process.pid, start_ticks, take: "/tmp/x" })), {
    pid: process.pid,
    take: "/tmp/x",
  });
  assert.equal(parsePidFile(JSON.stringify({ pid: process.pid, start_ticks: "0", take: "/tmp/x" })), null);
  // dead pid
  assert.equal(parsePidFile(JSON.stringify({ pid: 2147470000, take: "/tmp/x" })), null);
  // malformed
  assert.equal(parsePidFile("garbage"), null);
  assert.equal(parsePidFile("null"), null);
  assert.equal(parsePidFile(JSON.stringify({ pid: process.pid, take: "/tmp/x" })), null);
  assert.equal(parsePidFile(JSON.stringify({ pid: -1, take: "/tmp/x" })), null);
  assert.equal(parsePidFile(JSON.stringify({ pid: process.pid })), null);
});
