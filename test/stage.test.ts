import assert from "node:assert/strict";
import test from "node:test";
import { applyOverrides, DEFAULTS } from "../src/camera/defaults.ts";
import type { Beat } from "../src/camera/types.ts";
import { idleSqueezes, setptsExpr, warp } from "../src/render/pace.ts";
import { takeCaptions } from "../src/render/stage.ts";

const clickAt = (t: number): Beat => ({
  id: `b${t}`, t0: t, t1: t + 0.5, anchor_t: t, zones: [], actions: [{ k: "click", t: t * 1000, x: 10, y: 10 }],
} as unknown as Beat);

test("idle gaps squeeze and the setpts expression matches warp", () => {
  const squeezes = idleSqueezes([clickAt(1), clickAt(9)], 0, 12, DEFAULTS);
  // 1 s kept around each click; the 6 s gap between plays at idle_speed.
  assert.deepEqual(squeezes, [{ a: 2, b: 8 }, { a: 10, b: 12 }]);
  assert.equal(warp(5, squeezes, 4), 2 + 3 / 4);
  const expr = setptsExpr(squeezes, 4).replace(/\/TB$/, "");
  for (const t of [0, 1.5, 5, 9, 11, 12]) {
    const value = Function("clip", "T", `return ${expr}`)(
      (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x)), t) as number;
    assert.ok(Math.abs(value - warp(t, squeezes, 4)) < 1e-3, `t=${t}`);
  }
  assert.deepEqual(idleSqueezes([clickAt(1)], 0, 12, { ...DEFAULTS, idle_speed: 1 }), []);
});

test("captions are sanitised, clamped and keep their on-screen duration", () => {
  const captions = takeCaptions({
    width: 1920, height: 1080, title: "Hi {\\b1}there",
    captions: [{ t: 10, text: "a\\N{b}" }, { t: 40, text: "late" }, { t: 5, text: "  " }],
  }, (t) => t / 2, 12);
  assert.deepEqual(captions.map((c) => c.text), ["Hi b1there", "aNb"]);
  assert.deepEqual([captions[1]!.t0, captions[1]!.t1], [5, 8]);
});

test("look overrides validate colours, fonts and ranges", () => {
  assert.equal(applyOverrides({ accent: "#ff0000", caption_font: "Noto Sans" }).accent, "#ff0000");
  for (const bad of [{ accent: "red" }, { caption_font: "x}{\\" }, { idle_speed: 0.5 }, { shadow: 2 }, { stage_margin: 0.3 }]) {
    assert.throws(() => applyOverrides(bad), /invalid --set/);
  }
});
