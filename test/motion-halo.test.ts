import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { planHalo } from "../src/motion/halo.ts";
import { frozenAllowList } from "../src/motion/gates.ts";
import { ingest } from "../src/motion/ingest.ts";
import { writePage } from "../src/motion/motion.ts";
import { withPage } from "../src/motion/render.ts";
import { HALO_TYPE_LAG, HALO_TYPE_STEP, haloLineHolds, readingFloor, validateStoryboard } from "../src/motion/storyboard.ts";

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

test("halo kinetic lines read together: light lead-ins, a heavy last line that types on, and a shorter scene", () => {
  const sb = validateStoryboard(planHalo({ inputs: [BOARD], regions, pitch: "Your crew. No chatbot. Asks first." }, "halo-lines-clock"));
  const lines = sb.scenes.find(s => s.pattern === "halo-lines")!;
  // The old model gave each line its own slot (2 x 1.92 s); one lockup overlaps the reads.
  assert.ok(lines.d < 2.6, `kinetic lines last ${lines.d} s`);
  const holds = haloLineHolds(lines);
  assert.deepEqual(holds.map(h => h.text), ["No chatbot.", "Asks first."]);
  assert.ok(Math.abs(holds[1]!.reveal - (HALO_TYPE_LAG + HALO_TYPE_STEP * "Asks first.".length)) < 1e-9, "the last line is read once its last glyph has typed on");
  for (const { text, reveal } of holds) assert.ok(reveal + readingFloor(text) <= lines.d + 1e-9, `${text} is read before the scene ends`);
  assert.equal(sb.theme.overrides["caption_font"], "Geist", "midnight's one face gets a light partner for the lead-in");
  const paper = planHalo({ inputs: [BOARD], regions, pitch: "Your crew. No chatbot. Asks first.", theme: "paper" }, "halo-lines-paper") as { theme: { overrides: object } };
  assert.deepEqual(paper.theme.overrides, {}, "a theme with two faces keeps its own");
});

test("halo kinetic lines reject blank text in every position", () => {
  const valid = planHalo({ inputs: [BOARD], regions, pitch: "Your crew. No chatbot. Asks first." }, "halo-lines-blank") as { scenes: { pattern: string; lines?: string[] }[] };
  const scene = valid.scenes.find(s => s.pattern === "halo-lines")!;
  for (const index of [0, scene.lines!.length - 1]) for (const text of ["", "   "]) {
    scene.lines![index] = text;
    assert.throws(() => validateStoryboard(valid), /\.lines\[\d+\]: expected non-empty text/);
    scene.lines![index] = index === 0 ? "No chatbot." : "Asks first.";
  }
});

test("halo kinetic lines type the last line on a frame at a time, never a bare caret, over a static grain", { timeout: 120_000 }, async () => {
  const sb = validateStoryboard(planHalo({ inputs: [BOARD], regions, pitch: "Your crew. No chatbot. Asks first." }, "halo-lines-page"));
  const dir = mkdtempSync(join(tmpdir(), "takeone-halo-lines-"));
  try {
    await ingest(dir, sb);
    await withPage(writePage(dir, sb).html, 1920, 1080, async (b) => {
      const [start, d] = await b.evaluate<[number, number]>(`(()=>{const l=document.querySelector('[data-pattern="halo-lines"]');return [Number(l.dataset.start),Number(l.dataset.duration)];})()`);
      const out = await b.evaluate<{ frames: { local: number; shown: boolean; typed: string; caret: number }[]; lead: [string, number]; pay: [string, number]; grain: { blend: string; moves: number } }>(`(()=>{
        const layer=document.querySelector('[data-pattern="halo-lines"]'),pay=layer.querySelector('.halo-typed').closest('[data-safe]'),lead=[...layer.querySelectorAll('[data-safe]')].find(e=>e.textContent==="No chatbot.");
        const grain=[...layer.querySelectorAll('canvas')].find(c=>getComputedStyle(c).mixBlendMode==="overlay"),frames=[];
        for(let f=0;f<Math.round(${d}*60);f++){const local=f*1000/60;window.__apply(${start}*1000+local);
          frames.push({local,shown:getComputedStyle(pay).visibility==="visible",typed:pay.querySelector('.halo-typed').textContent,caret:Number(getComputedStyle(pay.querySelector('i')).opacity)});}
        const face=e=>[getComputedStyle(e).fontFamily,parseFloat(getComputedStyle(e).fontSize)];
        return {frames,lead:face(lead),pay:face(pay),grain:{blend:getComputedStyle(grain).mixBlendMode,moves:grain.getAnimations().length}};
      })()`);
      assert.notEqual(out.lead[0], out.pay[0], "lead-in and last line are set in different faces");
      assert.ok(out.pay[1] > 4 * out.lead[1], `last line ${out.pay[1]} px is far bigger than the lead-in ${out.lead[1]} px`);
      assert.deepEqual(out.grain, { blend: "overlay", moves: 0 }, "the grain lies still, so it cannot pass for motion");
      const typeAt = HALO_TYPE_LAG * 1000;
      let prev = 0;
      for (const { local, shown, typed, caret } of out.frames) {
        assert.equal(shown, local >= typeAt - 1e-6, `${local.toFixed(1)} ms: last line visibility`);
        if (!shown) continue;
        assert.ok(typed.length >= 1 && "Asks first.".startsWith(typed) && typed.length >= prev, `${local.toFixed(1)} ms: typed ${JSON.stringify(typed)}`);
        assert.equal(typed.length, Math.min(11, Math.floor((local - typeAt + 1e-6) / 50) + 1), `${local.toFixed(1)} ms: one glyph every 50 ms`);
        prev = typed.length;
      }
      assert.equal(out.frames.at(-1)!.typed, "Asks first.");
      assert.equal(out.frames.at(-1)!.caret, 0, "the caret has gone by the scene's end");
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
