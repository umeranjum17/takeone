import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { planStory, storyBeats } from "../src/motion/story.ts";
import { storySettle, validateStoryboard } from "../src/motion/storyboard.ts";

const BRIEF = [
  "chips: Plan the watch / the way you'd say it. | Who has the 0400?; Swap Ines and Kofi; Galley duty, Tuesday",
  "phone[Crew chat]: Ask it plainly. / Get the crew plan. | Who can take the 0400?; Ines and Kofi are rested.",
  "cards: The papers / write themselves. | Watch bill; Duty roster",
  "stats: Less juggling. / More rest. | 9 crew; 0 clashes",
].join("\n");
const BRAND = resolve("resources/demo/tidewater-brand.json");

test("story recipe plans a plain brief into a valid screenshot-free film that alternates dark and light", () => {
  const sb = validateStoryboard(planStory({ pitch: BRIEF, logo: "Tidewater", brand: BRAND, url: "tidewater.example" }, "story-test"));
  assert.deepEqual(sb.scenes.map(s => s.kind ?? s.pattern), ["chips", "phone", "cards", "stats", "end-card"]);
  assert.deepEqual(sb.scenes.map(s => !!s.invert), [false, true, false, true, false]);
  assert.equal(sb.scenes[1]!.label, "Crew chat");
  assert.equal(sb.scenes[1]!.text, "Tidewater", "the phone's assistant carries the brand name");
  assert.deepEqual(sb.scenes[0]!.subtitle, "the way you'd say it.");
  assert.equal(Object.keys(sb.screens).length, 0, "no screenshot is needed");
  for (const s of sb.scenes) assert.ok(Math.abs(s.d * 60 - Math.round(s.d * 60)) < 1e-6, "every length is a whole frame");
  for (const s of sb.scenes.slice(0, 4)) assert.ok(s.d >= storySettle(s) + .8 - 1e-9, "the product settles, then holds");
});

test("story beats retime onto a reference film's beats without cutting a beat under its floor", () => {
  const plain = planStory({ pitch: BRIEF, logo: "T" }, "a") as { scenes: { d: number }[] };
  const beats = [5.1, 10.2];
  const cut = planStory({ pitch: BRIEF, logo: "T", beats }, "b") as { scenes: { d: number }[] };
  assert.ok(cut.scenes.every((s, i) => s.d >= plain.scenes[i]!.d - 1e-9));
  assert.ok(Math.abs(cut.scenes[0]!.d + cut.scenes[1]!.d - 5.1) < 1 / 60 || cut.scenes[0]!.d >= 5.1 - 1 / 60, "a beat lands on the reference cut");
});

test("story recipe names what a bad brief is missing", () => {
  assert.throws(() => planStory({ logo: "T" }, "x"), /needs the brief/);
  assert.throws(() => planStory({ pitch: BRIEF }, "x"), /needs the brief/);
  assert.throws(() => storyBeats("poster: A / B | one", "T"), /must read/);
  assert.throws(() => planStory({ pitch: "chips: A / B | one; two", logo: "T" }, "x"), /2 to 5 beats/);
  assert.throws(() => validateStoryboard(planStory({ pitch: "chips: A / B | one; two\ncards: C / D | e; f", logo: "T" }, "x")), /chips needs a title and 3 to 8 tree rows/);
});
