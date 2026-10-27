import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { screenLines } from "../src/decide/ocr.ts";
import { bentoStoryboard } from "../src/motion/bento.ts";
import { candidateLines, editorialStoryboard, LENS_TEXT, screenGrey } from "../src/motion/editorial.ts";
import { buildHyperframesProject } from "../src/motion/hyperframes.ts";
import { ingest } from "../src/motion/ingest.ts";
import { writePage } from "../src/motion/motion.ts";
import { withPage } from "../src/motion/render.ts";
import { validateStoryboard } from "../src/motion/storyboard.ts";

const BOARD = resolve("resources/demo/tidewater-board.png");

test("editorial recipe lays a model's answer on the real demo board into a valid HyperFrames film", async () => {
  const lines = candidateLines(await screenLines(BOARD), 1440);
  const id = (text: string) => { const l = lines.find(x => x.text.includes(text)); assert.ok(l, `OCR reads ${text}`); return l.id; };
  // A recorded model answer, keyed by what the lines say so it survives OCR order.
  const answer = {
    logo: "Tidewater", lead: "Your launch, finally", swaps: ["scattered", "shipped."],
    phone_line: "Every task, in reach.", phone_open: id("In progress"), tap: id("Beta feedback"), toast: "Task opened",
    chips_line: "One board for the launch.", chips: [id("Write release notes"), id("Beta feedback"), id("Record onboarding"), id("Fix export")],
    payoff: "Ship the launch together.", cta: "Start free",
  };
  const size = { width: 2560, height: 1440 };
  // A tapped line too long for the phone's lens at reading size goes back to the model.
  assert.throws(() => editorialStoryboard({ inputs: [BOARD] }, "editorial-test", size, lines, { ...answer, tap: id("commented on") }),
    /^Error: editorial planner: tap names a line too long to read in the phone's lens .*rerun to ask again$/);
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

test("editorial film on the real demo board: whole phone, readable lens, a stack that fills the frame, one warm accent", { timeout: 120_000 }, async () => {
  const lines = candidateLines(await screenLines(BOARD), 1440);
  const id = (text: string) => lines.find(x => x.text.includes(text))!.id;
  const answer = {
    logo: "Tidewater", lead: "Your launch, finally", swaps: ["scattered", "shipped."],
    phone_line: "Every task, in reach.", phone_open: id("Todo"), tap: id("Write release notes"), toast: "Task opened",
    chips_line: "One board for the launch.", chips: [id("Write release notes"), id("Beta feedback"), id("Record onboarding"), id("Fix export")],
    payoff: "Ship the launch together.", cta: "Start free",
  };
  const size = { width: 2560, height: 1440 };
  const sb = validateStoryboard(editorialStoryboard({ inputs: [BOARD] }, "editorial-gates", size, lines, answer, screenGrey(BOARD, size)));
  const [, phone, stack] = sb.scenes;
  const dir = mkdtempSync(join(tmpdir(), "takeone-editorial-gates-"));
  try {
    await ingest(dir, sb);
    const end = sb.scenes.at(-1)!.at! + sb.scenes.at(-1)!.d;
    const m = await withPage(writePage(dir, sb).html, 1920, 1080, async b => b.evaluate<{ safe: unknown[]; lens: number; chips: number; accent: string[] }>(`(() => {
      const safe = []; for (let t = 0; t < ${end}; t += 1 / 30) safe.push(...__safe(t * 1000).map(x => ({ t, ...x })));
      const rect = (el) => el.getBoundingClientRect();
      // Every accent mark the film draws, by scene: a border, fill or glow in the warm colour.
      const marks = (i) => [...document.querySelectorAll('.layer[data-scene="' + i + '"] *')].map(el => getComputedStyle(el))
        .flatMap(cs => [cs.backgroundColor, cs.borderTopColor, cs.boxShadow]).join(" ");
      __seek(${(phone!.at! + phone!.d - 0.1) * 1000});
      const lens = rect(document.querySelector('.layer[data-scene="1"] [data-safe="lens"] img')).height;
      __seek(${(stack!.at! + stack!.d - 0.05) * 1000});
      const chips = [...document.querySelectorAll('.layer[data-scene="2"] img')].map(rect).reduce((n, r) => n + r.width * r.height, 0) / (innerWidth * innerHeight);
      return { safe, lens, chips, accent: [0, 1, 2].map(marks) };
    })()`));
    assert.deepEqual(m.safe, [], "the phone, the lens and every title stay inside the 5% inset on every frame, no word cut");
    const lensCrop = sb.crops!["lens"]!.rect, tapH = phone!.tap![3];
    assert.ok(m.lens * tapH / lensCrop[3] >= 1080 * LENS_TEXT - 0.5, `the tapped row reads at ${(m.lens * tapH / lensCrop[3]).toFixed(1)} px in the lens`);
    assert.ok(m.chips >= 0.12, `the chip stack covers ${(m.chips * 100).toFixed(1)}% of the frame`);
    // No warm colour on this board: the recipe's own warm accent marks the hook, the phone and the stack.
    for (const [i, marks] of m.accent.entries()) assert.match(marks, /rgb\(226, 82, 47\)/, `scene ${i} carries the warm accent`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bento recipe lays a model's answer on the real demo board into a valid reflowing HyperFrames reel", async () => {
  const lines = candidateLines(await screenLines(BOARD), 1440);
  const id = (text: string) => { const l = lines.find(x => x.text.includes(text)); assert.ok(l, `OCR reads ${text}`); return l.id; };
  const answer = {
    logo: "Tidewater", lead: "Launch together from", highlight: "one board", kpi_label: "tasks shipped", kpi_value: 1284,
    feed: ["Umer moved beta feedback", "Umer completed export task", "Umer assigned pricing page", "Umer created release notes"],
    shots: [id("Write release notes"), id("Beta feedback")], payoff: "Tasks, feedback, notes. Together.", cta: "Start free",
  };
  const sb = validateStoryboard(bentoStoryboard({ inputs: [BOARD], url: "tidewater.app" }, "bento-test", { width: 2560, height: 1440 }, lines, answer));
  assert.deepEqual(sb.scenes.map(s => s.pattern), ["bento-reel", "statement", "end-card"]);
  for (const s of sb.scenes) assert.equal((s.at! * 2) % 1, 0, `${s.pattern} cuts on the 120 BPM beat`);
  assert.equal(sb.planner.by, "ai");
  assert.deepEqual(sb.scenes[0]!.reel!.shots, ["shot1", "shot2"]);
  const bad = { ...answer, kpi_value: 12 };
  assert.throws(() => bentoStoryboard({ inputs: [BOARD] }, "x", { width: 2560, height: 1440 }, lines, bad), /bento planner: kpi_value/);
  const dir = mkdtempSync(join(tmpdir(), "takeone-bento-"));
  try {
    mkdirSync(join(dir, "sources"));
    const html = readFileSync(buildHyperframesProject(dir, sb).html, "utf8");
    assert.match(html, /PATTERNS\["bento-reel"\]/);
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
