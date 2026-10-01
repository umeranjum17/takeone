import assert from "node:assert/strict";
import test from "node:test";
import { renderDimensions } from "../src/cli.ts";

test("render aspect and 4k sizing preserve each requested aspect", () => {
  assert.deepEqual(renderDimensions("square", "4k"), { out_w: 3840, out_h: 3840 });
  assert.deepEqual(renderDimensions("portrait", "4k"), { out_w: 2160, out_h: 3840 });
  assert.deepEqual(renderDimensions("landscape", "4k"), { out_w: 3840, out_h: 2160 });
  assert.deepEqual(renderDimensions(undefined, "4k", true), { out_w: 2160, out_h: 3840 });
  assert.throws(() => renderDimensions("square", "8k"), /unknown resolution/);
  assert.throws(() => renderDimensions("vertical"), /unknown aspect/);
});
