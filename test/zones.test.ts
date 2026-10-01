import test from "node:test";
import assert from "node:assert/strict";
import { zonesForBeat, delayWords, OCR_MAX_AREA } from "../src/beats/zones.ts";
import { actStart } from "../src/beats/segment.ts";
import type { Action, Beat, FrameRegions, Region } from "../src/types.ts";
import { STREAM, noopFrames } from "./helpers.ts";

const frames: FrameRegions[] = noopFrames(20, 0, 100);
const base = { stream: STREAM, scale: 1, frames };

function beatOf(actions: Action[], results?: Region[]): Beat {
  return {
    id: "b1",
    t0: actStart(actions[0]!),
    t1: 5000,
    anchor_t: 500,
    window_cls: "chromium",
    actions,
    zones: [],
    kind: "click",
    results,
  };
}

test("act zone pads the click point by 40x28 x scale and unites small regions", () => {
  const b = beatOf([{ k: "click", t: 500, x: 100, y: 60, window_cls: "chromium" }]);
  const framesWithRegion: FrameRegions[] = [
    ...frames.slice(0, 5),
    { t: 600, changed_frac: 0.01, cut: false, regions: [{ bbox: [90, 50, 30, 20], area_frac: 0.01 }] },
    ...frames.slice(6),
  ];
  const zones = zonesForBeat(b, { ...base, frames: framesWithRegion, winRect: [0, 0, 100, 100] });
  const act = zones.find((z) => z.kind === "act")!;
  // pad 40/28 around (100,60), united with the region at (90,50)-(120,70)
  assert.equal(act.bbox[0], 60);
  assert.equal(act.bbox[1], 32);
  assert.deepEqual([act.bbox[2], act.bbox[3]], [80, 56]);
});

test("act zone holds the panel a click opened, but not a large change elsewhere", () => {
  // Scaled from the synthetic take: the row click at (430,690) opens a 972x692 panel.
  const b = beatOf([{ k: "click", t: 500, x: 36, y: 77, window_cls: "chromium" }]);
  const withRegion = (bbox: [number, number, number, number]): FrameRegions[] => [
    ...frames.slice(0, 5),
    { t: 600, changed_frac: 0.19, cut: false, regions: [{ bbox, area_frac: 0.19 }] },
    ...frames.slice(6),
  ];
  const act = (bbox: [number, number, number, number]) =>
    zonesForBeat(b, { ...base, frames: withRegion(bbox), winRect: null }).find((z) => z.kind === "act")!.bbox;
  // The panel unites with the padded click point (clamped to the screen).
  assert.deepEqual(act([7, 25, 81, 77]), [0, 25, 88, 80]);
  // A region not holding the click (a far-away result) stays out of the act zone.
  assert.deepEqual(act([90, 10, 60, 60]), [0, 49, 76, 56]);
});

test("zones: dedupe IoU > 0.6 keeps the smaller, names are z1..zN smallest to largest", () => {
  const b = beatOf([{ k: "click", t: 500, x: 80, y: 60, window_cls: "chromium" }]);
  // act and a small window overlap but stay distinct (IoU < 0.6); zones are act + win + all
  const winRect: [number, number, number, number] = [50, 40, 60, 40];
  const zones = zonesForBeat(b, { ...base, winRect });
  assert.equal(zones.length, 3); // act, win, all (win is not >90% of screen)
  for (let i = 0; i < zones.length; i++) {
    assert.equal(zones[i]!.name, `z${i + 1}`);
  }
  // smallest to largest
  for (let i = 1; i < zones.length; i++) {
    const a = zones[i - 1]!;
    const c = zones[i]!;
    assert.ok(a.bbox[2] * a.bbox[3] <= c.bbox[2] * c.bbox[3], `z${i} not >= z${i - 1} by area`);
  }
});

test("large window cannot replace the all candidate", () => {
  const b = beatOf([{ k: "focus", t: 500, cls: "chromium", rect: [0, 0, 150, 90] }]);
  const zones = zonesForBeat(b, { ...base, winRect: [0, 0, STREAM.w, STREAM.h * 0.7] });
  assert.deepEqual(zones.map((z) => z.kind), ["win", "all"]);
});

test("result zone spans everything that changed, not only the largest region", () => {
  // A toast at the bottom and the new card it announces at the top right.
  const b = beatOf([{ k: "click", t: 500, x: 90, y: 40, window_cls: "chromium" }], [
    { bbox: [0, 90, 40, 20], area_frac: 0.1 },
    { bbox: [140, 0, 20, 20], area_frac: 0.01 },
  ]);
  const zones = zonesForBeat(b, { ...base, winRect: null });
  assert.deepEqual(zones.find((z) => z.kind === "res")?.bbox, [0, 0, 160, 110]);
});

test("a typing beat's zone covers every field it typed into", () => {
  const b = beatOf([
    { k: "type", t0: 500, t1: 1500, region: [40, 20, 30, 8] },
    { k: "click", t: 1700, x: 50, y: 50, window_cls: "chromium" },
    { k: "type", t0: 1800, t1: 2800, region: [40, 46, 50, 10] },
  ] as Action[]);
  const txt = zonesForBeat(b, { ...base, winRect: null }).find((z) => z.kind === "txt")!;
  assert.deepEqual(txt.bbox, [40, 20, 50, 36]);
});

test("result activity time belongs to its largest region", () => {
  const small: Region = { bbox: [140, 0, 20, 20], area_frac: 0.01 };
  const large: Region = { bbox: [0, 90, 40, 20], area_frac: 0.1 };
  const b = beatOf([{ k: "click", t: 500, x: 90, y: 40, window_cls: "chromium" }], [large, small]);
  const changed: FrameRegions[] = [
    { t: 600, changed_frac: 0.01, cut: false, regions: [small] },
    { t: 1300, changed_frac: 0.1, cut: false, regions: [large] },
  ];
  const res = zonesForBeat(b, { ...base, frames: changed, winRect: null }).find((z) => z.kind === "res");
  assert.equal(res?.t, 1300);
});

test("win zone is skipped when the window covers more than 90% of the screen", () => {
  const b = beatOf([{ k: "click", t: 500, x: 80, y: 60, window_cls: "chromium" }]);
  const zones = zonesForBeat(b, { ...base, winRect: [0, 0, STREAM.w, STREAM.h] });
  assert.ok(!zones.some((z) => z.kind === "win"));
  assert.ok(zones.some((z) => z.kind === "all"));
});

test("res zone only exists when IoU against act is under 0.3", () => {
  const results = [{ bbox: [0, 90, 100, 30] as [number, number, number, number], area_frac: 0.15 }]; // far from the act zone
  const b = beatOf([{ k: "click", t: 500, x: 80, y: 60, window_cls: "chromium" }], results);
  const zones = zonesForBeat(b, { ...base, winRect: [0, 0, 100, 80] });
  assert.ok(zones.some((z) => z.kind === "res"));

  const overlapping = [{ bbox: [60, 40, 40, 40] as [number, number, number, number], area_frac: 0.08 }]; // overlaps act heavily
  const b2 = beatOf([{ k: "click", t: 500, x: 80, y: 60, window_cls: "chromium" }], overlapping);
  const zones2 = zonesForBeat(b2, { ...base, winRect: [0, 0, 100, 80] });
  assert.ok(!zones2.some((z) => z.kind === "res"));
});

test("txt zone from the typing region", () => {
  const b = beatOf([{ k: "type", t0: 500, t1: 1500, window_cls: "chromium", region: [10, 10, 60, 20] }]);
  const zones = zonesForBeat(b, { ...base, winRect: [0, 0, 100, 100] });
  const txt = zones.find((z) => z.kind === "txt")!;
  assert.deepEqual(txt.bbox, [10, 10, 60, 20]);
});

test("path zone from drag bbox", () => {
  const b = beatOf([{ k: "drag", t0: 500, t1: 1200, from: [10, 10], to: [100, 80], bbox: [10, 10, 90, 70], window_cls: "chromium" }]);
  const zones = zonesForBeat(b, { ...base, winRect: [0, 0, 100, 100] });
  const path = zones.find((z) => z.kind === "path")!;
  assert.deepEqual(path.bbox, [10, 10, 90, 70]);
});

test("word descriptions never contain digits", () => {
  const b = beatOf([{ k: "click", t: 500, x: 80, y: 60, window_cls: "chromium" }], [
    { bbox: [0, 90, 100, 30] as [number, number, number, number], area_frac: 0.15 },
  ]);
  b.t1 = 2500;
  const zones = zonesForBeat(b, { ...base, winRect: [0, 0, 100, 80] });
  assert.ok(zones.length >= 2);
  for (const z of zones) {
    for (const part of [z.desc.shows, z.desc.size, z.desc.where, z.desc.activity]) {
      assert.ok(!/\d/.test(part), `digits in "${part}"`);
    }
  }
  const b2 = beatOf([{ k: "click", t: 500, x: 80, y: 60, window_cls: "PrivateCustomer123" }]);
  b2.window_cls = "PrivateCustomer123";
  const zones2 = zonesForBeat(b2, { ...base, winRect: [0, 0, 100, 80] });
  const winZone = zones2.find((z) => z.kind === "win")!;
  assert.equal(winZone.desc.shows, "the app window");
});

test("size words follow the area thresholds", () => {
  const b = beatOf([{ k: "click", t: 500, x: 80, y: 60, window_cls: "chromium" }]);
  // all-zone size is "the whole screen"; win zone 100x80 of 160x120 = 41% -> large
  const zones = zonesForBeat(b, { ...base, winRect: [0, 0, 100, 80] });
  const all = zones.find((z) => z.kind === "all")!;
  assert.equal(all.desc.size, "the whole screen");
  const win = zones.find((z) => z.kind === "win")!;
  assert.equal(win.desc.size, "large, most of the window");
});

test("where words use the 3x3 grid", () => {
  const mk = (x: number, y: number) =>
    beatOf([{ k: "click", t: 500, x, y, window_cls: "chromium" }]);
  const center = zonesForBeat(mk(80, 60), { ...base, winRect: [40, 30, 80, 60] }).find((z) => z.kind === "act")!;
  assert.equal(center.desc.where, "center");
  const tl = zonesForBeat(mk(10, 10), { ...base, winRect: [0, 0, 60, 40] }).find((z) => z.kind === "act")!;
  assert.equal(tl.desc.where, "top left");
  const br = zonesForBeat(mk(150, 110), { ...base, winRect: [100, 80, 60, 40] }).find((z) => z.kind === "act")!;
  assert.equal(br.desc.where, "bottom right");
});

test("delay words quantize without digits", () => {
  assert.ok(!/\d/.test(delayWords(100)));
  assert.ok(!/\d/.test(delayWords(900)));
  assert.ok(!/\d/.test(delayWords(2500)));
});

test("at most 6 zones per beat", () => {
  const b = beatOf([
    { k: "click", t: 500, x: 80, y: 60, window_cls: "chromium" },
    { k: "type", t0: 700, t1: 1500, window_cls: "chromium", region: [5, 5, 20, 10] },
    { k: "drag", t0: 1600, t1: 2000, from: [10, 10], to: [30, 30], bbox: [10, 10, 20, 20], window_cls: "chromium" },
  ]);
  const zones = zonesForBeat(b, { ...base, winRect: [2, 2, 100, 80] });
  assert.ok(zones.length <= 6);
  assert.ok(zones.length >= 2);
});

test("OCR eligibility: zones under a quarter of the screen", () => {
  const b = beatOf([{ k: "click", t: 500, x: 80, y: 60, window_cls: "chromium" }]);
  const zones = zonesForBeat(b, { ...base, winRect: [0, 0, 100, 80] });
  for (const z of zones) {
    const eligible = z.area_frac < OCR_MAX_AREA;
    if (z.kind === "all") assert.ok(!eligible);
    if (z.kind === "act") assert.ok(eligible);
  }
});

test("act zone is described by its anchoring action, not by pointer travel before it", () => {
  const b = beatOf([
    { k: "travel", t0: 0, t1: 400, from: [10, 10], to: [100, 60], bbox: [10, 10, 90, 50] },
    { k: "dwell", t0: 500, t1: 3000, x: 100, y: 60 },
  ]);
  const act = zonesForBeat(b, { ...base, winRect: null }).find((z) => z.kind === "act")!;
  assert.equal(act.desc.shows, "the control the user pointed at");
  assert.equal(act.desc.activity, "the pointer rested here");
});

test("a typing beat's zone takes in a dropdown opening just below the form, not a far result", () => {
  const actions = [
    { k: "type", t0: 500, t1: 1500, region: [40, 20, 30, 8] },
    { k: "click", t: 1700, x: 50, y: 40, window_cls: "chromium" },
  ] as Action[];
  const menu: Region = { bbox: [45, 70, 20, 30], area_frac: 0.03 }; // 30 px below, scale 1: within 56
  const far: Region = { bbox: [130, 100, 20, 10], area_frac: 0.01 };
  const txt = (results: Region[]) => zonesForBeat(beatOf(actions, results), { ...base, winRect: null }).find((z) => z.kind === "txt")!.bbox;
  assert.deepEqual(txt([menu]), [40, 20, 30, 80]);
  assert.deepEqual(txt([far]), [40, 20, 30, 21]);
  // a modal's scrim closing changes the whole screen: never part of the form
  assert.deepEqual(txt([{ bbox: [0, 0, 160, 120], area_frac: 0.98 }]), [40, 20, 30, 21]);
});

test("context boxes survive candidate deduplication and keep individual card boundaries", () => {
  const b = beatOf([{ k: 'click', t: 500, x: 80, y: 60, window_cls: 'chromium' }]);
  const boxes: Region[] = [{ bbox: [40, 25, 80, 70], area_frac: .29 }, { bbox: [125, 25, 30, 70], area_frac: .11 }];
  const zs = zonesForBeat(b, { ...base, winRect: null, frames: [
    { t: 500, cut: false, changed_frac: .1, regions: boxes },
    { t: 600, cut: false, changed_frac: .1, regions: [...boxes, { bbox: [0, 0, 160, 120], area_frac: 1 }] },
  ] });
  assert.deepEqual(zs.find(z => z.kind === 'act')?.boxes, boxes.map(r => r.bbox));
});
