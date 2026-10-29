import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, applyOverrides } from "../src/camera/defaults.ts";
import { deviceFrame, stageGeometry, stageImageFilter } from "../src/render/stage.ts";

test("frame token: auto keeps the handset for phone takes only; browser and laptop are opt-in", () => {
  assert.equal(DEFAULTS.frame, "auto");
  assert.equal(deviceFrame("auto", true), "phone");
  assert.equal(deviceFrame("auto", false), null);
  assert.equal(deviceFrame("none", true), null);
  assert.equal(deviceFrame("browser", false), "browser");
  assert.equal(applyOverrides({ frame: "laptop" }).frame, "laptop");
  assert.throws(() => applyOverrides({ frame: "tablet" }), /invalid --set frame/);
});

test("browser and laptop chrome are drawn behind the card; no frame leaves the graph unchanged", () => {
  const d = applyOverrides({ stage_margin: 0.14 });
  const st = stageGeometry(1920, 1080, d);
  const plain = stageImageFilter(1920, 1080, st, d);
  assert.ok(!plain.includes("[framed]"));
  const browser = stageImageFilter(1920, 1080, st, d, "browser"), laptop = stageImageFilter(1920, 1080, st, d, "laptop");
  assert.ok(browser.includes("0xff5f57") && browser.includes("[framed]format=rgb24"));
  assert.ok(laptop.includes("0xc4c8cf") && laptop.includes("[framed]format=rgb24"));
});
