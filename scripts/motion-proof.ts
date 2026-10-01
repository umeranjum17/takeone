// Offline motion proof, always run under the shared heavy-job lock. Demo scene only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ingest } from "../src/motion/ingest.ts";
import { renderMotion, writePage } from "../src/motion/motion.ts";
import { renderFrames, withPage } from "../src/motion/render.ts";
import { validateStoryboard } from "../src/motion/storyboard.ts";
import type { Scene } from "../src/motion/types.ts";
import { cameraViewport } from "../src/motion/camera.ts";
import { allTimelines } from "../src/motion/layout.ts";
import { motionTokens } from "../src/motion/theme.ts";
import { cameraMetrics } from "./quality.ts";

const root=resolve("tmp/evidence/t1-l8"),work=resolve("tmp/motion-proof");mkdirSync(root,{recursive:true});mkdirSync(work,{recursive:true});
const states={S1:[],S2:[["click","#newTask"],["type","#title","Draft launch announcement"],["click","#prio"],["click","#menu > :nth-child(3)"]],S3:[["click","#create"],["wait",300]],S4:[["drag","#lane0 > .card:first-child","#lane1",{capture_at:.6}]],S5:[["drop"]],S6:[["click","#more"],["click","#moreMenu > :nth-child(2)"],["wait",900]]};
const raw={version:1,id:"proof",source:{kind:"html",file:resolve("scripts/e2e/scene.html"),viewport:[2560,1440],states},theme:{name:"editorial"},output:{workers:8,preset:"fast",motion_blur:1},scenes:[{pattern:"hero-reveal",d:6,title:"Make it move",screen:"S1"}],regions:[]};
const sb=validateStoryboard(raw);
await ingest(work,sb);
const first=Object.fromEntries(Object.keys(states).map(id=>[id,createHash("sha256").update(readFileSync(join(work,"sources",`${id}.png`))).digest("hex")]));
await ingest(work,sb);
for(const id of Object.keys(states)) {
  const png=readFileSync(join(work,"sources",`${id}.png`));
  if(createHash("sha256").update(png).digest("hex")!==first[id])throw new Error(`ingest nondeterministic ${id}`);
  copyFileSync(join(work,"sources",`${id}.png`),join(root,`takeone-motion-${id}.png`));
}
writeFileSync(join(root,"takeone-motion-ingest.json"),JSON.stringify({identical:true,screens:first},null,2));
const framesMd5=(mp4:string)=>execFileSync("ffmpeg",["-v","error","-i",mp4,"-f","framemd5","-"],{encoding:"utf8",maxBuffer:16e6});
if (process.argv.includes("--ingest-only")) process.exit(0);
const sheet=(mp4:string,name:string)=>{
  const duration=Number(execFileSync("ffprobe",["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",mp4],{encoding:"utf8"}));
  execFileSync("ffmpeg",["-v","error","-y","-i",mp4,"-vf",`fps=16/${duration},scale=480:270,tile=4x4`,"-frames:v","1",join(root,name)]);
};
function saveReference(dir:string,id:string,manifest:{width:number;height:number}) {
  execFileSync("ffmpeg",["-v","error","-y","-framerate","60","-i",join(dir,"reference-frames","%06d.png"),"-vf",`scale=${manifest.width}:${manifest.height}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`,"-c:v","ffv1","-color_primaries","bt709","-color_trc","bt709","-colorspace","bt709","-color_range","tv",join(root,`takeone-motion-${id}-reference.mkv`)]);
}
async function render(id:string,scenes:Scene[],extras:Record<string,unknown>={}) {
  const dir=join(work,id);mkdirSync(dir,{recursive:true});
  const screens=Object.fromEntries(Object.entries(sb.screens).map(([id,s])=>[id,{...s,file:resolve(work,s.file)}]));
  const story=validateStoryboard({...raw,id,source:{kind:"image"},screens,scenes,...extras});
  writeFileSync(join(dir,"storyboard.json"),JSON.stringify(story,null,2));
  const start=performance.now(), r=await renderMotion(dir, id === "timing" ? {} : {framesDir:join(dir,"reference-frames")});
  const wall_s=(performance.now()-start)/1000;
  copyFileSync(r.out,join(root,`takeone-motion-${id}.mp4`));copyFileSync(join(dir,"render.json"),join(root,`takeone-motion-${id}-render.json`));
  sheet(r.out,`takeone-motion-${id}-after.png`);
  if (id !== "timing") saveReference(dir,id,r.manifest);
  const paths=r.manifest.camera ? JSON.parse(readFileSync(join(dir,"camera-scenes.json"),"utf8")) : {};
  const lists=allTimelines(story.layout,story.scenes);
  const metrics=Object.fromEntries(Object.entries(paths).map(([key,frames])=>{
    const projected=(frames as (import("../src/camera/types.ts").CameraFrame & {output?:import("../src/camera/types.ts").CameraFrame})[]).map(f=>f.output??f);
    const parts=key.split(":"),list=parts.length===1 || parts[0]==="master" ? 0 : ["A","B","C","D"].indexOf(parts[0]!);
    const scene=lists[list]![Number(parts.at(-1))]!;
    const viewport=cameraViewport(story,list);
    const m=cameraMetrics(projected,60,viewport.width,viewport.height,motionTokens(story.theme.name,story.theme.overrides).min_shot);
    if(scene.pattern==="hero-reveal") {m.max_upscale!.target=1;m.max_upscale!.goalPassed=m.max_upscale!.value<=1+1e-9;}
    return [key,m];
  }));
  writeFileSync(join(root,`takeone-motion-${id}-camera-gates.json`),JSON.stringify(metrics,null,2));
  if(id==="zoom-tour")writeFileSync(join(root,"takeone-motion-camera-gates.json"),JSON.stringify(metrics,null,2));
  return {dir,...r,wall_s};
}
const timing=await render("timing",[{pattern:"hero-reveal",d:6,title:"Make it move",screen:"S1",device:"browser"}]);
const decodedA=framesMd5(timing.out);const a=timing.manifest;
const again=await renderMotion(timing.dir,{framesDir:join(timing.dir,"reference-frames")});const decodedB=framesMd5(again.out);
saveReference(timing.dir,"timing",again.manifest);
writeFileSync(join(root,"takeone-motion-determinism.json"),JSON.stringify({identical:decodedA===decodedB,frames:360,workers:a.workers,decoded_sha256:createHash("sha256").update(decodedA).digest("hex"),render_s:a.render_s,concat_s:a.concat_s,wall_s:timing.wall_s,timing_pass:timing.wall_s<=15},null,2));
writeFileSync(join(root,"takeone-motion-run1.framemd5"),decodedA);writeFileSync(join(root,"takeone-motion-run2.framemd5"),decodedB);
if(decodedA!==decodedB)throw new Error("decoded determinism gate failed");
if(timing.wall_s>15)throw new Error(`6s/1080p60 wall-time ${timing.wall_s.toFixed(2)} s exceeds 15 s`);
const hero=await render("hero-reveal",Object.keys(states).map((screen,i)=>({pattern:"hero-reveal",d:3,screen,device:i===5?"phone":"browser",title:["Your next launch","Make a task","Find your focus","Keep work moving","Bring everyone along","Clear the deck"][i]!})),{tempo:{bpm:120,phase_s:0,snap:"beat"}});
execFileSync("ffmpeg",["-v","error","-y","-ss","1","-i",hero.out,"-frames:v","1",join(root,"takeone-motion-device-after.png")]);
const regions=Object.keys(states).map((screen,i)=>({id:`r${i}`,screen,rect:i===1?[900,300,760,680]:[320,128,1656,780],from:"user"}));
const tour=await render("zoom-tour",Object.keys(states).map((screen,i)=>({pattern:"zoom-tour",d:5,screen,device:"browser",stops:[{region:`r${i}`,caption:["Launch board","Draft your launch","Task created","Keep work moving","Umer moved it","Done tasks archived"][i]!}]})),{regions});
await render("end-card",Object.keys(states).map(screen=>({pattern:"end-card",d:3.5,screen,logo:"TakeOne",cta:"Make your first take"})));
// Fragment contact sheets are native 1080p, with every state visible at once.
for(const theme of ["editorial","midnight"]) {
  const dir=join(work,`fragments-${theme}`);mkdirSync(dir,{recursive:true});
  const story=validateStoryboard({...raw,theme:{name:theme},screens:sb.screens});
  const {html}=writePage(work,story);
  let page=readFileSync(html,"utf8");
  const fragmentSetup=`window.setup=async()=>{ const stage=$("#stage"); const specs=[${JSON.stringify([{kind:"button",state:"idle"},{kind:"button",state:"hover"},{kind:"button",state:"pressed"},{kind:"input",state:"empty"},{kind:"input",state:"typing"},{kind:"input",state:"filled"},{kind:"chip"},{kind:"toast"},{kind:"feed-row"},{kind:"counter"},{kind:"line-chart"},{kind:"bar-chart"},{kind:"spinner"},{kind:"browser-chrome"},{kind:"phone-chrome"}]).slice(1,-1)}]; specs.forEach((s,i)=>{ const r=h('<div style="position:absolute;overflow:hidden;width:620px;height:196px;left:'+((i%3)*640+20)+'px;top:'+(Math.floor(i/3)*212+14)+'px;padding:28px 12px;background:var(--bg);border:1px solid var(--line);border-radius:var(--radius)"><div style="position:absolute;top:3px;font:18px var(--mono);color:var(--text)">'+s.kind+' '+(s.state??'')+'</div></div>');stage.append(r); const ctx=sceneCtx(620,170,s,''); const el=FRAGMENTS[s.kind](s,ctx); if(s.kind==='feed-row')el.style.fontSize='24px';r.append(el); }); };`;
  page=page.replace('</body>',`<script>${fragmentSetup}</script></body>`);
  const path=join(dir,"sheet.html");writeFileSync(path,page);
  await renderFrames({html:path,width:1920,height:1080,fps:60,frames:1,workers:1,firstFrame:60,framesDir:join(dir,"frames")});
  copyFileSync(join(dir,"frames","000001.png"),join(root,`takeone-motion-fragments-${theme}-after.png`));
}
const rampDir=join(work,"ramp");mkdirSync(rampDir,{recursive:true});
const rampHtml=join(rampDir,"ramp.html");
const basePage=readFileSync(writePage(work,sb).html,"utf8");
writeFileSync(rampHtml,basePage.replace('</body>',`<script>window.setup=async()=>{$('#stage').innerHTML='<svg width="1920" height="1080"><defs><linearGradient id="r"><stop offset="0" stop-color="#202020"/><stop offset="1" stop-color="#dddddd"/></linearGradient></defs><rect width="1920" height="1080" fill="url(#r)"/></svg>';};</script></body>`));
await renderFrames({html:rampHtml,width:1920,height:1080,fps:60,frames:1,workers:1,framesDir:join(rampDir,"frames"),mp4:join(root,"takeone-motion-ramp.mp4")});
copyFileSync(join(rampDir,"frames","000001.png"),join(root,"takeone-motion-ramp-reference.png"));
// Canon proof: compare the viewport to the same master page at shifted times, without encoder loss.
const bento=await render("bento",[{pattern:"hero-reveal",d:6,title:"Make it move",screen:"S1"}],{layout:{kind:"bento",grid:"2x2",master:{d:6,scenes:[{pattern:"hero-reveal",d:8,title:"Make it move",screen:"S1",device:"browser"}]},tiles:[{id:"TL",offset_s:0},{id:"TR",offset_s:.5},{id:"BL",offset_s:1},{id:"BR",offset_s:1.5}]}});
const bentoSb=JSON.parse(readFileSync(join(bento.dir,"storyboard.json"),"utf8"));
const master=validateStoryboard({...bentoSb,output:{...bentoSb.output,out_w:886,out_h:486},layout:{kind:"single"},scenes:bentoSb.layout.master.scenes});
const mdir=join(work,"master");mkdirSync(mdir,{recursive:true});writeFileSync(join(mdir,"storyboard.json"),JSON.stringify(master));const mh=writePage(mdir,master).html;
const bh=writePage(bento.dir,validateStoryboard(bentoSb)).html;
const canon=[];
const tilePositions:Record<string,[number,number]>={TL:[60,44],TR:[974,44],BL:[60,550],BR:[974,550]};
for(const time of [.5,1,2,3]) {
 const bd=join(work,`b${time}`);
 await renderFrames({html:bh,width:1920,height:1080,fps:60,frames:1,workers:1,firstFrame:Math.round(time*60),framesDir:bd});
 for(const tile of bentoSb.layout.tiles) {
  const [x,y]=tilePositions[tile.id]!,master_time=time+tile.offset_s,md=join(work,`m${time}-${tile.id}`);
  await renderFrames({html:mh,width:886,height:486,fps:60,frames:1,workers:1,firstFrame:Math.round(master_time*60),framesDir:md});
  const child = await import("node:child_process");
  const measure = child.spawnSync("ffmpeg",["-v","info","-i",join(bd,"000001.png"),"-i",join(md,"000001.png"),"-lavfi",`[0:v]crop=886:486:${x}:${y}[a];[a][1:v]ssim`,"-f","null","-"],{encoding:"utf8"});
  const score=Number(/All:([\d.]+)/.exec(measure.stderr)?.[1]);if(measure.status!==0||!Number.isFinite(score)||score<.99)throw new Error(`canon SSIM failed for ${tile.id} at ${time} s (master ${master_time} s): ${score}`);
  canon.push({tile:tile.id,time,offset_s:tile.offset_s,master_time,crop:{x,y,width:886,height:486},ssim:score});
 }
}
writeFileSync(join(root,"takeone-motion-canon.json"),JSON.stringify(canon,null,2));
// Observable kerning positions: range advances and final letter placements share the same coordinates.
const ec=join(work,"end-card"),es=validateStoryboard(JSON.parse(readFileSync(join(ec,"storyboard.json"),"utf8")));
const kerning=await withPage(writePage(ec,es).html,1920,1080,b=>b.evaluate(`(async()=>{await __seek(2000);const el=$('.kern'),original=el.firstElementChild,ghost=original.cloneNode(true);const cs=getComputedStyle(el);ghost.style.cssText='position:fixed;left:0;top:0;white-space:pre;font:'+cs.font+';font-kerning:'+cs.fontKerning+';letter-spacing:'+cs.letterSpacing;document.body.append(ghost);const node=ghost.firstChild,r=document.createRange(),x0=ghost.getBoundingClientRect().left;let i=0,j=0,max_error=0;for(const ch of ghost.textContent){r.setStart(node,i);r.setEnd(node,i+ch.length);if(ch.trim()){const expected=r.getBoundingClientRect().left-x0,actual=($$('[data-x]',el)[j++].getBoundingClientRect().left-el.getBoundingClientRect().left)/(el.getBoundingClientRect().width/ghost.getBoundingClientRect().width);max_error=Math.max(max_error,Math.abs(actual-expected));}i+=ch.length;}const static_width=ghost.getBoundingClientRect().width,animated_width=el.offsetWidth;return {max_error,static_width,animated_width,advance_error:Math.abs(static_width-animated_width)};})()`));
writeFileSync(join(root,"takeone-motion-kerning.json"),JSON.stringify(kerning));
if((kerning as {max_error:number;advance_error:number}).max_error>.5 || (kerning as {advance_error:number}).advance_error>.5)throw new Error("kerning advance gate failed");
console.log(JSON.stringify({root,timing:a.render_s+a.concat_s,deterministic:true}));
