import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, applyOverrides } from "../src/camera/defaults.ts";
import { deviceFrame } from "../src/render/stage.ts";

test("frame token: auto keeps the handset for phone takes only; browser and laptop are opt-in", () => {
  assert.equal(DEFAULTS.frame, "auto");
  assert.equal(deviceFrame("auto", true), "phone");
  assert.equal(deviceFrame("auto", false), null);
  assert.equal(deviceFrame("none", true), null);
  assert.equal(deviceFrame("browser", false), "browser");
  assert.equal(applyOverrides({ frame: "laptop" }).frame, "laptop");
  assert.throws(() => applyOverrides({ frame: "tablet" }), /invalid --set frame/);
});
