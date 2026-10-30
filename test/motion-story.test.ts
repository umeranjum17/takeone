import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
          assert.ok(Math.abs(top - bottom) <= h * .06, `${w}x${h}: the product sits ${top.toFixed(0)} px under the headline and ${bottom.toFixed(0)} px above the bottom margin`);
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
