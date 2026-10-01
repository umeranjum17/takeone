// Native 1080p sheets for every fragment, including its supported UI states, in two themes.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readStoryboard, writePage } from "../src/motion/motion.ts";
import { renderFrames } from "../src/motion/render.ts";
const root = resolve("tmp/evidence/t1-l8");
const kinds = ["button", "input", "chip", "toast", "feed-row", "counter", "line-chart", "bar-chart", "spinner", "browser-chrome", "phone-chrome"];
const sb = readStoryboard(resolve("tmp/motion-proof/zoom-tour"));
for (const theme of ["editorial", "midnight"]) {
  const dir = resolve(`tmp/motion-proof/fragment-contact-${theme}`);
  mkdirSync(dir, { recursive: true });
  sb.theme.name = theme;
  const { html } = writePage(dir, sb);
  const setup = `window.setup=async()=>{
    const stage=$("#stage"), groups=[];
    const kinds=${JSON.stringify(kinds)};
    kinds.forEach(kind=>{
      const group=h('<div style="position:absolute;inset:0;background:var(--bg)"></div>');stage.append(group);groups.push(group);
      const title=h('<div style="position:absolute;left:120px;top:60px;font:48px var(--display);color:var(--text)"></div>');title.textContent=kind+' / ${theme}';group.append(title);
      const states=kind==='button'?['idle','hover','pressed']:kind==='input'?['empty','typing','filled']:[''];
      states.forEach((state,i)=>{
        const ctx=sceneCtx(1920,900,{screen:'S1'},''),spec={kind,state};
        const row=h('<div style="position:absolute;left:120px;right:120px;top:'+ (states.length===1?180:180+i*250)+'px;display:flex;align-items:center;justify-content:center"></div>');group.append(row);
        const label=h('<span style="position:absolute;left:0;font:24px var(--mono);color:var(--text)"></span>');label.textContent=state;row.append(label);
        BASE=kind==='input'&&state==='typing'?1000:0;row.append(FRAGMENTS[kind](spec,ctx));BASE=0;
      });
    });
    TICKS.push(ms=>groups.forEach((el,i)=>el.style.display=i===Math.floor(ms/1000)?'block':'none'));
  };`;
  const page = join(dir, "contact.html");
  writeFileSync(page, readFileSync(html, "utf8").replace("</body>", `<script>${setup}</script></body>`));
  await renderFrames({ html: page, width: 1920, height: 1080, fps: 1, frames: kinds.length, firstFrame: .5, workers: 2, framesDir: join(dir, "frames") });
  for (const [i, kind] of kinds.entries()) {
    copyFileSync(join(dir, "frames", `${String(i + 1).padStart(6, "0")}.png`), join(root, `takeone-motion-fragment-${kind}-${theme}-after.png`));
  }
}
