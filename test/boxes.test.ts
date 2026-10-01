import test from "node:test";
import assert from "node:assert/strict";
import { analyzeUiBoxes, detectUiBoxes, uiBoxesAt } from "../src/perceive/boxes.ts";
import { actStart, resultTime, segmentBeats } from "../src/beats/segment.ts";
import { zonesForBeat } from "../src/beats/zones.ts";
import { frame, clippedFractions } from "../src/camera/solver.ts";
import { DEFAULTS } from "../src/camera/defaults.ts";
import type { Action, BBox, Beat, FrameRegions } from "../src/types.ts";

function surface(dark = false): Uint8Array {
  const data = new Uint8Array(320 * 180).fill(dark ? 25 : 240);
  const paint = (x: number, y: number, w: number, h: number, shade: number) => {
    for (let row = y; row < y + h; row++) data.fill(shade, row * 320 + x, row * 320 + x + w);
  };
  paint(40, 35, 90, 40, dark ? 50 : 255);
  paint(150, 35, 90, 40, dark ? 50 : 255);
  // Actual text-shaped holes do not turn a card into a text bbox.
  for (let x = 48; x < 108; x += 8) paint(x, 43, 4, 5, dark ? 210 : 50);
  return data;
}

test("static light and dark cards retain outer bounds despite text holes", () => {
  for (const dark of [false, true]) {
    const boxes = detectUiBoxes(surface(dark), 320, 180, 1280, 720);
    assert.deepEqual(boxes, [[152, 132, 376, 176], [592, 132, 376, 176]]);
  }
  assert.deepEqual(detectUiBoxes(new Uint8Array(320 * 180).fill(200), 320, 180, 1280, 720), []);
});

test("reference budget is bounded, action frames preferred, trim respected", () => {
  const data = surface();
  const dec = { w: 320, h: 180, frames: Array.from({ length: 650 }, (_, i) => ({ t: i * 100, data })) };
  const result = analyzeUiBoxes(dec, { w: 1280, h: 720 }, 2100, 62100, [2500, 2700, 33200]);
  assert.equal(result.frames.length, 60);
  for (const t of [2500, 2700, 33200]) assert.ok(uiBoxesAt(result.frames, [], t).length);
  assert.ok(result.frames.every(f => f.t >= 2100 && f.t < 62100));
  assert.equal(result.cost.references_per_minute, 60);
  assert.equal(result.cost.model_calls, 0);
  assert.equal(result.cost.usd_per_minute, 0);
});

test("dialog surface keeps its outer rectangle around enclosed form fields", () => {
  const data = new Uint8Array(320 * 180).fill(150);
  for (let y = 30; y < 150; y++) data.fill(255, y * 320 + 90, y * 320 + 230);
  // Borders disconnect the white field interiors from the white outer panel.
  for (const [from, until] of [[60, 80], [90, 120]]) {
    for (let y = from!; y < until!; y++) data.fill(225, y * 320 + 100, y * 320 + 220);
    for (let y = from! + 1; y < until! - 1; y++) data.fill(255, y * 320 + 101, y * 320 + 219);
  }
  const boxes = detectUiBoxes(data, 320, 180, 1280, 720);
  assert.deepEqual(boxes[0], [352, 112, 576, 496]);
});

test("reference boxes never cross a cut, redraw, or distant time", () => {
  const boxes: BBox[] = [[150, 120, 400, 180]];
  const refs = [{ t: 1000, boxes }];
  assert.deepEqual(uiBoxesAt(refs, [], 1400), boxes);
  assert.deepEqual(uiBoxesAt(refs, [], 1600), []);
  assert.deepEqual(uiBoxesAt(refs, [{ t: 1200, cut: true, changed_frac: 0, regions: [] }], 1400), []);
  assert.deepEqual(uiBoxesAt(refs, [{ t: 1200, cut: false, changed_frac: .1, regions: [] }], 1400), []);
});

test("empty change perception frames whole cards, panels and dialogs through shared camera", () => {
  const card: BBox = [400, 400, 700, 200];
  const neighbor: BBox = [400, 650, 700, 200];
  const panel: BBox = [2100, 200, 700, 1100];
  const dialog: BBox = [900, 400, 1100, 800];
  for (const [at, point, boxes, subject] of [
    [1000, [700, 500], [card, neighbor], card],
    [4000, [2450, 700], [panel], panel],
    [7000, [1200, 800], [dialog], dialog],
  ] as [number, [number, number], BBox[], BBox][]) {
    const b: Beat = { id: "focus", kind: "click", t0: at - 500, t1: at + 1000,
      anchor_t: at, window_cls: "chromium", zones: [],
      actions: [{ k: "click", t: at, x: point[0], y: point[1], window_cls: "chromium" }] };
    const zones = zonesForBeat(b, { winRect: null, scale: 1, stream: { w: 3200, h: 1800 },
      frames: [{ t: at, regions: [], cut: false, changed_frac: 0 }], uiBoxes: [{ t: at, boxes }] });
    const act = zones.find(z => z.kind === "act")!;
    assert.deepEqual(act.bbox, subject);
    const state = frame({ name: act.name, type: act.kind, bbox: act.bbox, boxes: act.boxes }, 3, 3200, 1800, undefined, DEFAULTS);
    const width = 3200 / state.z;
    const crop = { x: state.cx - width / 2, y: state.cy - width / (16 / 9) / 2, w: width, h: width / (16 / 9) };
    assert.equal(clippedFractions(crop, [subject])[0], 0);
    assert.ok(clippedFractions(crop, boxes).every(f => f === 0 || f >= .9));
  }
});


test("focus and context choose valid references on either side of cuts and redraws", () => {
  const subject: BBox = [900, 340, 760, 620];
  const neighbor: BBox = [1800, 340, 500, 620];
  const stale: BBox = [400, 200, 500, 200];
  const at = 1900;
  const beat: Beat = { id: "dialog", kind: "click", t0: 1850, t1: 2200,
    anchor_t: at, window_cls: "chromium", zones: [],
    actions: [{ k: "click", t: at, x: 1200, y: 560, window_cls: "chromium" }] };
  for (const cut of [true, false]) {
    for (const futureValid of [true, false]) {
      for (const staleDistance of [150, 200]) {
        const validTime = futureValid ? 2100 : 1700;
        const staleTime = at + (futureValid ? -staleDistance : staleDistance);
        const uiBoxes = [{ t: staleTime, boxes: [stale] }, { t: validTime, boxes: [subject, neighbor] }]
          .sort((a, b) => a.t - b.t);
        const changes: FrameRegions[] = [{ t: futureValid ? 1800 : 2000,
          cut, changed_frac: cut ? 0 : .015, regions: [] }];
        const act = zonesForBeat(beat, { winRect: null, scale: 1, stream: { w: 2560, h: 1440 },
          frames: changes, uiBoxes }).find(z => z.kind === "act")!;
        assert.deepEqual(act.bbox, subject);
        assert.deepEqual(act.boxes, [subject, neighbor]);
      }
    }
  }
});

test("one reference per second covers separated unchanged-surface clicks through zones", () => {
  const stream = { w: 2560, h: 1440 };
  const data = new Uint8Array(320 * 180).fill(240);
  for (const [x, y, w, h] of [[42, 25, 61, 16], [42, 44, 61, 16], [248, 16, 68, 159], [180, 44, 61, 16]]) {
    for (let row = y!; row < y! + h!; row++) data.fill(255, row * 320 + x!, row * 320 + x! + w!);
  }
  const dec = { w: 320, h: 180, frames: Array.from({ length: 600 }, (_, i) => ({ t: i * 100, data })) };
  const changes = dec.frames.map(f => ({ t: f.t, cut: false, changed_frac: 0, regions: [] }));
  for (const [start, clickTimes] of [
    [0, [250, 1100, 1900, 2900]],
    [50, [250, 1051, 2049, 2900]],
    [50, [1051, 2049, 2900, 3900]],
  ] as [number, number[]][]) {
    const clicks: Action[] = [[580, 250], [580, 400], [2250, 400], [1680, 400]]
      .map(([x, y], i) => ({ k: "click", t: clickTimes[i]!, x: x!, y: y!, window_cls: "chromium" }));
    const beats = segmentBeats(clicks, changes, { stream, takeMs: 60000, startMs: start, endMs: 60000 });
    const anchors = beats.flatMap(b => [b.anchor_t, ...b.actions.map(actStart), resultTime(b, changes) ?? b.anchor_t]);
    const boxes = detectUiBoxes(data, dec.w, dec.h, stream.w, stream.h);
    for (const times of [anchors, [...anchors].reverse()]) {
      const refs = analyzeUiBoxes(dec, stream, start, 60000, times);
      assert.equal(refs.frames.length, 60);
      assert.equal(new Set(refs.frames.map(f => Math.floor((f.t - start) / 1000))).size, 60);
      assert.ok(refs.frames.every(f => f.boxes.length <= 24));
      assert.equal(refs.cost.model_calls, 0);
      for (const t of clickTimes) assert.deepEqual(uiBoxesAt(refs.frames, changes, t), boxes);
      for (const beat of beats.filter(b => b.actions.some(a => a.k === "click"))) {
        const act = zonesForBeat(beat, { winRect: null, scale: 1, stream, frames: changes,
          uiBoxes: refs.frames }).find(z => z.kind === "act")!;
        assert.deepEqual(act.boxes, boxes);
        for (const action of beat.actions) {
          if (action.k !== "click") continue;
          const subject = boxes.find(([x, y, w, h]) => action.x >= x && action.x <= x + w
            && action.y >= y && action.y <= y + h)!;
          assert.ok(subject);
          const [x, y, w, h] = act.bbox;
          assert.ok(x <= subject[0] && y <= subject[1]
            && x + w >= subject[0] + subject[2] && y + h >= subject[1] + subject[3]);
        }
      }
    }
  }
});

test("lower Tidewater card hold includes nearby context instead of empty board", () => {
  // Static boundaries measured from the real recorded Tidewater frame.
  const boxes: BBox[] = [[1980, 200, 552, 1204], [0, 84, 288, 1356], [0, 0, 2560, 92],
    [332, 196, 496, 140], [884, 196, 496, 140], [1436, 196, 496, 140],
    [332, 344, 496, 140], [884, 344, 496, 140], [1436, 344, 496, 140],
    [332, 492, 496, 140], [1980, 124, 552, 88], [12, 116, 252, 64]];
  const b: Beat = { id: "pricing", kind: "click", t0: 7425, t1: 7425, anchor_t: 7425,
    window_cls: "chromium", zones: [],
    actions: [{ k: "click", t: 7425, x: 580, y: 530, window_cls: "chromium" }] };
  const act = zonesForBeat(b, { winRect: null, scale: 1, stream: { w: 2560, h: 1440 },
    frames: [{ t: 7400, regions: [], cut: false, changed_frac: 0 }],
    uiBoxes: [{ t: 7400, boxes }] }).find(z => z.kind === "act")!;
  // This tight context fixture opts into enlargement; production keeps the native cap.
  const state = frame({ name: act.name, type: act.kind, bbox: act.bbox, boxes: act.boxes }, 3, 2560, 1440,
    undefined, { ...DEFAULTS, max_upscale: 1.5 });
  const w = 2560 / state.z;
  const crop = { x: state.cx - w / 2, y: state.cy - w * 9 / 32, w, h: w * 9 / 16 };
  assert.equal(clippedFractions(crop, [boxes[9]!])[0], 0);
  assert.equal(clippedFractions(crop, [boxes[6]!])[0], 0, "retain the adjacent card above pricing");
  assert.ok(clippedFractions(crop, boxes).every(f => f === 0 || f >= .9));
  assert.ok(crop.w < 1800, "keep the card context readable");
});
