import test from "node:test";
import assert from "node:assert/strict";
import { actionsFromEvents } from "../src/perceive/actions.ts";
import { segmentBeats } from "../src/beats/segment.ts";
import type { Action, Event, FrameRegions } from "../src/types.ts";
import { STREAM, noopFrames } from "./helpers.ts";

const frames = () => noopFrames(60, 0, 100);
const opts = () => ({ stream: STREAM, pointer: "hyprland" });

const win: Event = { t: 0, k: "win", cls: "chromium", title: "Doc", rect: [0, 0, STREAM.w, STREAM.h] };

function ptr(x: number, y: number, t: number): Event {
  return { t, k: "ptr", x, y };
}
function btn(down: boolean, t: number): Event {
  return { t, k: "btn", b: "left", down };
}

test("no focused window clears focus and later actions have no stale class", () => {
  const acts = actionsFromEvents([
    win, ptr(10, 10, 100),
    { t: 200, k: "win", cls: "", title: "", rect: null },
    btn(true, 300), btn(false, 350),
    { t: 400, k: "win", cls: "editor", title: "Edit", rect: [0, 0, 100, 100] },
    btn(true, 500), btn(false, 550),
  ], frames(), opts());
  assert.deepEqual(acts.filter((a) => a.k === "focus").map((a) => a.cls), ["chromium", "editor"]);
  assert.deepEqual(acts.filter((a) => a.k === "click").map((a) => a.window_cls), ["", "editor"]);
});

test("click: down/up within 300 ms and 6 px", () => {
  const acts = actionsFromEvents([win, ptr(10, 10, 400), btn(true, 500), btn(false, 560), ptr(12, 12, 560)], frames(), opts());
  const clicks = acts.filter((a) => a.k === "click");
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0]!.x, 10);
  assert.equal(clicks[0]!.y, 10);
});

test("a short press moving nine pixels clicks at the down point", () => {
  const acts = actionsFromEvents([win, ptr(10, 10, 400), btn(true, 500), ptr(19, 10, 550), btn(false, 600)], frames(), opts());
  assert.deepEqual(acts.filter((a) => a.k === "click").map((a) => [a.x, a.y]), [[10, 10]]);
  assert.equal(acts.filter((a) => a.k === "drag").length, 0);
});

test("second click within 400 ms and 6 px makes a double", () => {
  const acts = actionsFromEvents(
    [
      win,
      ptr(10, 10, 400),
      btn(true, 500), btn(false, 550),
      btn(true, 800), btn(false, 850),
    ],
    frames(),
    opts(),
  );
  const clicks = acts.filter((a) => a.k === "click");
  assert.equal(clicks.length, 1);
  assert.equal((clicks[0] as { double?: boolean }).double, true);
});

test("clicks outside trim cannot consume an in-trim click", () => {
  const clicks = (first: number, second: number) => [
    win, ptr(10, 10, 100), btn(true, first - 50), btn(false, first),
    btn(true, second - 50), btn(false, second),
  ];
  const after = actionsFromEvents(clicks(500, 700), frames(), { ...opts(), startMs: 400, endMs: 600 });
  assert.deepEqual(after.filter((a) => a.k === "click").map((a) => [a.t, a.double]), [[500, undefined]]);
  const before = actionsFromEvents(clicks(300, 500), frames(), { ...opts(), startMs: 400, endMs: 600 });
  assert.deepEqual(before.filter((a) => a.k === "click").map((a) => [a.t, a.double]), [[500, undefined]]);
  const within = actionsFromEvents(clicks(500, 700), frames(), { ...opts(), startMs: 400, endMs: 700 });
  assert.deepEqual(within.filter((a) => a.k === "click").map((a) => [a.t, a.double]), [[700, true]]);
});

test("different mouse buttons remain separate clicks", () => {
  const acts = actionsFromEvents([
    win, ptr(10, 10, 400), btn(true, 500), btn(false, 550),
    { t: 800, k: "btn", b: "right", down: true },
    { t: 850, k: "btn", b: "right", down: false },
  ], frames(), opts());
  assert.deepEqual(acts.filter((a) => a.k === "click").map((a) => [a.t, a.double]), [[550, undefined], [850, undefined]]);
});

test("drag: held more than 300 ms", () => {
  const acts = actionsFromEvents(
    [win, ptr(10, 10, 400), btn(true, 500), ptr(60, 60, 700), btn(false, 1000), ptr(60, 60, 1000)],
    frames(),
    opts(),
  );
  const drags = acts.filter((a) => a.k === "drag");
  assert.equal(drags.length, 1);
  const d = drags[0]!;
  assert.deepEqual(d.from, [10, 10]);
  assert.deepEqual(d.to, [60, 60]);
});

test("drag: moved more than 12 px even when brief", () => {
  const acts = actionsFromEvents(
    [win, ptr(10, 10, 400), btn(true, 500), ptr(40, 40, 520), btn(false, 540), ptr(40, 40, 540)],
    frames(),
    opts(),
  );
  assert.equal(acts.filter((a) => a.k === "drag").length, 1);
  assert.equal(acts.filter((a) => a.k === "click").length, 0);
});

test("drag and travel geometry excludes pointer movement after trim", () => {
  const drag = actionsFromEvents([
    win, ptr(10, 10, 100), btn(true, 200), ptr(50, 50, 500), ptr(200, 100, 900), btn(false, 1000),
  ], frames(), { ...opts(), endMs: 600 }).find((a) => a.k === "drag");
  assert.ok(drag);
  assert.equal(drag.t1, 1000);
  assert.deepEqual(drag.to, [50, 50]);
  assert.deepEqual(drag.bbox, [10, 10, 40, 40]);

  const travel = actionsFromEvents([
    win, ptr(10, 10, 100), ptr(120, 10, 400), ptr(280, 90, 900),
  ], frames(), { ...opts(), endMs: 600 }).find((a) => a.k === "travel");
  assert.ok(travel);
  assert.equal(travel.t1, 400);
  assert.deepEqual(travel.to, [120, 10]);
  assert.deepEqual(travel.bbox, [10, 10, 110, 0]);
});

test("post-trim pointer samples cannot create dwell or travel", () => {
  const stationary = actionsFromEvents([
    win, ptr(50, 50, 100), ptr(50, 50, 500), ptr(50, 50, 1000),
  ], frames(), { ...opts(), endMs: 600 });
  assert.equal(stationary.filter((a) => a.k === "dwell").length, 0);

  const moving = actionsFromEvents([
    win, ptr(10, 10, 100), ptr(30, 10, 500), ptr(250, 10, 1000),
  ], frames(), { ...opts(), endMs: 600 });
  assert.equal(moving.filter((a) => a.k === "travel").length, 0);
});

test("scroll merges wheel events with gaps under 500 ms", () => {
  const wheel = (t: number): Event => ({ t, k: "wheel", dx: 0, dy: 1 });
  const acts = actionsFromEvents(
    [win, ptr(50, 50, 100), wheel(500), wheel(700), wheel(1400)],
    frames(),
    opts(),
  );
  const scrolls = acts.filter((a) => a.k === "scroll");
  assert.equal(scrolls.length, 2); // 500,700 merge; 1400 is a new burst
  assert.equal(scrolls[0]!.detents, 2);
  assert.equal(scrolls[0]!.dy, 2);
});

test("scroll payload excludes wheel events after trim", () => {
  const events: Event[] = [
    win, ptr(50, 50, 100),
    { t: 500, k: "wheel", dx: 2, dy: 1 },
    { t: 900, k: "wheel", dx: 3, dy: 9 },
  ];
  const full = actionsFromEvents(events, frames(), opts()).find((a) => a.k === "scroll");
  assert.ok(full);
  assert.deepEqual([full.t1, full.dx, full.dy, full.detents], [900, 5, 10, 2]);

  const scoped = actionsFromEvents(events, frames(), { ...opts(), endMs: 600 });
  const scroll = scoped.find((a) => a.k === "scroll");
  assert.ok(scroll);
  assert.deepEqual([scroll.t0, scroll.t1, scroll.dx, scroll.dy, scroll.detents], [500, 500, 2, 1, 1]);
  const beats = segmentBeats(scoped, frames(), { stream: STREAM, takeMs: 600, startMs: 0, endMs: 600 });
  const retained = beats.flatMap((b) => b.actions).find((a) => a.k === "scroll");
  assert.ok(retained);
  assert.deepEqual([retained.t1, retained.dx, retained.dy, retained.detents], [500, 2, 1, 1]);
});

test("type merges key downs with gaps under 1.2 s", () => {
  const key = (t: number): Event => ({ t, k: "key", cls: "char", down: true });
  const acts = actionsFromEvents([win, key(500), key(1000), key(3000)], frames(), opts());
  const types = acts.filter((a) => a.k === "type");
  assert.equal(types.length, 2);
  assert.equal(types[0]!.t1 - types[0]!.t0, 500);
});

test("typing region is the union of change regions during the burst", () => {
  const key = (t: number): Event => ({ t, k: "key", cls: "char", down: true });
  const framesWithRegions: FrameRegions[] = [
    ...noopFrames(5, 0, 100),
    { t: 550, changed_frac: 0.02, cut: false, regions: [{ bbox: [10, 10, 20, 10] as [number, number, number, number], area_frac: 0.01 }] },
    { t: 650, changed_frac: 0.02, cut: false, regions: [{ bbox: [20, 15, 30, 10] as [number, number, number, number], area_frac: 0.01 }] },
    ...noopFrames(10, 700, 100),
  ];
  const acts = actionsFromEvents([win, key(500), key(600)], framesWithRegions, opts());
  const t = acts.find((a) => a.k === "type")!;
  assert.deepEqual(t.region, [10, 10, 40, 15]);
});

test("shortcut records combos", () => {
  const acts = actionsFromEvents(
    [win, { t: 500, k: "key", cls: "char", down: true, combo: "Ctrl+S" }],
    frames(),
    opts(),
  );
  const sc = acts.find((a) => a.k === "shortcut");
  assert.ok(sc);
  assert.equal(sc.combo, "Ctrl+S");
});

test("shortcut key-up does not duplicate the key-down action", () => {
  const acts = actionsFromEvents([win,
    { t: 500, k: "key", cls: "char", down: true, combo: "Ctrl+S" },
    { t: 600, k: "key", cls: "char", down: false, combo: "Ctrl+S" },
  ], frames(), opts());
  assert.deepEqual(acts.filter((a) => a.k === "shortcut").map((a) => a.t), [500]);
});

test("focus on window class change", () => {
  const acts = actionsFromEvents(
    [
      { t: 0, k: "win", cls: "chromium", title: "a", rect: [0, 0, 100, 100] },
      { t: 500, k: "win", cls: "alacritty", title: "b", rect: [0, 0, 100, 100] },
      { t: 600, k: "win", cls: "alacritty", title: "c", rect: [0, 0, 100, 100] }, // same class: no focus
    ],
    frames(),
    opts(),
  );
  const foci = acts.filter((a) => a.k === "focus");
  assert.equal(foci.length, 2);
});

test("dwell: pointer within 12 px for >= 0.8 s with no button", () => {
  const acts = actionsFromEvents(
    [win, ptr(50, 50, 100), ptr(51, 50, 500), ptr(52, 51, 1200)],
    frames(),
    opts(),
  );
  const dw = acts.find((a) => a.k === "dwell");
  assert.ok(dw);
  assert.ok(dw.t1 - dw.t0 >= 800);
});

test("dwell preserves each button-free portion of a stationary run", () => {
  const before = actionsFromEvents([win, ptr(50, 50, 0), ptr(50, 50, 1000), btn(true, 1100), btn(false, 1300), ptr(50, 50, 2200)], frames(), opts());
  assert.deepEqual(before.filter((a) => a.k === "dwell").map((a) => [a.t0, a.t1]), [[0, 1000]]);
  const after = actionsFromEvents([win, ptr(50, 50, 0), btn(true, 100), btn(false, 300), ptr(50, 50, 500), ptr(50, 50, 1500)], frames(), opts());
  assert.deepEqual(after.filter((a) => a.k === "dwell").map((a) => [a.t0, a.t1]), [[500, 1500]]);
  const boundary = actionsFromEvents([win, ptr(50, 50, 0), btn(true, 100), btn(false, 700), ptr(50, 50, 700), ptr(50, 50, 1700)], frames(), opts());
  assert.deepEqual(boundary.filter((a) => a.k === "dwell").map((a) => [a.t0, a.t1]), [[700, 1700]]);
});

test("travel: path over 25% of the diagonal within 1 s, no click", () => {
  // diagonal ~200; 25% = 50 px of path
  const events: Event[] = [win, ptr(10, 10, 100)];
  for (let i = 1; i <= 5; i++) events.push(ptr(10 + i * 12, 10 + i * 5, 100 + i * 150));
  const acts = actionsFromEvents(events, frames(), opts());
  const tr = acts.find((a) => a.k === "travel");
  assert.ok(tr, "expected a travel action");
});

test("held-button movement is a drag, not travel", () => {
  const acts = actionsFromEvents([
    win, ptr(0, 0, 0), btn(true, 10), ptr(30, 10, 100),
    ptr(90, 40, 300), ptr(150, 60, 500), btn(false, 900),
  ], frames(), opts());
  assert.equal(acts.filter((a) => a.k === "drag").length, 1);
  assert.equal(acts.filter((a) => a.k === "travel").length, 0);
});

test("interleaved input keeps every action and its event-time window", () => {
  const other: Event = { t: 1000, k: "win", cls: "terminal", title: "Shell", rect: [0, 0, 80, 80] };
  const events: Event[] = [
    win, ptr(50, 50, 100), btn(true, 200),
    { t: 220, k: "wheel", dx: 0, dy: 1 },
    { t: 230, k: "key", cls: "char", down: true },
    btn(false, 250),
    { t: 300, k: "wheel", dx: 0, dy: 2 },
    { t: 350, k: "key", cls: "char", down: true },
    other, { t: 1100, k: "wheel", dx: 0, dy: 3 },
    { t: 1200, k: "key", cls: "char", down: true },
  ];
  const acts = actionsFromEvents(events, frames(), opts());
  assert.deepEqual(acts.filter((a) => a.k === "scroll").map((a) => [a.dy, a.window_cls]), [[3, "chromium"], [3, "terminal"]]);
  assert.deepEqual(acts.filter((a) => a.k === "type").map((a) => [a.t0, a.t1, a.window_cls]), [[230, 350, "chromium"], [1200, 1200, "terminal"]]);
  assert.equal(acts.find((a) => a.k === "click")?.window_cls, "chromium");
});

test("dwell does not span a completed button hold", () => {
  const acts = actionsFromEvents([win, ptr(50, 50, 0), btn(true, 200), btn(false, 700), ptr(50, 50, 1000)], frames(), opts());
  assert.equal(acts.filter((a) => a.k === "dwell").length, 0);
});

test("dwell and travel retain their event-time window", () => {
  const events: Event[] = [
    win, ptr(50, 50, 0), ptr(50, 50, 1000),
    { t: 2100, k: "win", cls: "terminal", title: "Shell", rect: [0, 0, 100, 100] },
    ptr(10, 10, 2200), ptr(150, 110, 2500),
  ];
  const acts = actionsFromEvents(events, frames(), opts());
  const dwell = acts.find((a): a is Extract<Action, { k: "dwell" }> => a.k === "dwell");
  const travel = acts.find((a): a is Extract<Action, { k: "travel" }> => a.k === "travel" && a.t0 >= 2100);
  assert.equal(dwell?.window_cls, "chromium");
  assert.equal(travel?.window_cls, "terminal");
});

test("pointer dwell and travel stop at a window transition without another pointer sample", () => {
  const next: Event = { t: 500, k: "win", cls: "terminal", title: "Shell", rect: [0, 0, 100, 100] };
  const stationary = actionsFromEvents([win, ptr(50, 50, 0), next, ptr(50, 50, 1000)], frames(), opts());
  assert.equal(stationary.filter((a) => a.k === "dwell").length, 0);
  const moving = actionsFromEvents([win, ptr(10, 10, 0), ptr(20, 10, 400), next, ptr(80, 10, 800), ptr(140, 10, 1000)], frames(), opts());
  assert.ok(moving.filter((a) => a.k === "travel").every((a) => a.t1 <= 500 || a.t0 >= 500));
});

test("pointer loss keeps earlier clicks but never reuses stale coordinates", () => {
  const changed: FrameRegions[] = [
    { t: 500, changed_frac: 0.05, cut: false, regions: [{ bbox: [80, 40, 40, 40], area_frac: 0.06 }] },
  ];
  const acts = actionsFromEvents([
    win, ptr(20, 30, 100), btn(true, 200), btn(false, 250),
    { t: 300, k: "ptr-lost" }, { t: 300, k: "win", cls: "", title: "", rect: null },
    btn(true, 500), btn(false, 550), { t: 600, k: "wheel", dx: 0, dy: 1 },
  ], changed, { stream: STREAM, pointer: "none" });
  const clicks = acts.filter((a) => a.k === "click");
  assert.deepEqual(clicks.map((click) => [click.x, click.y]), [[20, 30], [100, 60]]);
  assert.deepEqual(acts.filter((a) => a.k === "scroll").map((scroll) => [scroll.x, scroll.y]), [[0, 0]]);
});

test("a drag crossing pointer loss has no fabricated end position", () => {
  const acts = actionsFromEvents([
    win, ptr(20, 30, 100), btn(true, 200),
    { t: 300, k: "ptr-lost" }, { t: 300, k: "win", cls: "", title: "", rect: null },
    btn(false, 900),
  ], frames(), { stream: STREAM, pointer: "none" });
  assert.equal(acts.some((action) => action.k === "drag" || action.k === "click"), false);
});

test("pointer none mode: click position falls back to the change region centroid", () => {
  const framesWithRegions: FrameRegions[] = [
    ...noopFrames(4, 0, 100),
    { t: 500, changed_frac: 0.05, cut: false, regions: [{ bbox: [80, 40, 40, 40] as [number, number, number, number], area_frac: 0.06 }] },
    ...noopFrames(10, 600, 100),
  ];
  const acts = actionsFromEvents(
    [win, btn(true, 500), btn(false, 550)],
    framesWithRegions,
    { stream: STREAM, pointer: "none" },
  );
  const clicks = acts.filter((a) => a.k === "click");
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0]!.x, 100); // centroid of [80,40,40,40]
  assert.equal(clicks[0]!.y, 60);
});
