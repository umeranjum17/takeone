// A multi-worker HyperFrames render gives each worker a chunk of ceil(frames / workers) frames and a fresh page. Before #253 a
// worker's first frame could be drawn with the scene's windowed text hidden for that one frame (a 1-worker render had none);
// the cause was `visibility` keyframed on the Web Animations clock. These checks need no engine and no model: they seek the
// page the way a worker does at every chunk start, for every worker count the engine accepts, and fail on a lost text box.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { glowStoryboard, pressBox } from "../src/motion/glow.ts";
import { imageSize, ingest } from "../src/motion/ingest.ts";
import { writePage } from "../src/motion/motion.ts";
import { withPage } from "../src/motion/render.ts";
import { planStory } from "../src/motion/story.ts";
import { filmDuration, validateStoryboard } from "../src/motion/storyboard.ts";

const BOARD = resolve("resources/demo/tidewater-board.png");
const REGIONS = ["316,120,520,520:Plan the launch.", "868,120,520,520:Track every task.", "1984,128,544,600:See what moved."];
const STORY = [
  "chips: Plan the watch / the way you'd say it. | Who has the 0400?; Swap Ines and Kofi; Galley duty, Tuesday",
  "phone[Crew chat]: Ask it plainly. / Get the crew plan. | Who can take the 0400?; Ines and Kofi are rested.",
  "cards: The papers / write themselves. | Watch bill; Duty roster",
  "stats: Less juggling. / More rest. | 9 crew; 0 clashes",
].join("\n");

/** The first frame of every chunk the engine hands out (`distributeFrames`), for each worker count it allows. */
function chunkStarts(frames: number): number[] {
  const starts = new Set<number>();
  for (let w = 2; w <= 16; w++) for (let i = 1, per = Math.ceil(frames / w); i * per < frames; i++) starts.add(i * per);
  return [...starts].sort((a, b) => a - b);
}

async function films(): Promise<{ name: string; sb: ReturnType<typeof validateStoryboard>; ingestFirst: boolean }[]> {
  const size = imageSize(BOARD), tap = await pressBox(BOARD, "1,2,3,4");
  const glow = (regions?: string[]) => validateStoryboard(glowStoryboard({ inputs: [BOARD], title: "Meet the crew", subtitle: "Ask. Delegate. Done.", pitch: "Plan the launch with Umer", logo: "Tidewater", tree: "Crew,>Chief,>Scout", ...(regions ? { regions } : {}) }, "worker-start", [size], tap));
  return [
    { name: "glow promo with a deck", sb: glow(REGIONS), ingestFirst: true },
    { name: "glow promo", sb: glow(), ingestFirst: true },
    { name: "story film", sb: validateStoryboard(planStory({ pitch: STORY, logo: "Tidewater", brand: resolve("resources/demo/tidewater-brand.json") }, "worker-start")), ingestFirst: false },
  ];
}

test("a worker's first frame keeps every text box the frames either side of it draw, at every chunk start of every worker count", { timeout: 300_000 }, async () => {
  for (const { name, sb, ingestFirst } of await films()) {
    const dir = mkdtempSync(join(tmpdir(), "takeone-worker-start-"));
    try {
      if (ingestFirst) await ingest(dir, sb);
      const fps = sb.output.fps, frames = Math.round(filmDuration(sb) * fps), starts = chunkStarts(frames);
      assert.ok(starts.length >= 20, `${name}: ${starts.length} chunk starts`);
      await withPage(writePage(dir, sb).html, sb.output.out_w, sb.output.out_h, async (b) => {
        const r = await b.evaluate<{ animated: string[]; lost: string[]; differs: string[] }>(`(()=>{
          const texts=[...document.querySelectorAll('.layer *')].filter(e=>[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()));
          const shown=()=>new Set(texts.map((e,i)=>{const c=getComputedStyle(e);return c.visibility!=='hidden'&&Number(c.opacity)>0.01?i:-1;}).filter(i=>i>=0));
          // The engine seeks every frame as t, t - 1 ms, t; a worker's first frame follows its page's own seek to 0.
          const at=(f,from)=>{const t=f*1000/${fps};for(const s of from)window.__apply(s);window.__apply(t);window.__apply(t-1);window.__apply(t);return shown();};
          const animated=document.getAnimations().flatMap(a=>a.effect?.getKeyframes?.()??[]).flatMap(k=>Object.keys(k)).filter(p=>p==='visibility');
          const lost=[],differs=[];
          for(const f of ${JSON.stringify(starts)}){
            const fresh=at(f,[0,0]), stream=at(f,[(f-2)*1000/${fps},(f-1)*1000/${fps}]);
            const before=at(f-1,[0]), after=at(f+1,[0]);
            const gone=[...before].filter(i=>after.has(i)&&!fresh.has(i)).map(i=>texts[i].textContent.trim().slice(0,24));
            if(gone.length)lost.push('frame '+f+' lost '+gone.join(', '));
            if([...fresh].join()!==[...stream].join())differs.push('frame '+f);
          }
          return {animated,lost,differs};})()`);
        assert.deepEqual(r.animated, [], `${name}: a window may not animate visibility, a discrete flip a frame time can land on`);
        assert.deepEqual(r.lost, [], `${name}: chunk-start frames drawn without text`);
        assert.deepEqual(r.differs, [], `${name}: a first seek must draw what streaming into the frame draws`);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
