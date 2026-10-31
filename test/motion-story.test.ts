import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writePage } from "../src/motion/motion.ts";
import { withPage } from "../src/motion/render.ts";
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

test("story stacks the headline above the product on a portrait or square frame, with no two boxes meeting", { timeout: 120_000 }, async () => {
  for (const [w, h] of [[1080, 1920], [1080, 1080]] as const) {
    const sb = validateStoryboard(planStory({ pitch: BRIEF.replace(/^chips:.*$/m, "chips: Plan the watch / the way you'd say it. | Who has the 0400?; Swap Ines and Kofi; Galley duty, Tuesday; Ines is rested; Kofi is on call; Standby crew").replace(/^phone.*$/m, "phone[Crew chat]: Workflows are shared by every team / humans and agents. | Who can take the 0400?; Ines and Kofi are rested.").replace(/^cards:.*$/m, "cards: Plan and navigate / from idea to launch. | Product initiatives; Strategic roadmaps; Customer requests"), logo: "Tidewater", brand: BRAND }, `story-stack-${w}x${h}`, [w, h]));
    const dir = mkdtempSync(join(tmpdir(), "takeone-story-stack-"));
    try {
      await withPage(writePage(dir, sb).html, w, h, async (b) => {
        type Read = { head: number[]; product: number[][]; wide: string[]; orphan: string[]; covered: string[] };
        const boxes = await b.evaluate<Read[]>(`(()=>[...document.querySelectorAll('[data-pattern="story"]')].map((l)=>{
          window.__apply(Number(l.dataset.start)*1000+Number(l.dataset.duration)*1000-50);
          const [copy,stage]=[...l.children].filter((c)=>c.tagName==="DIV"),box=(e)=>{const r=e.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom];};
          const text=(e)=>[...e.childNodes].some((n)=>n.nodeType===3&&n.textContent.trim());
          // a text element wider than its box; a headline part whose last line is one short word; a card title another card sits over
          const wide=[...l.querySelectorAll("*")].filter((e)=>text(e)&&e.clientWidth&&e.scrollWidth>e.clientWidth+1).map((e)=>e.textContent.trim());
          const orphan=[...copy.lastElementChild.children].filter((p)=>{const ws=[...p.querySelectorAll(".story-word")],top=ws.map((x)=>Math.round(x.getBoundingClientRect().top)),last=ws.filter((_,i)=>top[i]===Math.max(...top));const w=(x)=>x.getBoundingClientRect().right-x.getBoundingClientRect().left,line=(t)=>ws.filter((_,i)=>top[i]===t).reduce((n,x)=>n+w(x)+8,0);return new Set(top).size>1&&(last.length===1&&last[0].textContent.length<=4||line(Math.max(...top))<.4*Math.max(...top.map(line)));}).map((p)=>p.textContent.trim());
          const covered=[...stage.children].map((c)=>c.firstElementChild).filter((t)=>t&&t.tagName==="DIV"&&t.parentElement.style.background).filter((t)=>{const r=document.createRange();r.selectNodeContents(t);return [...r.getClientRects()].some((q)=>[q.left+2,q.right-2].some((x)=>!t.parentElement.contains(document.elementFromPoint(x,(q.top+q.bottom)/2))));}).map((t)=>t.textContent.trim());
          return {head:box(copy.lastElementChild),product:[...stage.children].map(box),wide,orphan,covered};}))()`);
        assert.equal(boxes.length, 4);
        const chips = boxes[0]!.product;
        for (const [i, a] of chips.entries()) for (const c of chips.slice(i + 1)) assert.ok(a[2]! <= c[0]! || c[2]! <= a[0]! || a[3]! <= c[1]! || c[3]! <= a[1]!, `${w}x${h}: two chips meet`);
        for (const { head, product, wide, orphan, covered } of boxes) {
          assert.deepEqual([wide, orphan, covered], [[], [], []], `${w}x${h}: text wider than its box, a headline whose last line is a short word or under 40% of its widest, or a card title covered`);
          const [top, bottom] = [Math.min(...product.map((p) => p[1]!)) - head[3]!, h * .93 - Math.max(...product.map((p) => p[3]!))];
          assert.ok(Math.abs(top - bottom) <= h * .04, `${w}x${h}: the product sits ${top.toFixed(0)} px under the headline and ${bottom.toFixed(0)} px above the bottom margin`);
          for (const p of product) {
            assert.ok(head[3]! < p[1]!, `${w}x${h}: the headline ends at ${head[3]!.toFixed(0)} px, above the product at ${p[1]!.toFixed(0)} px`);
            assert.ok(p[0]! >= 0 && p[2]! <= w && p[3]! <= h, `${w}x${h}: the product stays in the frame`);
          }
          assert.ok(head[0]! >= w * .05 && head[2]! <= w * .95, `${w}x${h}: the headline stays inside the 5% inset`);
        }
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

const SHEET = join(tmpdir(), `takeone-story-sheet-${process.pid}.csv`);
const SHEET_BRIEF = ["sheet[customers.csv]: One spreadsheet. / Every row a customer.", "fill[template]: One template. / Every field filled.", "grid[films]: Five hundred films. / One command."].map(l => `${l} | ${SHEET}`).join("\n");
const sheetCsv = (rows: number) => ["id,name,company,plan,accent,notes", ...Array.from({ length: rows }, (_, i) => `c${i},${i ? "Bartholomew Oyelaran-Whitfield" : "Ada Okafor"},${i ? "Northwind Freight & Logistics" : "Lumen Labs"},Pro,#d9673f,x`)].join("\n");

test("story draws a spreadsheet beat from a CSV's own rows, the id column left out and long cells cut", () => {
  writeFileSync(SHEET, sheetCsv(500));
  try {
    const sb = validateStoryboard(planStory({ pitch: SHEET_BRIEF, logo: "Tidewater", brand: BRAND }, "sheet-test", [1080, 1350]));
    assert.deepEqual(sb.scenes.map(s => s.kind ?? s.pattern), ["sheet", "fill", "grid", "end-card"]);
    assert.deepEqual(sb.scenes.map(s => s.tree?.length), [9, 5, 9, undefined], "the header and the first rows, four for the fill");
    assert.equal(sb.scenes[0]!.tree![0], "name | company | plan | accent", "the id column names a folder, it is not drawn, and only four columns are");
    assert.equal(sb.scenes[0]!.tree![2], "Bartholomew Oyel… | Northwind Freigh… | Pro | #d9673f");
    assert.deepEqual([sb.scenes[0]!.text, sb.scenes[0]!.note], ["500", SHEET.split("/").pop()], "the whole sheet's row count and file name");
    assert.deepEqual(sb.output && [sb.output.out_w, sb.output.out_h], [1080, 1350]);
    for (const s of sb.scenes.slice(0, 3)) assert.ok(s.d >= storySettle(s) + .8 - 1e-9, "the product settles, then holds");
  } finally { rmSync(SHEET, { force: true }); }
  assert.throws(() => planStory({ pitch: "sheet: A / B | no-such.csv\ngrid: C / D | no-such.csv", logo: "T" }, "x"), /no-such\.csv/);
});

test("the spreadsheet beats keep their text and product inside a 4:5 frame", { timeout: 120_000 }, async () => {
  writeFileSync(SHEET, sheetCsv(500));
  const [w, h] = [1080, 1350], dir = mkdtempSync(join(tmpdir(), "takeone-story-sheet-"));
  try {
    const sb = validateStoryboard(planStory({ pitch: SHEET_BRIEF, logo: "Tidewater", brand: BRAND }, "sheet-frame", [w, h]));
    await withPage(writePage(dir, sb).html, w, h, async (b) => {
      const read = await b.evaluate<{ wide: string[]; outside: number[][] }[]>(`(()=>[...document.querySelectorAll('[data-pattern="story"]')].map((l)=>{
        window.__apply(Number(l.dataset.start)*1000+Number(l.dataset.duration)*1000-50);
        const stage=[...l.children].filter((c)=>c.tagName==="DIV")[1];
        const text=(e)=>[...e.childNodes].some((n)=>n.nodeType===3&&n.textContent.trim());
        const wide=[...stage.querySelectorAll("*")].filter((e)=>text(e)&&e.clientWidth&&e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflow!=="hidden").map((e)=>e.textContent.trim());
        const outside=[...stage.children].filter((c)=>c.tagName==="DIV").map((c)=>{const r=c.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom];}).filter((r)=>r[0]<0||r[1]<0||r[2]>${w}||r[3]>${h}*.95);
        return {wide,outside};}))()`);
      assert.equal(read.length, 3);
      for (const { wide, outside } of read) assert.deepEqual([wide, outside], [[], []], "no text wider than its box, nothing past the frame or its bottom margin");
    });
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(SHEET, { force: true }); }
});
