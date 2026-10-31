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

test("halo end card is a quiet lockup, not a second UI collage", () => {
  const sb = validateStoryboard(planHalo({ inputs: [BOARD], regions, pitch: "Your crew. No chatbot. Asks first." }, "halo-end-pieces"));
  const end = sb.scenes.at(-1)!, lines = sb.scenes.find(s => s.pattern === "halo-lines")!;
  assert.equal(end.pattern, "halo-end");
  assert.ok(lines.items!.length > 0, "the product remains present in the preceding beat");
  assert.equal(end.items?.length, undefined, "the closing card contains no floating UI pieces");
  assert.equal(end.items, undefined, "the closing card drops the floating UI pieces");
});

test("halo logo morphs into a pill before typing inline; the end card holds a smaller quiet lockup", { timeout: 120_000 }, async () => {
  const sb = validateStoryboard(planHalo({ inputs: [BOARD], regions, pitch: "Your crew. No chatbot. Asks first.", url: "A film made with TakeOne from real Crewhouse screens" }, "halo-logo-end-motion"));
  const dir = mkdtempSync(join(tmpdir(), "takeone-halo-logo-end-"));
  try {
    await ingest(dir, sb);
    await withPage(writePage(dir, sb).html, 1920, 1080, async (b) => {
      const result = await b.evaluate<{ typed: { shown: boolean; text: string }[]; pill: { width: number; height: number; radius: string; shadow: string }[]; end: { pieces: number; wordSize: number; animations: number; credit: string } }>(`(()=>{
        const open=document.querySelector('[data-pattern="halo-open"]'), pill=open.querySelector('div[style*="border-radius"]'), text=open.querySelector('[data-safe]'), typed=text.querySelector('.halo-open-typed');
        const start=Number(open.dataset.start), end=document.querySelector('[data-pattern="halo-end"]'), endStart=Number(end.dataset.start), d=Number(end.dataset.duration);
        const frames=[];
        for(const local of [1.2,1.35,1.5,1.7,2.0]){window.__apply(start*1000+local*1000);frames.push({shown:getComputedStyle(text).visibility==="visible",text:typed.textContent})}
        const pillFrames=[];
        for(const local of [.6,1.0,1.5]){window.__apply(start*1000+local*1000);const c=getComputedStyle(pill);pillFrames.push({width:parseFloat(c.width),height:parseFloat(c.height),radius:c.borderRadius,shadow:c.boxShadow})}
        window.__apply((endStart+Math.min(1.8,d-.05))*1000);
        const group=end.querySelector('div[style*="display:flex"]'), word=group.querySelector('.kern'), credit=end.querySelector('[data-safe]:last-child');
        return {typed:frames,pill:pillFrames,end:{pieces:end.querySelectorAll('[data-moves]').length,wordSize:parseFloat(getComputedStyle(word).fontSize),animations:group.getAnimations().length,credit:credit?.textContent??""}};
      })()`);
      assert.deepEqual(result.typed.slice(0, 2).map(f => f.shown), [false, true], "the pill grows before the tagline begins typing");
      assert.equal(result.typed[1]!.text, "Y", "the first grapheme lands at the reveal start");
      assert.equal(result.typed.at(-1)!.text, "Your crew.", "the inline reveal completes and holds");
      assert.ok(result.pill[0]!.width > result.pill[0]!.height * 0.9 && result.pill[0]!.height > result.pill[1]!.height, "the logo-sized square rounds down into a pill-height capsule");
      assert.ok(result.pill[2]!.width > result.pill[1]!.width, "the capsule expands to fit its inline copy");
      assert.notEqual(result.pill[2]!.shadow, "none", "the expanded pill keeps a visible glow rim");
      assert.equal(result.end.pieces, 0, "no UI collage remains on the closing card");
      assert.ok(result.end.wordSize < 108, `closing wordmark is restrained (${result.end.wordSize}px)`);
      assert.equal(result.end.animations, 0, "the closing lockup does not keep pushing in");
      assert.match(result.end.credit, /TakeOne/);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("halo stack rows never sit on each other, so every row of the list reads", { timeout: 120_000 }, async () => {
  // Three rows of one list, each cropped down to its own last line: the tall middle row used to swallow a quarter of the third.
  const stack = ["0,0,400,300:logo@S1", "100,100,700,180:stack:Ask@S1", "100,320,700,180:stack@S1", "100,540,700,160:stack@S1", "800,100,500,400:card@S1", "100,900,300,100:chips@S1"];
  const sb = validateStoryboard(planHalo({ inputs: [BOARD], regions: stack, pitch: "Your crew." }, "halo-stack"));
  const dir = mkdtempSync(join(tmpdir(), "takeone-halo-stack-"));
  try {
    await ingest(dir, sb);
    await withPage(writePage(dir, sb).html, 1920, 1080, async (b) => {
      const shots = await b.evaluate<{ at: number; rows: { top: number; bottom: number; h: number }[] }[]>(`(()=>{
        const l=document.querySelector('[data-pattern="halo-float"]'),start=Number(l.dataset.start),d=Number(l.dataset.duration);
        return [0.3,0.6,0.9].map((f)=>{window.__apply((start+f*d)*1000);
          return {at:f,rows:[...l.querySelectorAll('[data-moves]')].map(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,h:r.height}}).sort((a,b)=>a.top-b.top)};});
      })()`);
      // No row sits on another: a row is cropped to its own content down to its last line, so any band hides text. The rows
      // stay a hairline apart through the beat, entrance and bob included; the old layout put a quarter of the third row
      // behind the tall middle one.
      for (const { at, rows } of shots) {
        assert.equal(rows.length, 3, `${at}: three rows of the list`);
        for (let i = 1; i < rows.length; i++) {
          const covered = rows[i - 1]!.bottom - rows[i]!.top, share = covered / Math.min(rows[i - 1]!.h, rows[i]!.h);
          assert.ok(share <= 0.02, `${at}: row ${i + 1} is covered by ${covered.toFixed(1)} px, ${(share * 100).toFixed(0)}% of its height`);
          assert.ok(covered <= 0, `${at}: rows ${i} and ${i + 1} stay apart, ${covered.toFixed(1)} px apart`);
        }
      }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
