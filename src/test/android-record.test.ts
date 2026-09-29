import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTouchDevices, parseWmDensity, parseWmSize } from "../android/record.js";

const PHONE_LP = `add device 1: /dev/input/event6
  name:     "touchpanel"
  events:
    ABS (0003): ABS_MT_POSITION_X     : value 0, min 0, max 23040, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 50688, fuzz 0, flat 0, resolution 0
  input props:
    INPUT_PROP_DIRECT
add device 2: /dev/input/event1
  name:     "gpio-keys"
  input props:
    <none>
`;

const EMULATOR_LP = `add device 3: /dev/input/event2
  name:     "virtio_input_multi_touch_1"
  events:
    ABS (0003): ABS_MT_POSITION_X     : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0
  input props:
    <none>
add device 4: /dev/input/event3
  name:     "virtio_input_multi_touch_2"
  events:
    ABS (0003): ABS_MT_POSITION_X     : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0
  input props:
    <none>
`;

test("touch selection prefers INPUT_PROP_DIRECT, else merges MT ranges", () => {
  assert.deepEqual(parseTouchDevices(PHONE_LP), { axisMaxX: 23040, axisMaxY: 50688 });
  assert.deepEqual(parseTouchDevices(EMULATOR_LP), { axisMaxX: 32767, axisMaxY: 32767 });
  assert.equal(parseTouchDevices("add device 1: /dev/input/event1\n  input props:\n    <none>\n"), null);
});

test("wm size and effective density parse", () => {
  assert.deepEqual(parseWmSize("Physical size: 1080x2400\n"), { w: 1080, h: 2400 });
  assert.equal(parseWmSize("nope"), null);
  assert.equal(parseWmDensity("Physical density: 420\n"), 420);
  assert.equal(parseWmDensity("Physical density: 640\nOverride density: 480\n"), 480);
});
