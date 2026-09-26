import test from "node:test";
import assert from "node:assert/strict";
import { diffRegions, perceiveRegions, CUT_FRAC } from "../src/perceive/regions.ts";
import { drawBox, greyFrame, STREAM } from "./helpers.ts";

const W = 40;
const H = 30;

test("diffRegions finds a changed box and maps its bbox to stream px", () => {
  const a = greyFrame(W, H);
  const b = greyFrame(W, H);
  drawBox(b, W, H, 10, 10, 10, 10);
  const { regions, changed_frac } = diffRegions(a, b, {
    w: W, h: H, streamW: STREAM.w, streamH: STREAM.h, pointer: null,
  });
  assert.equal(regions.length, 1);
  const [x, y, w, h] = regions[0]!.bbox;
  // the component is the 10x10 box dilated by 3 px: analysis [7..22] -> stream x4
  assert.ok(Math.abs(x - 28) <= 4, `x=${x}`);
  assert.ok(Math.abs(y - 28) <= 4, `y=${y}`);
  assert.ok(w >= 56 && w <= 72, `w=${w}`);
  assert.ok(h >= 56 && h <= 72, `h=${h}`);
  assert.ok(changed_frac > 0 && changed_frac < 0.2);
});

test("pointer motion is masked out and does not count as change", () => {
  const a = greyFrame(W, H);
  const b = greyFrame(W, H);
  // change only inside the 40x40 mask is impossible here (frame is 40 wide),
  // so use a bigger frame: 80x60, pointer mask 40x40 at the pointer position
  const W2 = 80;
  const H2 = 60;
  const a2 = greyFrame(W2, H2);
  const b2 = greyFrame(W2, H2);
  drawBox(b2, W2, H2, 30, 20, 20, 20); // fully inside the mask centred at (40,30)
  const { regions, changed_frac } = diffRegions(a2, b2, {
    w: W2, h: H2, streamW: STREAM.w, streamH: STREAM.h, pointer: [40, 30],
  });
  assert.equal(regions.length, 0);
  assert.equal(changed_frac, 0);
});

test("components under 64 analysis px are dropped", () => {
  const a = greyFrame(W, H);
  const b = greyFrame(W, H);
  drawBox(b, W, H, 0, 0, 4, 4); // 16 px < 64
  const { regions } = diffRegions(a, b, {
    w: W, h: H, streamW: STREAM.w, streamH: STREAM.h, pointer: null,
  });
  assert.equal(regions.length, 0);
});

test("changed_frac >= 0.45 marks a cut", () => {
  const a = greyFrame(W, H);
  const b = greyFrame(W, H, 255); // everything changed
  const frames = perceiveRegions([a, b], [0, 100], [null, null], {
    w: W, h: H, streamW: STREAM.w, streamH: STREAM.h,
  });
  assert.equal(frames[1]!.cut, true);
  assert.ok(frames[1]!.changed_frac >= CUT_FRAC);
});

test("perceiveRegions returns one entry per frame, first with no regions", () => {
  const a = greyFrame(W, H);
  const b = greyFrame(W, H);
  drawBox(b, W, H, 10, 10, 10, 10);
  const out = perceiveRegions([a, b, b], [0, 100, 200], [null, null, null], {
    w: W, h: H, streamW: STREAM.w, streamH: STREAM.h,
  });
  assert.equal(out.length, 3);
  assert.equal(out[0]!.regions.length, 0);
  assert.equal(out[1]!.regions.length, 1);
  assert.equal(out[2]!.regions.length, 0); // b vs b: no change
});
