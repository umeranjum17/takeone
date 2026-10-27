import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { screenLines } from "../src/decide/ocr.ts";
import { candidateLines, editorialStoryboard, screenGrey } from "../src/motion/editorial.ts";
import { buildHyperframesProject } from "../src/motion/hyperframes.ts";
import { validateStoryboard } from "../src/motion/storyboard.ts";

const BOARD = resolve("resources/demo/tidewater-board.png");

test("editorial recipe lays a model's answer on the real demo board into a valid HyperFrames film", async () => {
  const lines = candidateLines(await screenLines(BOARD), 1440);
  const id = (text: string) => { const l = lines.find(x => x.text.includes(text)); assert.ok(l, `OCR reads ${text}`); return l.id; };
  // A recorded model answer, keyed by what the lines say so it survives OCR order.
  const answer = {
    logo: "Tidewater", lead: "Your launch, finally", swaps: ["scattered", "shipped."],
    phone_line: "Every task, in reach.", phone_open: id("Activity"), tap: id("commented on"), toast: "Reply sent",
    chips_line: "One board for the launch.", chips: [id("Write release notes"), id("Beta feedback"), id("Record onboarding"), id("Fix export")],
    payoff: "Ship the launch together.", cta: "Start free",
  };
  const size = { width: 2560, height: 1440 };
  const raw = editorialStoryboard({ inputs: [BOARD], url: "tidewater.app" }, "editorial-test", size, lines, answer, screenGrey(BOARD, size));
  const sb = validateStoryboard(raw);
  assert.deepEqual(sb.scenes.map(s => s.pattern), ["word-swap", "phone-story", "chip-stack", "canon", "statement", "end-card"]);
  for (const s of sb.scenes) assert.equal((s.at! * 2) % 1, 0, `${s.pattern} cuts on the 120 BPM beat`);
  assert.equal(sb.theme.name, "editorial");
  assert.equal(sb.planner.by, "ai");
  assert.deepEqual(sb.scenes[2]!.chips, ["chip1", "chip2", "chip3", "chip4"]);
  const canon = sb.scenes[3]!;
  assert.ok(canon.offsets!.every(o => o < canon.at!), "canon tiles replay earlier beats");
  // Every chip crop holds its own line, and the phone crop holds the tapped row.
  const inside = (r: number[], b: number[]) => r[0]! <= b[0]! && r[1]! <= b[1]! && r[0]! + r[2]! >= b[0]! + b[2]! && r[1]! + r[3]! >= b[1]! + b[3]!;
  answer.chips.forEach((c, i) => assert.ok(inside(sb.crops![`chip${i + 1}`]!.rect, lines.find(l => l.id === c)!.box)));
  assert.ok(inside(sb.crops!["phone"]!.rect, sb.scenes[1]!.tap!));

  const dir = mkdtempSync(join(tmpdir(), "takeone-editorial-"));
  try {
    mkdirSync(join(dir, "sources"));
    const p = buildHyperframesProject(dir, sb);
    const html = readFileSync(p.html, "utf8");
    assert.equal(p.duration, sb.scenes.at(-1)!.at! + sb.scenes.at(-1)!.d);
    assert.match(html, /PATTERNS\["word-swap"\]/);
    assert.match(html, /PATTERNS\.canon/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editorial recipe with no signed-in engine stops with the sign-in line and plans nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "takeone-editorial-noengine-"));
  try {
    const out = join(home, "film");
    const r = spawnSync(process.execPath, [resolve("bin/takeone.mjs"), "motion", BOARD, "--recipe", "editorial", "--pitch", "A launch board for small teams.", "--out", out], {
      encoding: "utf8", timeout: 60_000,
      env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), TMPDIR: home, PATH: dirname(process.execPath), TAKEONE_NO_KEYRING: "1" },
    });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /takeone needs an AI engine.*Sign in with: claude/);
    assert.ok(!existsSync(join(out, "storyboard.json")), "no storyboard is written");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
