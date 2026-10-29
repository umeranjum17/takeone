import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { planHalo } from "../src/motion/halo.ts";
import { frozenAllowList } from "../src/motion/gates.ts";
import { readingFloor, validateStoryboard } from "../src/motion/storyboard.ts";

const BOARD = resolve("resources/demo/tidewater-board.png");
const regions = ["0,0,400,300:logo@S1", "100,100,600,300:stack:Ask@S1", "100,500,600,300:stack@S1", "800,100,500,400:card@S1", "100,900,300,100:chips@S1", "500,900,300,100:chips@S1"];

test("halo recipe lays real screen pieces and a pitch into a valid local film, no planner", () => {
  const sb = validateStoryboard(planHalo({ inputs: [BOARD], regions, pitch: "Your crew. No chatbot. Asks first.", logo: "Tidewater" }, "halo-test"));
  assert.deepEqual(sb.scenes.map(s => s.pattern), ["halo-open", "halo-float", "halo-float", "halo-lines", "halo-end"]);
  assert.deepEqual(sb.scenes.map(s => s.kind ?? null), [null, "stack", "card", null, null]);
  assert.deepEqual(sb.scenes[3]!.lines, ["No chatbot.", "Asks first."]);
  assert.equal(sb.planner.by, "user");
  assert.equal(sb.scenes[1]!.items!.length, 2, "consecutive pieces of one kind are one beat");
  assert.equal(sb.scenes[2]!.items!.length, 3, "chips straight after a card ride on its corners");
  assert.equal(sb.scenes[3]!.items!.length, 4, "the kinetic lines keep four earlier pieces in view, one per beat first");
  assert.deepEqual(sb.scenes[3]!.items!.slice(0, 2), [sb.scenes[1]!.items![0], sb.scenes[2]!.items![0]]);
  for (const [i, s] of sb.scenes.entries()) if (i) assert.ok(s.at! >= sb.scenes[i - 1]!.at! + sb.scenes[i - 1]!.d - 1e-9, "beats do not overlap");
});

test("halo recipe stops on a missing logo, an off-screen piece and a pitch with no tagline", () => {
  assert.throws(() => planHalo({ inputs: [BOARD], regions: regions.slice(1), pitch: "A. B." }, "x"), /needs the logo as a piece/);
  assert.throws(() => planHalo({ inputs: [BOARD], regions: [regions[0]!], pitch: "A. B." }, "x"), /needs at least one non-logo UI piece/);
  assert.throws(() => planHalo({ inputs: [BOARD], regions: ["0,0,400,300:logo@S1", "5000,0,400,300:card@S1"], pitch: "A. B." }, "x"), /lies outside S1/);
  assert.throws(() => planHalo({ inputs: [BOARD], regions }, "x"), /needs --pitch/);
});

test("halo end scene reserves reading time after its credit appears", () => {
  const url = "Visit us today at example dot com";
  const sb = planHalo({ inputs: [BOARD], regions, pitch: "Your crew. No chatbot. Asks first.", url }, "halo-credit") as { scenes: { pattern: string; d: number }[] };
  const end = sb.scenes.find(s => s.pattern === "halo-end")!;
  assert.ok(end.d >= 1.5 + readingFloor(url));
});

test("halo end scene is treated as the designed final hold by the frozen-time gate", () => {
  const sb = validateStoryboard(planHalo({ inputs: [BOARD], regions, pitch: "Your crew." }, "halo-frozen"));
  const end = sb.scenes.find(s => s.pattern === "halo-end")!;
  assert.deepEqual(frozenAllowList(sb), [[end.at, end.at! + end.d]]);
});

test("halo recipe carries the selected theme into its storyboard", () => {
  const sb = planHalo({ inputs: [BOARD], regions, pitch: "Your crew.", theme: "paper" }, "halo-paper") as { theme: { name: string } };
  assert.equal(sb.theme.name, "paper");
});
