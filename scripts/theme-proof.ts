#!/usr/bin/env node
// Reproducible theme proof; see README.md "Look and pacing" for fixture and real-take usage.
// node scripts/theme-proof.ts [output-dir] [--baseline path/to/old/render.ts]
// node scripts/theme-proof.ts [output-dir] --take path/to/real/take  (grid from a real take at 1080p60)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { THEMES, resolveTheme } from "../src/themes.ts";
import { renderTake, FONTS_DIR } from "../src/render/render.ts";

const { values, positionals } = parseArgs({
 options: { take: { type: "string" }, baseline: { type: "string" } }, allowPositionals: true,
});
const dest = resolve(positionals[0] ?? "tmp/theme-proof");
mkdirSync(dest, { recursive: true });
const take = join(dest, "take");
mkdirSync(join(take,"analysis"), { recursive: true });
const ff = (...args:string[]) => execFileSync("ffmpeg", ["-nostdin","-hide_banner","-v","error","-y",...args], {maxBuffer:10_000_000});
const names=Object.keys(THEMES);
const font=join(FONTS_DIR,"Geist.ttf");
const columns=4;
const gridCell={width:640,height:720,label:36};
const fixture={
 source_seconds:10,
 comparison:{duration_s:10,title:"A launch worth sharing",caption:{t:0.6,d:3,text:"Umer prepares the next release"},frame_s:1.2},
 themes:{duration_s:4.6,title:"A launch worth sharing",caption:{t:3.1,d:1.5,text:"Umer's launch board"},title_frame_s:1.6,caption_frame_s:4.0},
 render:{out_w:1280,out_h:720,caption_size:34,preset:"fast",idle_speed:1,max_upscale:1,stage_margin:0.16,fade_s:0},
};
const provenance=(source:string,realTake:boolean)=>{
const hash=(file:string)=>createHash("sha256").update(readFileSync(file)).digest("hex");
const fontManifest=JSON.parse(readFileSync(join(FONTS_DIR,"manifest.json"),"utf8")) as {file:string}[];
const artifacts=realTake ? ["takeone-themes-grid.png",...names.flatMap(name=>[`${name}.png`,`${name}.mp4`])] : ["takeone-themes-grid.png","takeone-themes-cycle.mp4","takeone-themes-before.png","takeone-themes-after.png","takeone-themes-after.mp4","takeone-themes-side-by-side.mp4","metrics.json"];
writeFileSync(join(dest,"provenance.json"),JSON.stringify({generator:"scripts/theme-proof.ts",generator_sha256:hash(fileURLToPath(import.meta.url)),source:relative(fileURLToPath(new URL("../",import.meta.url)),source),source_sha256:hash(source),theme_sha256:hash(fileURLToPath(new URL("../src/themes.ts",import.meta.url))),renderer_sha256:hash(fileURLToPath(new URL("../src/render/render.ts",import.meta.url))),ffmpeg:execFileSync("ffmpeg",["-version"],{encoding:"utf8"}).split("\n")[0],settings:realTake ? {mode:"take",title_frame_s:1.6,caption_frame:"midpoint"} : {mode:"fixture",...fixture,baseline:values.baseline ? {file:values.baseline,sha256:hash(resolve(values.baseline))} : "current midnight",cycle_seconds:names.length*fixture.themes.duration_s},fonts:Object.fromEntries(fontManifest.map(font=>[font.file,hash(join(FONTS_DIR,font.file))])),themes:names,grid:{columns,rows:Math.ceil(names.length/columns),width:columns*gridCell.width,height:Math.ceil(names.length/columns)*(gridCell.height+gridCell.label)},artifacts:Object.fromEntries(artifacts.map(name=>[name,hash(join(dest,name))]))},null,2)+"\n");
};
/** Each cell stacks a title frame over a caption frame; the label is the theme, never on the video. */
const grid=()=>{
 const layout=names.map((_,i)=>`${(i%columns)*gridCell.width}_${Math.floor(i/columns)*(gridCell.height+gridCell.label)}`).join("|");
 const inputs=names.flatMap(name=>["-i",join(dest,`${name}.png`)]);
 const cells=names.map((name,i)=>`[${i}:v]scale=${gridCell.width}:${gridCell.height},pad=${gridCell.width}:${gridCell.height+gridCell.label}:0:${gridCell.label}:color=0x121319,drawtext=fontfile='${font}':text='${name}':x=20:y=9:fontsize=20:fontcolor=white[c${i}]`).join(";");
 ff(...inputs,"-filter_complex",`${cells};${names.map((_,i)=>`[c${i}]`).join("")}xstack=inputs=${names.length}:layout=${layout}[grid]`,"-map","[grid]","-frames:v","1","-update","1",join(dest,"takeone-themes-grid.png"));
};
if(values.take!==undefined){
 // A real take at the default 1080p60 output: frames from its title and its first caption.
 cpSync(resolve(values.take),take,{recursive:true});
 for(const name of names){
  const result=await renderTake(take,resolveTheme(name));
  copyFileSync(result.out,join(dest,`${name}.mp4`));
  const caption=readFileSync(join(take,"captions.ass"),"utf8").match(/^Dialogue: 2,([\d:.]+),([\d:.]+),/m);
  if(!caption) throw new Error("the take needs a caption");
  const seconds=(s:string)=>s.split(":").reduce((n,p)=>n*60+Number(p),0);
  const at=((seconds(caption[1]!)+seconds(caption[2]!))/2).toFixed(2);
  ff("-ss","1.6","-i",result.out,"-frames:v","1","-update","1",join(dest,`${name}-title.png`));
  ff("-ss",at,"-i",result.out,"-frames:v","1","-update","1",join(dest,`${name}-caption.png`));
  ff("-i",join(dest,`${name}-title.png`),"-i",join(dest,`${name}-caption.png`),"-filter_complex","[0:v][1:v]vstack","-frames:v","1","-update","1",join(dest,`${name}.png`));
  console.log(`rendered ${name}`);
 }
 grid();
 provenance(join(resolve(values.take),"screen.webm"),true);
 console.log(`proof saved in ${dest}`);
 process.exit(0);
}
const source=fileURLToPath(new URL("../resources/demo/tidewater-board.png",import.meta.url));
ff("-loop","1","-framerate","60","-i",source,"-t",String(fixture.source_seconds),"-c:v","mpeg4","-q:v","2","-f","matroska",join(take,"screen.webm"));
const meta={id:"theme-demo",width:2560,height:1440,trim_end:fixture.comparison.duration_s,title:fixture.comparison.title,captions:[fixture.comparison.caption]};
const save=()=>writeFileSync(join(take,"take.json"),JSON.stringify(meta));
save();writeFileSync(join(take,"analysis/beats.json"),"[]");writeFileSync(join(take,"analysis/decisions.jsonl"),"");
const size=fixture.render;
if(values.baseline!==undefined){
 const old=await import(pathToFileURL(resolve(values.baseline)).href) as {renderTake:typeof renderTake};
 copyFileSync((await old.renderTake(take,resolveTheme("midnight",size))).out,join(dest,"before.mp4"));
}else copyFileSync((await renderTake(take,resolveTheme("midnight",size))).out,join(dest,"before.mp4"));
copyFileSync((await renderTake(take,resolveTheme("paper",size))).out,join(dest,"takeone-themes-after.mp4"));
ff("-ss",String(fixture.comparison.frame_s),"-i",join(dest,"before.mp4"),"-frames:v","1","-update","1",join(dest,"takeone-themes-before.png"));
ff("-ss",String(fixture.comparison.frame_s),"-i",join(dest,"takeone-themes-after.mp4"),"-frames:v","1","-update","1",join(dest,"takeone-themes-after.png"));
ff("-i",join(dest,"before.mp4"),"-i",join(dest,"takeone-themes-after.mp4"),"-filter_complex","[0:v]scale=960:540[a];[1:v]scale=960:540[b];[a][b]hstack=inputs=2","-an","-c:v","libx264","-crf","20","-preset","fast","-pix_fmt","yuv420p","-movflags","+faststart",join(dest,"takeone-themes-side-by-side.mp4"));
const facts:Record<string,unknown>={};
const luma=(c:string)=>[1,3,5].map(i=>parseInt(c.slice(i,i+2),16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i]!,0);
for(const name of names){
 // The take's own title, then a caption once it clears; never the theme name.
 meta.trim_end=fixture.themes.duration_s;meta.title=fixture.themes.title;meta.captions=[fixture.themes.caption];save();
 const d=resolveTheme(name,size);const result=await renderTake(take,d);
 copyFileSync(result.out,join(dest,`${name}.mp4`));copyFileSync(join(take,"render.log"),join(dest,`${name}.log`));
 ff("-ss",String(fixture.themes.title_frame_s),"-i",result.out,"-frames:v","1","-update","1",join(dest,`${name}-title.png`));
 ff("-ss",String(fixture.themes.caption_frame_s),"-i",result.out,"-frames:v","1","-update","1",join(dest,`${name}-caption.png`));
 ff("-i",join(dest,`${name}-title.png`),"-i",join(dest,`${name}-caption.png`),"-filter_complex","[0:v][1:v]vstack","-frames:v","1","-update","1",join(dest,`${name}.png`));
 const luminances=[luma(d.text),luma(d.card)].sort((a,b)=>a-b);
 const contrast=(luminances[1]!+0.05)/(luminances[0]!+0.05);assert.ok(contrast>=4.5,`${name}: contrast ${contrast}`);
 facts[name]={seconds:result.seconds,contrast,fonts:[...readFileSync(join(take,"render.log"),"utf8").matchAll(/fontselect:[^\n]+/g)].map(m=>m[0])};
 console.log(`rendered ${name}`);
}
grid();
const quote=(s:string)=>s.replace(/'/g,"'\\''");
writeFileSync(join(dest,"cycle.txt"),names.map(n=>`file '${quote(join(dest,`${n}.mp4`))}'`).join("\n")+"\n");
ff("-f","concat","-safe","0","-i",join(dest,"cycle.txt"),"-c","copy","-movflags","+faststart",join(dest,"takeone-themes-cycle.mp4"));
writeFileSync(join(dest,"metrics.json"),JSON.stringify(facts,null,2)+"\n");
provenance(source,false);
console.log(`proof saved in ${dest}`);
