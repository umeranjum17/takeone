import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deckCards, glowStoryboard, pressBox, treeRows } from "../src/motion/glow.ts";
import { imageSize, ingest } from "../src/motion/ingest.ts";
import { writePage } from "../src/motion/motion.ts";
import { withPage } from "../src/motion/render.ts";
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
  assert.ok(Math.abs(sb.scenes[3]!.d - (0.55 * 3 + 0.45)) < 1 / 60, `deck is ${sb.scenes[3]!.d} s`);
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

test("glow deck captions must be covered by both display and caption fonts", async () => {
  const size = imageSize(BOARD), tap = await pressBox(BOARD, "1,2,3,4");
  const input = glowStoryboard({ inputs: [BOARD], title: "Meet the crew", pitch: "Plan the launch", logo: "Tidewater", regions: [
    "316,120,520,520:¤", "868,120,520,520:Track every task.",
  ] }, "glow-deck-font-test", [size], tap) as { theme: { overrides: Record<string, string> } };
  input.theme.overrides.caption_font = "Instrument Serif";
  assert.throws(() => validateStoryboard(input), /missing glyph in Instrument Serif for "¤"/);
});

test("glow deck measures wide captions and preserves sizes that already fit", { timeout: 120_000 }, async () => {
  const size = imageSize(BOARD), tap = await pressBox(BOARD, "1,2,3,4"), wide = "W".repeat(32), captions = [wide, "Short"];
  const regions = [`316,120,520,520:${wide}`, "868,120,520,520:Short"];
  const sb = validateStoryboard(glowStoryboard({ inputs: [BOARD], title: "Meet the crew", pitch: "Plan the launch", logo: "Tidewater", regions },
    "glow-deck-width-test", [size], tap));
  const dir = mkdtempSync(join(tmpdir(), "takeone-glow-deck-width-"));
  try {
    await ingest(dir, sb);
    await withPage(writePage(dir, sb).html, 1920, 1080, async b => {
      const measured = await b.evaluate<{ headline: { text: string; size: number; width: number; max: number }[]; footer: { text: string; size: number; width: number; max: number }[] }>(`(()=>{
        const root=document.querySelector('[data-pattern="glow-deck"]');
        const headline=[...root.querySelectorAll(':scope > div[data-safe=""]')].filter(e=>!e.textContent.includes(' / ')).map(e=>({text:e.textContent,size:parseFloat(getComputedStyle(e).fontSize),width:e.getBoundingClientRect().width,max:innerWidth*.56}));
        const footer=[...root.querySelectorAll('[data-safe^="card "]')].map(card=>{const f=card.lastElementChild,c=f.firstElementChild,i=f.lastElementChild,cs=getComputedStyle(f);return{text:c.textContent,size:parseFloat(getComputedStyle(c).fontSize),width:c.getBoundingClientRect().width,max:f.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight)-i.getBoundingClientRect().width};});
        return {headline,footer};
      })()`);
      const baseHeadline = Math.min(1080 * 0.085, 1920 * 0.56 / (0.55 * wide.length));
      const cardWidth = Math.min(1920 * 0.84 / (2 * 0.86), 1080 * 0.62 / 1.18);
      assert.ok(measured.headline[0]!.size < baseHeadline);
      assert.ok(Math.abs(measured.headline[1]!.size - baseHeadline) < 0.001);
      assert.ok(measured.footer[0]!.size < Math.min(cardWidth * 0.055, (cardWidth * 0.72) / (0.55 * wide.length)));
      assert.ok(Math.abs(measured.footer[1]!.size - Math.min(cardWidth * 0.055, (cardWidth * 0.72) / (0.55 * captions[1]!.length))) < 0.001);
      for (const text of [...measured.headline, ...measured.footer]) assert.ok(text.width <= text.max + 0.5, `${text.text}: ${text.width} > ${text.max}`);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("glow deck shows exactly one headline and one index, the front card's, on every frame after its first", { timeout: 120_000 }, async () => {
  const size = imageSize(BOARD), tap = await pressBox(BOARD, "1,2,3,4");
  const captions = ["Plan the launch.", "Track every task.", "See what moved."];
  const regions = ["316,120,520,520", "868,120,520,520", "1984,128,544,600"].map((r, i) => `${r}:${captions[i]}`);
  const sb = validateStoryboard(glowStoryboard({ inputs: [BOARD], title: "Meet the crew", pitch: "Plan the launch", logo: "Tidewater", tree: "Crew,>Chief,>Scout", regions },
    "glow-deck-window-test", [size], tap));
  const dir = mkdtempSync(join(tmpdir(), "takeone-glow-deck-"));
  try {
    await ingest(dir, sb); // cuts the deck crops out of the board, as a first render does
    await withPage(writePage(dir, sb).html, 1920, 1080, async (b) => {
      const [start, d] = await b.evaluate<[number, number]>(`(()=>{const l=document.querySelector('[data-pattern="glow-deck"]');return [Number(l.dataset.start),Number(l.dataset.duration)];})()`);
      const isIndex = (t: string) => /^\d\d \/ \d\d$/.test(t);
      // The deck's first frame is a cut, which every scene's text skips; from the next frame to its last, one card is named.
      const samples = await b.evaluate<{ local: number; shown: string[]; front: number }[]>(`(()=>{
        const layer=document.querySelector('[data-pattern="glow-deck"]'),cards=[...layer.querySelectorAll('[data-safe^="card "]')],out=[];
        for(let f=1;f<Math.round(${d}*60);f++){
          const local=f*1000/60;window.__apply(${start}*1000+local);
          const shown=[...layer.querySelectorAll(':scope > div[data-safe=""]')].filter(e=>getComputedStyle(e).visibility==="visible").map(e=>e.textContent);
          const front=cards.map((e,i)=>[i,Number(getComputedStyle(e).zIndex)]).sort((a,b)=>b[1]-a[1])[0][0];
          out.push({local,shown,front});
        }
        return out;
      })()`);
      for (const { local, shown, front } of samples) {
        const frame = Math.round(local * 60 / 1000);
        const heads = shown.filter(t => !isIndex(t)), nums = shown.filter(isIndex);
        assert.equal(heads.length, 1, `frame ${frame}: headlines ${JSON.stringify(heads)}`);
        assert.equal(nums.length, 1, `frame ${frame}: indices ${JSON.stringify(nums)}`);
        // Cards step every 0.55 s; a frame within 1 ms of a step may show either card.
        if (Math.abs(local - Math.round(local / 550) * 550) > 1) {
          const i = Math.min(captions.length - 1, Math.floor(local / 550));
          assert.deepEqual([heads[0], nums[0]], [captions[i], `0${i + 1} / 03`], `frame ${frame}`);
          assert.equal(front, i, `frame ${frame}: caption ${heads[0]} but card ${front + 1} is on top`);
        }
      }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
