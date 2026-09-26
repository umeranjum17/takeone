import test from "node:test";
import assert from "node:assert/strict";
import { actionsFromEvents } from "../src/perceive/actions.ts";
import type { Event, FrameRegions } from "../src/types.ts";
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

test("click: down/up within 300 ms and 6 px", () => {
  const acts = actionsFromEvents([win, ptr(10, 10, 400), btn(true, 500), btn(false, 560), ptr(12, 12, 560)], frames(), opts());
  const clicks = acts.filter((a) => a.k === "click");
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0]!.x, 10);
  assert.equal(clicks[0]!.y, 10);
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

test("travel: path over 25% of the diagonal within 1 s, no click", () => {
  // diagonal ~200; 25% = 50 px of path
  const events: Event[] = [win, ptr(10, 10, 100)];
  for (let i = 1; i <= 5; i++) events.push(ptr(10 + i * 12, 10 + i * 5, 100 + i * 150));
  const acts = actionsFromEvents(events, frames(), opts());
  const tr = acts.find((a) => a.k === "travel");
  assert.ok(tr, "expected a travel action");
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
