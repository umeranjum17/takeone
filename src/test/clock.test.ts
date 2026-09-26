import assert from "node:assert/strict";
import { test } from "node:test";
import { alignClock, SPREAD_WARN_MS, type FrameSample } from "../clock.js";

/** Frames captured 100 ms apart with a fixed encode delay plus jitter. */
function samples(delays: number[], captureStepMs = 100): FrameSample[] {
  return delays.map((delay, i) => ({
    rtpTs: Math.round((i * captureStepMs * 90) / 1),
    recvMs: i * captureStepMs + delay,
  }));
}

test("offset is the minimum of recv - rtp/90", () => {
  // delays: one frame at 40 ms, one at 55, one at 60 -> offset 40
  const rows = samples([40, 55, 60]);
  const aligned = alignClock(rows);
  assert.ok(aligned !== null);
  assert.equal(aligned.offsetMs, 40);
  assert.equal(aligned.frames, 3);
});

test("residuals concentrate on the median and spread tracks the worst tail", () => {
  const rows = samples([40, 40, 40, 40, 40, 40, 40, 40, 40, 90]); // one late frame
  const aligned = alignClock(rows);
  assert.ok(aligned !== null);
  assert.equal(aligned.medianMs, 0);
  // the one 50 ms-late frame is exactly the spread
  assert.equal(aligned.spreadMs, 50);
});

test("spread above 50 ms exceeds the warn threshold", () => {
  const delays = [40, 40, 40, 40, 40, 40, 40, 40, 40, 200];
  const rows = samples(delays);
  const aligned = alignClock(rows);
  assert.ok(aligned !== null);
  assert.ok(aligned.spreadMs > SPREAD_WARN_MS);
});

test("with a constant pipeline delay, capture time on the event clock equals receive time", () => {
  const rows: FrameSample[] = [
    { rtpTs: 90_000, recvMs: 1040 }, // captured at 1000 ms, arrived 40 ms late
    { rtpTs: 99_000, recvMs: 1140 }, // captured at 1100 ms, arrived 40 ms late
  ];
  const aligned = alignClock(rows);
  assert.ok(aligned !== null);
  if (aligned === null) return; // narrowed for the loop below
  for (const row of rows) {
    const captureMs: number = row.rtpTs / 90 + aligned.offsetMs;
    assert.equal(captureMs, row.recvMs);
  }
});

test("no frames means no alignment", () => {
  assert.equal(alignClock([]), null);
});
