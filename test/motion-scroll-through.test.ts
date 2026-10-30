import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function run(width: number, height: number, W: number, H: number) {
  let animate = (_ms: number) => {};
  let requested: [number, number] = [0, 0];
  let imageTransform = "";
  const ctx = vm.createContext({
    PATTERNS: {},
    h: () => ({ style: { cssText: "" } }),
    esc: (text: string) => text,
    tick: (fn: (_ms: number) => void) => { animate = fn; },
    smootherstep: (value: number) => Math.max(0, Math.min(1, value)),
    drift: () => ({ x: 0, y: 0 }),
    SMOOTH: "smooth",
    K: () => {},
    deviceFrame: (_scr: unknown, _device: string, w: number, h: number) => {
      requested = [w, h];
      const scale = Math.min(1, 1.5 / Math.max(w / width, h / height));
      const vw = w * scale, vh = h * scale * 0.925;
      const frame = { offsetWidth: vw + 4, offsetHeight: vh + 4, style: { cssText: "", transform: "" } };
      const viewport = { offsetWidth: vw, offsetHeight: vh };
      const img = { style: { set transform(value: string) { imageTransform = value; }, cssText: "" } };
      return { frame, viewport, img };
    },
  });
  vm.runInContext(readFileSync("resources/motion/patterns/scroll-through.js", "utf8"), ctx);
  const layer = { append: () => {} };
  const scene = { screen: "screen", device: "browser", d: 6 };
  const context = { W, H, screen: () => ({ width, height, url: "screen.png" }) };
  vm.runInContext("PATTERNS['scroll-through']", ctx)(layer, scene, context);
  animate(6000);
  return { requested, imageTransform };
}

test("scroll-through keeps long-axis overflow for landscape output and portrait A7", () => {
  const landscape = run(2560, 1440, 1920, 1080);
  assert.ok(landscape.imageTransform.startsWith("translate(-"), landscape.imageTransform);
  assert.match(landscape.imageTransform, /px,0\.000px\)$/);

  const portraitA7 = run(2560, 1440, 1080, 1920);
  assert.deepEqual(portraitA7.requested, [1080 * 0.88, Math.min(1920 * 0.7, 1920 * 0.8)]);
  assert.ok(portraitA7.imageTransform.startsWith("translate(-"), portraitA7.imageTransform);
  assert.match(portraitA7.imageTransform, /px,0\.000px\)$/);
});
