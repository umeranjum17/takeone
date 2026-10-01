#!/usr/bin/env node
// Reproducible visual proof using a fictional product board. No desktop capture.
// node scripts/theme-proof.ts [output-dir] [--baseline path/to/old/render.ts]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { THEMES, resolveTheme } from "../src/themes.ts";
import { renderTake, FONTS_DIR } from "../src/render/render.ts";

const dest = resolve(process.argv[2] ?? "tmp/theme-proof");
mkdirSync(dest, { recursive: true });
const take = join(dest, "take");
mkdirSync(join(take,"analysis"), { recursive: true });
const ff = (...args:string[]) => execFileSync("ffmpeg", ["-nostdin","-hide_banner","-v","error","-y",...args], {maxBuffer:10_000_000});
const font = join(FONTS_DIR,"Geist.ttf");
const text = (words:string,x:number,y:number,size=26,colour="#343a48") => `drawtext=fontfile='${font}':text='${words}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${colour}`;
const boxes = [
  "drawbox=x=0:y=0:w=1280:h=64:color=0xf0f1f4:t=fill",
  "drawbox=x=0:y=64:w=220:h=656:color=0xf7f8fa:t=fill",
  "drawbox=x=244:y=155:w=308:h=475:color=0xf1f3f6:t=fill",
  "drawbox=x=570:y=155:w=308:h=475:color=0xf1f3f6:t=fill",
  "drawbox=x=896:y=155:w=356:h=475:color=0xf1f3f6:t=fill",
  "drawbox=x=260:y=217:w=276:h=120:color=white:t=fill",
  "drawbox=x=586:y=217:w=276:h=120:color=white:t=fill",
  "drawbox=x=912:y=217:w=324:h=120:color=white:t=fill",
  "drawbox=x=276:y=308:w=48:h=5:color=0x6d8cff:t=fill",
  text("Fieldwork",28,18,28), text("Umer",1150,22,20), text("Workspace",28,105,18), text("Launch board",28,153,20),
  text("Product launch",246,102,34), text("Planned",260,175,22), text("In progress",586,175,22), text("Ready",912,175,22),
  text("Draft the launch",276,239,23), text("Review the demo",602,239,23), text("Share the update",928,239,23),
  text("3 tasks",276,277,17,"#7a8190"), text("Umer",602,277,17,"#7a8190"), text("Ready to publish",928,277,17,"#7a8190"),
].join(",");
ff("-f","lavfi","-i","color=white:s=1280x720:r=60:d=5","-vf",boxes,"-c:v","libvpx-vp9","-threads","4",join(take,"screen.webm"));
writeFileSync(join(take,"take.json"),JSON.stringify({id:"theme-demo",width:1280,height:720,trim_end:5,title:"A clear view of the work",captions:[{t:0.6,d:2,text:"Umer prepares the launch"},{t:3,d:1.5,text:"Every detail, ready to share"}]}));
writeFileSync(join(take,"analysis/beats.json"),JSON.stringify([{id:"b1",t0:0,t1:5,anchor_t:2,kind:"click",zones:[{name:"card",type:"act",bbox:[570,155,308,475]}],actions:[{k:"click",t:2000,x:720,y:260}]}]));
writeFileSync(join(take,"analysis/decisions.jsonl"),JSON.stringify({beat:"b1",A:"card",L:1,p:0,K:1,conf:1,decided_by:"heuristic"})+"\n");
const size = {out_w:1280,out_h:720,caption_size:28,preset:"fast",idle_speed:1};
const baseline = process.argv.indexOf("--baseline");
if (baseline !== -1) {
  const old = await import(pathToFileURL(resolve(process.argv[baseline + 1]!)).href) as {renderTake:typeof renderTake};
  const out = await old.renderTake(take, {...resolveTheme("midnight",size)});
  copyFileSync(out.out,join(dest,"before.mp4"));
} else {
  copyFileSync((await renderTake(take,resolveTheme("midnight",size))).out,join(dest,"before.mp4"));
}
const facts: Record<string,unknown> = {};
for (const name of Object.keys(THEMES)) {
  const d=resolveTheme(name,size);
  const result=await renderTake(take,d);
  copyFileSync(result.out,join(dest,`${name}.mp4`));
  copyFileSync(join(take,"render.log"),join(dest,`${name}.log`));
  ff("-ss","1.1","-i",result.out,"-frames:v","1","-update","1",join(dest,`${name}.png`));
  facts[name]={seconds:result.seconds,fonts:[...readFileSync(join(take,"render.log"),"utf8").matchAll(/fontselect:[^\n]+/g)].map(m=>m[0])};
  console.log(`rendered ${name}`);
}
ff("-ss","1.1","-i",join(dest,"before.mp4"),"-frames:v","1","-update","1",join(dest,"takeone-themes-before.png"));
copyFileSync(join(dest,"paper.png"),join(dest,"takeone-themes-after.png"));
ff("-i",join(dest,"before.mp4"),"-i",join(dest,"paper.mp4"),"-filter_complex","[0:v]scale=960:540[a];[1:v]scale=960:540[b];[a][b]hstack=inputs=2","-an","-c:v","libx264","-crf","20","-preset","fast","-pix_fmt","yuv420p","-movflags","+faststart",join(dest,"takeone-themes-side-by-side.mp4"));
const names=Object.keys(THEMES);
const inputs=names.flatMap(name=>["-i",join(dest,`${name}.png`)]);
const cells=names.map((name,i)=>`[${i}:v]scale=640:360,pad=640:396:0:36:color=0x121319,drawtext=fontfile='${font}':text='${name}':x=20:y=9:fontsize=20:fontcolor=white[c${i}]`).join(";");
ff(...inputs,"-filter_complex",`${cells};${names.map((_,i)=>`[c${i}]`).join("")}xstack=inputs=8:layout=0_0|640_0|1280_0|1920_0|0_396|640_396|1280_396|1920_396[grid]`,"-map","[grid]","-frames:v","1","-update","1",join(dest,"takeone-themes-grid.png"));
writeFileSync(join(dest,"metrics.json"),JSON.stringify(facts,null,2)+"\n");
console.log(`proof saved in ${dest}`);
