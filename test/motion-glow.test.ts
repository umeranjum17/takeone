import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { glowStoryboard, pressBox, treeRows } from "../src/motion/glow.ts";
import { imageSize } from "../src/motion/ingest.ts";
import { filmDuration, validateStoryboard } from "../src/motion/storyboard.ts";

const BOARD = resolve("resources/demo/tidewater-board.png");

test("glow recipe plans a 5-9 s promo on the real demo board, its click on a control found by OCR", async () => {
  const size = imageSize(BOARD), tap = await pressBox(BOARD, "Beta feedback");
  assert.ok(tap[2] > 20 && tap[0] + tap[2] <= size.width, "the OCR box sits on the board");
  assert.deepEqual(await pressBox(BOARD, "1,2,3,4"), [1, 2, 3, 4], "a given box is used as is");
  await assert.rejects(pressBox(BOARD, "No such button"), /pass its box as --press x,y,w,h/);
  const sb = validateStoryboard(glowStoryboard({ inputs: [BOARD], title: "Meet the crew", subtitle: "Ask. Done.", pitch: "Plan the launch", logo: "Tidewater", tree: "Crew,>Chief,>Scout" },
    "glow-test", [size], tap));
  assert.deepEqual(sb.scenes.map(s => s.pattern), ["glow-prompt", "glow-words", "glow-hero", "glow-tree", "glow-screen", "glow-screen", "end-card"]);
  assert.deepEqual(sb.scenes[3]!.tree, ["Crew", "  Chief", "  Scout"]);
  assert.ok(filmDuration(sb) >= 5 && filmDuration(sb) <= 9, `film is ${filmDuration(sb)} s`);
  assert.equal(sb.planner.by, "local");
  assert.deepEqual(treeRows("A,>B"), ["A", "  B"]);
});
