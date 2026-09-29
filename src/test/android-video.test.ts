import assert from "node:assert/strict";
import { test } from "node:test";
import { ScrcpyVideoParser, toAccessUnit } from "../android/video.js";

function preamble(): Buffer {
  const out = Buffer.alloc(1 + 64 + 4);
  out.writeUInt32BE(0x68323634, 1 + 64);
  return out;
}

function media(pts: bigint, payload: Buffer, flags = 0n): Buffer {
  const header = Buffer.alloc(12);
  header.writeBigUInt64BE((pts & ((1n << 61n) - 1n)) | flags, 0);
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

test("the v4.0 parser keeps per-frame PTS instead of discarding it", () => {
  const parser = new ScrcpyVideoParser();
  const pts = 123456789n;
  const payload = Buffer.from([0x65, 0x01, 0x02]);
  const events = parser.push(Buffer.concat([preamble(), media(pts, payload)]));
  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.type, "media");
  if (event.type !== "media") throw new Error("unreachable");
  assert.equal(event.pts, pts);
  assert.equal(event.keyframe, false);
  assert.equal(event.config, false);
});

test("config/keyframe flags survive alongside PTS, payloads gain a start code", () => {
  const parser = new ScrcpyVideoParser();
  const config = Buffer.from([0x67, 0x64]);
  const idr = Buffer.from([0x65, 0x88]);
  const events = parser.push(
    Buffer.concat([
      preamble(),
      media(1000n, config, (1n << 62n) | (1n << 61n)),
      media(2000n, idr, 1n << 61n),
    ]),
  );
  assert.equal(events.length, 2);
  const first = events[0]!;
  const second = events[1]!;
  assert.equal(first.type, "media");
  assert.equal(second.type, "media");
  if (first.type !== "media" || second.type !== "media") throw new Error("unreachable");
  assert.equal(first.config, true);
  assert.equal(first.pts, 1000n);
  assert.equal(second.keyframe, true);
  assert.equal(second.config, false);
  assert.equal(second.pts, 2000n);
  assert.deepEqual(toAccessUnit(idr).subarray(0, 4), Buffer.from([0, 0, 0, 1]));
});

test("payloads that already carry a start code pass through untouched", () => {
  const framed = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([0x67, 0x64])]);
  assert.equal(toAccessUnit(framed), framed);
  const shortCode = Buffer.concat([Buffer.from([0, 0, 1]), Buffer.from([0x65, 0x88])]);
  assert.equal(toAccessUnit(shortCode), shortCode);
});

test("a split header waits for the rest of the bytes", () => {
  const parser = new ScrcpyVideoParser();
  const payload = Buffer.from([0x41, 0x09]);
  const full = Buffer.concat([preamble(), media(777n, payload)]);
  assert.deepEqual(parser.push(full.subarray(0, 70)), []);
  const events = parser.push(full.subarray(70));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "media");
});
