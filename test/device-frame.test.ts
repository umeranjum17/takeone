import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, applyOverrides } from "../src/camera/defaults.ts";
import { browserBar, deviceFrame, type Stage } from "../src/render/stage.ts";

test("frame token: auto keeps the handset for phone takes only; browser and laptop are opt-in", () => {
  assert.equal(DEFAULTS.frame, "auto");
  assert.equal(deviceFrame("auto", true), "phone");
  assert.equal(deviceFrame("auto", false), null);
  assert.equal(deviceFrame("none", true), null);
  assert.equal(deviceFrame("browser", false), "browser");
  assert.equal(applyOverrides({ frame: "laptop" }).frame, "laptop");
  assert.throws(() => applyOverrides({ frame: "tablet" }), /invalid --set frame/);
});

test("browser title bar is a whole number of stage px at any export size", () => {
  for (const restScale of [0.1875, 0.5, 1, 1.5]) assert.ok(Number.isInteger(browserBar({ restScale } as Stage)));
});
