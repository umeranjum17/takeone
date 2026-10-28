import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { screenLines } from "../src/decide/ocr.ts";
import { candidateLines, editorialStoryboard, screenGrey } from "../src/motion/editorial.ts";
import { MAX_GROWTH_STEPS, repairStoryboard, type Finding } from "../src/motion/gauntlet.ts";
import { validateStoryboard } from "../src/motion/storyboard.ts";

const BOARD = resolve("resources/demo/tidewater-board.png");

async function editorialFilm() {
  const lines = candidateLines(await screenLines(BOARD), 1440);
  const id = (text: string) => lines.find(x => x.text.includes(text))!.id;
  const answer = {
    logo: "Tidewater", lead: "Your launch, finally", swaps: ["scattered", "shipped."],
    phone_line: "Every task, in reach.", phone_open: id("Activity"), tap: id("Beta feedback"), toast: "Reply sent",
    chips_line: "One board for the launch.", chips: [id("Write release notes"), id("Beta feedback"), id("Record onboarding"), id("Fix export")],
    payoff: "Ship the launch together.", cta: "Start free",
  };
  const size = { width: 2560, height: 1440 };
  return validateStoryboard(editorialStoryboard({ inputs: [BOARD], url: "tidewater.app" }, "gauntlet-test", size, lines, answer, screenGrey(BOARD, size)));
}

const finding = (scene: number, criterion: Finding["criterion"], score: number): Finding => ({ id: `s${scene}-${criterion}`, scene, pattern: "x", criterion, score, note: "" });

test("gauntlet repairs move one beat on the scene that fell short and keep every later cut on the grid", async () => {
  const sb = await editorialFilm();
  const [swap, , , canon, statement] = sb.scenes;
  assert.equal(canon!.pattern, "canon");
  const { storyboard, repairs } = repairStoryboard(sb, sb, [finding(1, "read", 5), finding(4, "drag", 4), finding(5, "read", 9)], 8);
  assert.deepEqual(repairs.map(r => r.scene), [1, 4]);
  assert.equal(storyboard.scenes[0]!.d, swap!.d + 0.5);
  assert.equal(storyboard.scenes[3]!.d, canon!.d - 0.5);
  assert.equal(storyboard.scenes[4]!.d, statement!.d, "a scene that met the bar is untouched");
  assert.equal(storyboard.scenes[4]!.at, statement!.at, "the growth before it and the cut cancel");
  for (const s of storyboard.scenes) assert.equal((s.at! * 2) % 1, 0, `${s.pattern} still cuts on the 120 BPM beat`);
  // The canon replays the same earlier moments after scene 1 grew: each tile offset follows the footage it reads.
  assert.deepEqual(storyboard.scenes[3]!.offsets, canon!.offsets!.map(o => (o < sb.scenes[1]!.at! ? o : o + 0.5)));
});

test("gauntlet repairs are bounded: growth stops at two beats over the first plan and a short scene is never cut under its reading floor", async () => {
  const sb = await editorialFilm();
  let now = sb;
  for (let round = 0; round < 6; round++) now = repairStoryboard(now, sb, [finding(1, "read", 2)], 8).storyboard;
  assert.equal(now.scenes[0]!.d, sb.scenes[0]!.d + MAX_GROWTH_STEPS * 0.5);
  const floor = repairStoryboard(sb, sb, sb.scenes.map((_, i) => finding(i + 1, "drag", 1)), 8);
  floor.storyboard.scenes.forEach(s => assert.ok(s.d >= 1));
  assert.ok(validateStoryboard(floor.storyboard));
});

test("takeone gauntlet with no signed-in judge stops with the sign-in line before rendering or writing a ledger", async () => {
  const home = mkdtempSync(join(tmpdir(), "takeone-gauntlet-nojudge-"));
  try {
    const dir = join(home, "film");
    mkdirSync(dir);
    writeFileSync(join(dir, "storyboard.json"), JSON.stringify(await editorialFilm()));
    writeFileSync(join(dir, "take.json"), JSON.stringify({ id: "film", theme: "editorial", motion: { pattern: "x", storyboard: "storyboard.json" } }));
    const r = spawnSync(process.execPath, [resolve("bin/takeone.mjs"), "gauntlet", dir], {
      encoding: "utf8", timeout: 60_000,
      env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), TMPDIR: home, PATH: dirname(process.execPath), TAKEONE_NO_KEYRING: "1" },
    });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /score judge: unavailable/);
    assert.ok(!existsSync(join(dir, "gauntlet.jsonl")) && !existsSync(join(dir, "out")), "nothing rendered, nothing logged");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
