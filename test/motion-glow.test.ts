import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { deckCards, glowStoryboard, pressBox, treeRows } from "../src/motion/glow.ts";
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

test("glow --region cards add a deck beat of square real-screen crops after the tree", async () => {
  const size = imageSize(BOARD), tap = await pressBox(BOARD, "1,2,3,4");
  const regions = ["316,120,520,520:Plan the launch.", "868,120,520,520:Track every task.", "1984,128,544,600:See what moved."];
  const sb = validateStoryboard(glowStoryboard({ inputs: [BOARD], title: "Meet the crew", pitch: "Plan the launch", logo: "Tidewater", tree: "Crew,>Chief,>Scout", regions },
    "glow-deck-test", [size], tap));
  assert.deepEqual(sb.scenes.map(s => s.pattern), ["glow-prompt", "glow-hero", "glow-tree", "glow-deck", "glow-screen", "glow-screen", "end-card"]);
  assert.deepEqual(sb.scenes[3]!.cards, [{ screen: "deck1", caption: "Plan the launch." }, { screen: "deck2", caption: "Track every task." }, { screen: "deck3", caption: "See what moved." }]);
  assert.ok(Math.abs(sb.scenes[3]!.d - (0.25 * 3 + 0.25)) < 1 / 60, `deck is ${sb.scenes[3]!.d} s`);
  assert.ok(filmDuration(sb) <= 10, `three-card glow promo is ${filmDuration(sb)} s`);
  // Each card is a square that holds its region whole and stays on the screen; the tall one grows across, not down.
  for (const [i, c] of regions.entries()) {
    const [x, y, w, h] = c.split(":")[0]!.split(",").map(Number) as [number, number, number, number], r = sb.crops![`deck${i + 1}`]!.rect;
    assert.equal(r[2], r[3]);
    assert.ok(r[0] <= x && r[1] <= y && r[0] + r[2] >= x + w && r[1] + r[3] >= y + h && r[0] + r[2] <= size.width && r[1] + r[3] <= size.height, `deck${i + 1} ${r}`);
  }
  assert.deepEqual(deckCards([`${size.width - 400},${size.height - 400},400,400:Edge`, "0,0,10,10:Corner"], size.width, size.height).map(c => c.rect), [[size.width - 400, size.height - 400, 400, 400], [0, 0, 10, 10]]);
  for (const invalid of ["9000,100,200,200:Outside", "0,0,0,10:Zero width", "0,0,10,0:Zero height", "0,0,4000,10:Too wide"]) {
    assert.throws(() => deckCards([invalid, "1,2,3,4:Valid"], size.width, size.height), /positive dimensions and fit inside the screen/);
  }
  assert.throws(() => deckCards(["1,2,3,4:Only one"], size.width, size.height), /2 to 5 --region cards/);
  assert.throws(() => deckCards(["1,2,3,4", "5,6,7,8:B"], size.width, size.height), /x,y,w,h:Caption/);
  assert.throws(() => validateStoryboard({ ...(sb as object), scenes: [{ pattern: "glow-deck", d: 2, cards: [{ screen: "nope", caption: "A" }, { screen: "deck1", caption: "B" }] }] }), /not one of crops/);
});
