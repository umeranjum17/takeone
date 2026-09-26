import test from "node:test";
import assert from "node:assert/strict";
import { segmentBeats, attachedResults, MAX_BEATS_PER_MIN } from "../src/beats/segment.ts";
import type { Action, FrameRegions, Region } from "../src/types.ts";
import { STREAM, noopFrames } from "./helpers.ts";

const opts = () => ({ stream: STREAM, takeMs: 60000 });

const win: Action = { k: "focus", t: 0, cls: "chromium", rect: [0, 0, STREAM.w, STREAM.h] };
function click(t: number, x = 20, y = 20, cls = "chromium"): Action {
  return { k: "click", t, x, y, window_cls: cls };
}
function typeAct(t0: number, t1: number, cls = "chromium"): Action {
  return { k: "type", t0, t1, window_cls: cls };
}

function framesWith(t: number, bbox: [number, number, number, number], areaFrac?: number): FrameRegions[] {
  const [x, y, w, h] = bbox;
  const r: Region = { bbox, area_frac: areaFrac ?? (w * h) / (STREAM.w * STREAM.h) };
  return [...noopFrames(40, 0, 100).slice(0, Math.ceil(t / 100) + 5)].map((f) =>
    f.t === t ? { ...f, regions: [r] } : f,
  );
}

test("extends a beat while actions are close, same window, near the anchor", () => {
  const beats = segmentBeats([win, click(500, 20, 20), click(1200, 30, 30), click(5000, 25, 25)], noopFrames(60, 0, 100), opts());
  // focus@0 and the two clicks (700 ms apart, same window, near the anchor)
  // form one beat; 5000 is beyond 1.2 s after 1200 -> its own beat, with the
  // 1200-5000 gap as an idle beat
  assert.equal(beats.length, 3);
  assert.equal(beats[0]!.actions.length, 3);
  assert.equal(beats[0]!.kind, "click");
  assert.equal(beats[1]!.kind, "idle");
  assert.equal(beats[2]!.kind, "click");
});

test("focus, dwell, travel and cuts retain their focused window", () => {
  const actions: Action[] = [
    win,
    { k: "dwell", t0: 100, t1: 1100, x: 20, y: 20, window_cls: "chromium" },
    { k: "travel", t0: 1200, t1: 1600, from: [20, 20], to: [80, 80], bbox: [20, 20, 60, 60], window_cls: "chromium" },
    { k: "cut", t: 1800, changed_frac: 0.6, window_cls: "chromium" },
  ];
  const beats = segmentBeats(actions, [], opts());
  assert.ok(beats.every((b) => b.window_cls === "chromium"));
  assert.ok(beats.some((b) => b.kind === "cut"));
});

test("a gap of 2 s or more becomes an idle beat", () => {
  const beats = segmentBeats([win, click(500), click(5000)], noopFrames(60, 0, 100), opts());
  assert.equal(beats.length, 3);
  assert.equal(beats[1]!.kind, "idle");
  assert.equal(beats[1]!.t0, 500); // a click ends at its t
  assert.equal(beats[1]!.t1, 5000);
});

test("a cut always starts a new beat of kind cut", () => {
  const cut: Action = { k: "cut", t: 2000, changed_frac: 0.6 };
  const beats = segmentBeats([win, click(500), cut, click(2500)], noopFrames(60, 0, 100), opts());
  const cutBeat = beats.find((b) => b.kind === "cut");
  assert.ok(cutBeat);
  assert.equal(cutBeat.t0, 2000);
  assert.equal(cutBeat.actions[0]!.k, "cut");
  // actions before and after the cut sit in different beats
  const clickBeats = beats.filter((b) => b.kind === "click");
  assert.equal(clickBeats.length, 2);
});

test("long gaps around cuts become idle beats after the cut settles", () => {
  const cut: Action = { k: "cut", t: 1000, changed_frac: 0.6, window_cls: "chromium" };
  const settling: FrameRegions[] = [
    { t: 1000, changed_frac: 0.6, cut: true, regions: [] },
    ...[1100, 1200, 1300, 1400].map((t) => ({ t, changed_frac: 0.01, cut: false, regions: [] })),
  ];
  const after = segmentBeats([cut, click(10000)], settling, { ...opts(), startMs: 0, endMs: 10000 });
  assert.deepEqual(after.map((b) => [b.kind, b.t0, b.t1]), [
    ["cut", 1000, 1400], ["idle", 1400, 10000], ["click", 10000, 10000],
  ]);
  const before = segmentBeats([win, click(500), { ...cut, t: 10000 }], [], { ...opts(), startMs: 0, endMs: 10000 });
  assert.deepEqual(before.map((b) => b.kind), ["click", "idle", "cut"]);
  assert.deepEqual([before[1]!.t0, before[1]!.t1], [500, 10000]);
});

test("cut settling follows quiet frames rather than a fixed tail", () => {
  const frames: FrameRegions[] = [
    ...[1000, 1100, 1200, 1300, 1400, 1500, 1600].map((t) => ({ t, changed_frac: 0.2, cut: t === 1000, regions: [] })),
    ...[1700, 1800, 1900, 2000].map((t) => ({ t, changed_frac: 0.01, cut: false, regions: [] })),
  ];
  const beats = segmentBeats([{ k: "cut", t: 1000, changed_frac: 0.6 }, click(10000)], frames, { ...opts(), startMs: 0, endMs: 10000 });
  assert.deepEqual(beats.map((b) => [b.kind, b.t0, b.t1]), [["cut", 1000, 2000], ["idle", 2000, 10000], ["click", 10000, 10000]]);
});

test("cuts close every spanning action before results can cross the boundary", () => {
  const region: Region = { bbox: [10, 10, 60, 50], area_frac: 0.1 };
  const frames: FrameRegions[] = [
    { t: 2000, changed_frac: 0.6, cut: true, regions: [] },
    { t: 2100, changed_frac: 0.01, cut: false, regions: [region] },
    ...[2200, 2300, 2400].map((t) => ({ t, changed_frac: 0.01, cut: false, regions: [] })),
  ];
  const spanning: Action[] = [
    typeAct(0, 4000),
    { k: "dwell", t0: 0, t1: 4000, x: 20, y: 20, window_cls: "chromium" },
    { k: "scroll", t0: 0, t1: 4000, x: 20, y: 20, dx: 0, dy: 2, detents: 2, window_cls: "chromium" },
    { k: "drag", t0: 0, t1: 4000, from: [10, 10], to: [80, 80], bbox: [10, 10, 70, 70], window_cls: "chromium" },
    { k: "travel", t0: 0, t1: 4000, from: [10, 10], to: [80, 80], bbox: [10, 10, 70, 70], window_cls: "chromium" },
  ];
  for (const action of spanning) {
    const beats = segmentBeats([action, { k: "cut", t: 2000, changed_frac: 0.6 }], frames, opts());
    assert.equal(beats[0]!.t1, 2000, action.k);
    assert.equal("t1" in beats[0]!.actions[0]! ? beats[0]!.actions[0]!.t1 : undefined, 2000, action.k);
    assert.equal(beats[1]!.kind, "cut", action.k);
    assert.ok(!beats[0]!.results?.includes(region), action.k);
    assert.equal("t1" in action ? action.t1 : undefined, 4000, action.k);
  }
});

test("trim boundaries and an all-idle take produce idle beats", () => {
  const bounds = { ...opts(), startMs: 2000, endMs: 10000 };
  assert.deepEqual(segmentBeats([], [], bounds).map((b) => [b.kind, b.t0, b.t1]), [["idle", 2000, 10000]]);
  assert.deepEqual(segmentBeats([click(5000)], [], bounds).map((b) => [b.kind, b.t0, b.t1]), [
    ["idle", 2000, 5000], ["click", 5000, 5000], ["idle", 5000, 10000],
  ]);
});

test("beats shorter than 0.8 s merge into the previous beat with the same window", () => {
  const beats = segmentBeats(
    [win, click(500, 20, 20), typeAct(2000, 2100), typeAct(3500, 4500)],
    noopFrames(60, 0, 100),
    opts(),
  );
  // the 100 ms type beat folds into the previous chromium beat (which also
  // carries the folded focus beat)
  const merged = beats.find((b) => b.actions.some((a) => a.k === "type" && a.t0 === 2000));
  assert.ok(merged);
  assert.equal(merged.actions.length, 3); // focus + click + short type
});

test("beats shorter than 0.8 s merge into the next beat when the window differs", () => {
  const beats = segmentBeats(
    [typeAct(2000, 2100, "alacritty"), typeAct(3500, 4600, "alacritty"), click(6000, 20, 20, "chromium")],
    noopFrames(70, 0, 100),
    opts(),
  );
  // the 100 ms alacritty type beat has no previous beat, so it folds into the
  // next alacritty beat; the trailing chromium click has no same-window next
  // and glues into the previous beat as a last resort
  const alBeats = beats.filter((b) => b.window_cls === "alacritty");
  assert.equal(alBeats.length, 1);
  assert.equal(alBeats[0]!.actions.length, 3); // short type + long type + folded click
  assert.equal(alBeats[0]!.t0, 2000);
});

test("hard cap: beats per minute never exceed 30", () => {
  // 45 rapid clicks at 1.1 s spacing, each beyond the 1.2 s extension? No:
  // 1.1 s spacing is within 1.2 s, so use 1.3 s spacing and spread the anchors
  // beyond 0.35 x diagonal by jumping across the frame.
  const actions: Action[] = [win];
  for (let i = 0; i < 45; i++) {
    const x = (i % 2 === 0 ? 5 : 150);
    actions.push(click(500 + i * 1300, x, 60));
  }
  const beats = segmentBeats(actions, noopFrames(500, 0, 100), opts());
  assert.ok(beats.length <= MAX_BEATS_PER_MIN, `expected <= 30 beats/min, got ${beats.length}`);
});

test("hard cap merges cut-only takes while retaining cut kind", () => {
  const cuts: Action[] = Array.from({ length: 35 }, (_, i) => ({ k: "cut", t: 500 + i * 1600, changed_frac: 0.6 }));
  const beats = segmentBeats(cuts, [], opts());
  assert.equal(beats.length, 30);
  assert.ok(beats.every((b) => b.kind === "cut"));
  assert.equal(beats.flatMap((b) => b.actions).filter((a) => a.k === "cut").length, 35);
});

test("a later action owns its result instead of the preceding beat", () => {
  const region: Region = { bbox: [0, 0, 40, 40], area_frac: 0.08 };
  const frames: FrameRegions[] = [{ t: 2400, cut: false, changed_frac: 0.08, regions: [region] }];
  const beats = segmentBeats([typeAct(0, 1000), { k: "cut", t: 2200, changed_frac: 0.7 }, click(2300, 150, 100)], frames, opts());
  const first = beats.find((b) => b.actions.some((a) => a.k === "type"))!;
  const second = beats.find((b) => b.actions.some((a) => a.k === "click"))!;
  assert.ok(!first.results?.includes(region));
  assert.ok(second.results?.includes(region));
});

test("result attachment: region of area >= 0.005 within 1.5 s after the last action", () => {
  const frames = framesWith(1300, [0, 60, 60, 60]); // 3600/19200 = 0.1875 area
  const beats = segmentBeats([win, click(500, 20, 20), click(1200, 30, 30)], frames, opts());
  const b = beats[0]!;
  assert.ok(b.results && b.results.length === 1, "expected a result attached");
  assert.deepEqual(b.results![0]!.bbox, [0, 60, 60, 60]);
});

test("small or late regions are not attached as results", () => {
  const frames = framesWith(5000, [0, 0, 30, 30]); // 900/19200 ~ 0.047 but too late (>1.5s)
  const beats = segmentBeats([win, click(500, 20, 20)], frames, opts());
  assert.ok(!beats[0]!.results);
});

test("attachedResults sorts largest first and respects the window", () => {
  const frames: FrameRegions[] = [
    { t: 1000, changed_frac: 0.1, cut: false, regions: [{ bbox: [0, 0, 10, 10], area_frac: 0.001 }] }, // too small
    { t: 1200, changed_frac: 0.1, cut: false, regions: [{ bbox: [0, 0, 40, 40], area_frac: 0.083 }] },
    { t: 1400, changed_frac: 0.1, cut: false, regions: [{ bbox: [80, 80, 20, 20], area_frac: 0.02 }] },
    { t: 3000, changed_frac: 0.1, cut: false, regions: [{ bbox: [0, 0, 80, 80], area_frac: 0.33 }] }, // too late
  ];
  const res = attachedResults(frames, 1100, 2600);
  assert.equal(res.length, 2);
  assert.deepEqual(res[0]!.bbox, [0, 0, 40, 40]);
  assert.deepEqual(res[1]!.bbox, [80, 80, 20, 20]);
});
