import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DEFAULTS, applyOverrides } from "../src/camera/defaults.ts";
import type { Beat, CameraFrame, TakeMeta } from "../src/camera/types.ts";
import { blurGraph, keycapAss, keycapBackdropGraph, keycapMaskAss, keycapCues, keycapObstacles, overlayRegions, shortcutKeys, spotlightAss, spotlightGraph } from "../src/render/overlays.ts";
import { cameraFilter } from "../src/render/camera-filter.ts";
import { motionBlurGraph, shutterPlan } from "../src/render/motion-blur.ts";
import { measureCaptions, renderTake } from "../src/render/render.ts";
import { bandLayout, bandText, takeCaptions } from "../src/render/stage.ts";
import { warpBeats } from "../src/render/pace.ts";
import { hasFfmpeg } from "./helpers.ts";

const beats = (actions: unknown[]): Beat[] => [{id:"b",t0:0,t1:6,anchor_t:0,kind:"shortcut",zones:[],actions}];
const d = {...DEFAULTS,out_w:640,out_h:360,caption_size:24};

test("shortcut validation fails closed on typed text and malformed combos", () => {
  for (const input of [null,42,"a","A","Shift+A","Ctrl+secret","Ctrl+a","Ctrl+{\\N}","Ctrl+S+password",
    "Ctrl+Ctrl+S","Ctrl+", "AltGraph+A", "F1", "Ctrl+F99", "Ctrl+😀"]) assert.equal(shortcutKeys(input),null);
  assert.deepEqual(shortcutKeys("Meta+Ctrl+S"),["Ctrl","Meta","S"]);
  assert.deepEqual(shortcutKeys("Ctrl+K"),["Ctrl","K"]);
});

test("no typed character reaches generated render output, even with injected text fields", () => {
  const unsafe: unknown[] = Array.from("sensitive text!😀", c => ({k:"key",down:true,cls:"char",t:500,char:c,text:c,combo:c}));
  unsafe.push(...["secret","Shift+A","Ctrl+password","Ctrl+{\\N}"].map(combo=>({k:"shortcut",t:500,combo})));
  const blank = keycapAss([],0,6,d);
  assert.equal(keycapAss(beats(unsafe),0,6,d),blank);
  const valid = [{k:"shortcut",t:1000,combo:"Ctrl+K"},{k:"shortcut",t:4000,combo:"Ctrl+S"}];
  assert.equal(keycapAss(beats([...unsafe,...valid]),0,6,d),keycapAss(beats(valid),0,6,d));
});

test("keycaps deduplicate beats, trim and follow the squeezed output clock", () => {
  const b=beats([{k:"shortcut",t:1000,combo:"Ctrl+K"},{k:"shortcut",t:8000,combo:"Ctrl+S"}]);
  const warped=warpBeats([...b,...b],2,[{a:1,b:5}],4);
  const cues=keycapCues(warped,2,5,d);
  assert.equal(cues.length,1);
  assert.equal(cues[0]!.t0,3);
  assert.deepEqual(cues[0]!.keys,["Ctrl","S"]);
});

test("region validation and timing preserve privacy coverage across trims and speed changes", () => {
  const meta={width:640,height:360,blur:[{t:1,d:5,rect:[20,30,100,60] as [number,number,number,number]}]};
  assert.deepEqual(overlayRegions(meta,"blur",t=>(t-2)/2,2,5),[{t0:0,t1:1.5,rect:[20,30,100,60]}]);
  for(const rect of [[-1,0,20,20],[600,0,100,20],[0,0,0,20],[0,0,NaN,20]]) {
    assert.throws(()=>overlayRegions({...meta,blur:[{t:0,d:1,rect:rect as [number,number,number,number]}]},"blur",t=>t,0,5),/invalid blur\[0\]/);
  }
});

test("spotlights feather rounded holes, preserve overlap and restore the frame outside the interval", {skip:!hasFfmpeg()},()=>{
  const dir=mkdtempSync(`${process.cwd()}/tmp-spotlight-`);
  try {
    const regions=[{t0:0,t1:0.5,rect:[50,50,160,100] as [number,number,number,number]},
      {t0:0,t1:0.5,rect:[150,50,160,100] as [number,number,number,number]}];
    writeFileSync(`${dir}/spot.ass`,spotlightAss(regions,640,360,d));
    const graph=`[0:v]format=yuv420p[spotlightInput];${spotlightGraph(regions,640,360,1,d,`${dir}/spot.ass`)};[screen]format=gray[out]`;
    const pixels=execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=white:s=640x360:r=10:d=1",
      "-filter_complex",graph,"-map","[out]","-f","rawvideo","-"],{maxBuffer:3_000_000});
    const value=(x:number,y:number,frame=2)=>pixels[frame*640*360+y*640+x]!;
    assert.ok(value(20,20)>140 && value(20,20)<190);
    for(const x of [80,180,280]) assert.ok(value(x,90)>240,`hole x=${x}`);
    assert.ok(value(50,50)<value(62,62),"rounded corner remains dim");
    assert.ok(value(50,90)>value(44,90) && value(50,90)<value(60,90),"soft edge");
    assert.ok(value(20,20,8)>240,"outside the interval the source returns");
    if(process.env.TAKEONE_OVERLAY_EVIDENCE_DIR) {
      mkdirSync(process.env.TAKEONE_OVERLAY_EVIDENCE_DIR,{recursive:true});
      execFileSync("ffmpeg",["-y","-v","error","-f","rawvideo","-pixel_format","gray","-video_size","640x360","-framerate","10","-i","-","-vf","select=eq(n\\,2)","-frames:v","1",`${process.env.TAKEONE_OVERLAY_EVIDENCE_DIR}/takeone-overlays-static.png`],{input:pixels});
    }
    const edge=[{t0:0,t1:1,rect:[0,0,200,100] as [number,number,number,number]}];
    writeFileSync(`${dir}/edge.ass`,spotlightAss(edge,640,360,d,{
      frames:[{t:0,x:40,y:40,w:320,h:180}],
      shutter:shutterPlan([{t:0,x:40,y:40,w:320,h:180}],640,360,d),
      stage:{w:640,h:360,baseW:640,baseH:360,screenX:0,screenY:0,restScale:1},
    }));
    const edgePixels=execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=white:s=640x360:r=60:d=1",
      "-filter_complex",`[0:v]format=yuv420p[spotlightInput];${spotlightGraph(edge,640,360,1,d,`${dir}/edge.ass`)};[screen]crop=320:180:40:40,scale=640:360,format=gray[out]`,
      "-map","[out]","-frames:v","1","-f","rawvideo","-"],{maxBuffer:1_000_000});
    assert.ok(edgePixels[40*640+1]!<190,"zoomed hole stays inside output frame");
    assert.ok(edgePixels[40*640+30]!>240,"zoomed subject remains bright");
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("spotlight holes preserve source colour on every RGB channel", {skip:!hasFfmpeg()},()=>{
  const dir=mkdtempSync(`${process.cwd()}/tmp-spotlight-colour-`);
  try {
    const regions=[{t0:0,t1:0.5,rect:[50,50,200,100] as [number,number,number,number]}];
    writeFileSync(`${dir}/mask.ass`,spotlightAss(regions,640,360,d));
    const pixels=execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=c=0xe84020:s=640x360:r=60:d=1",
      "-filter_complex",`[0:v]format=yuv420p[spotlightInput];${spotlightGraph(regions,640,360,1,d,`${dir}/mask.ass`)};[screen]format=rgb24[out]`,
      "-map","[out]","-f","rawvideo","-"],{maxBuffer:45_000_000});
    const at=(frame:number,x:number,y:number,c:number)=>pixels[(frame*640*360+y*640+x)*3+c]!;
    for(let c=0;c<3;c++) assert.ok(Math.abs(at(12,150,100,c)-at(48,150,100,c))<=2,`preserved channel ${c}: ${at(12,150,100,c)} vs ${at(48,150,100,c)}, bytes ${pixels.length}`);
    assert.ok(at(12,20,20,0)<at(48,20,20,0)-40,"the coloured backdrop is dimmed");
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("60fps moving spotlights stay inset on every edge through the real camera", {skip:!hasFfmpeg()},()=>{
  const dir=mkdtempSync(`${process.cwd()}/tmp-spotlight-pan-`);
  try {
    const regions=[{t0:0,t1:0.2,rect:[0,0,640,360] as [number,number,number,number]}];
    for(const [dx,dy] of [[10,10],[-10,-10]]) {
      const frames=Array.from({length:12},(_,i)=>({t:i/60,x:160+i*dx!,y:90+i*dy!/2,w:320,h:180}));
      writeFileSync(`${dir}/mask.ass`,spotlightAss(regions,640,360,d,{frames,shutter:shutterPlan(frames,640,360,d),
        stage:{w:640,h:360,baseW:640,baseH:360,screenX:0,screenY:0,restScale:1}}));
      const camera=motionBlurGraph(frames,shutterPlan(frames,640,360,d),640,360,d).replace('[c4]','[screen]');
      const graph=`[0:v]format=yuv420p[spotlightInput];${spotlightGraph(regions,640,360,0.2,d,`${dir}/mask.ass`)};${camera};[camera]format=gray[out]`;
      const pixels=execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=white:s=640x360:r=60:d=0.2",
        "-filter_complex_threads","1","-filter_complex",graph,"-map","[out]","-fps_mode","passthrough","-f","rawvideo","-"],{maxBuffer:3_000_000});
      assert.equal(pixels.length,12*640*360);
      if(process.env.TAKEONE_OVERLAY_EVIDENCE_DIR && dx===10) {
        execFileSync("ffmpeg",["-y","-v","error","-f","rawvideo","-pixel_format","gray","-video_size","640x360","-framerate","60","-i","-","-c:v","libx264","-crf","12",`${process.env.TAKEONE_OVERLAY_EVIDENCE_DIR}/takeone-overlays-ordinary-pan.mp4`],{input:pixels});
      }
      for(let i=0;i<12;i++) {
        const at=(x:number,y:number)=>pixels[i*640*360+y*640+x]!;
        for(const [x,y] of [[1,180],[638,180],[320,1],[320,358]]) assert.ok(at(x!,y!)<190,`frame ${i}, edge ${x},${y}: ${at(x!,y!)}`);
        assert.ok(at(320,180)>240,`frame ${i}: sharp subject`);
      }
      const marker=execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=black:s=640x360:r=60:d=0.2,drawbox=x=300:y=0:w=2:h=360:c=white:t=fill",
        "-filter_threads","1","-vf",cameraFilter(frames,640,360,d),"-pix_fmt","gray","-f","rawvideo","-"],{maxBuffer:3_000_000});
      const peak=(i:number)=>{const row=marker.subarray(i*640*360+180*640,i*640*360+181*640);return row.indexOf(Math.max(...row));};
      assert.ok(Math.abs(peak(4)-peak(3))>=19,"the camera retains its ten-source-pixel pan");
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("saved Tidewater rapid pan clips the hole inside every shutter exposure", {skip:!hasFfmpeg()},()=>{
  const dir=mkdtempSync(`${process.cwd()}/tmp-spotlight-exposure-`);
  try {
    const saved=JSON.parse(readFileSync("docs/quality-evidence/t1-pm-4/tidewater-candidate-camera.json","utf8")) as CameraFrame[];
    const frames=saved.slice(2300,2307).map((f,i)=>({...f,t:i/60}));
    assert.ok(Math.abs(frames[3]!.x-frames[2]!.x)>43,"reported 38.3667–38.3833s pan is present");
    const settings={...DEFAULTS};
    const plan=shutterPlan(frames,3840,2160,settings);
    const regions=[{t0:0,t1:frames.length/60,rect:[0,0,3840,2160] as [number,number,number,number]}];
    writeFileSync(`${dir}/mask.ass`,spotlightAss(regions,3840,2160,settings,{frames,shutter:plan,
      stage:{w:3840,h:2160,baseW:3840,baseH:2160,screenX:0,screenY:0,restScale:1}}));
    const graph=`[0:v]format=yuv420p[spotlightInput];${spotlightGraph(regions,3840,2160,frames.length/60,settings,`${dir}/mask.ass`)};`
      +motionBlurGraph(frames,plan,3840,2160,settings).replace('[c4]','[screen]')+`;[camera]format=gray[out]`;
    const pixels=execFileSync("ffmpeg",["-v","error","-f","lavfi","-i",`color=white:s=3840x2160:r=60:d=${frames.length/60}`,
      "-filter_complex_threads","1","-filter_complex",graph,"-map","[out]","-fps_mode","passthrough","-f","rawvideo","-"],{maxBuffer:20_000_000});
    assert.equal(pixels.length,frames.length*1920*1080);
    for(let i=0;i<frames.length;i++) {
      const at=(x:number,y:number)=>pixels[i*1920*1080+y*1920+x]!;
      for(const [x,y] of [[1,540],[1918,540],[960,1],[960,1078]]) assert.ok(at(x!,y!)<190,`rapid pan frame ${i}, edge ${x},${y}: ${at(x!,y!)}`);
      assert.ok(at(960,540)>240,`rapid pan frame ${i} subject remains sharp`);
    }
    const evidence=process.env.TAKEONE_OVERLAY_EVIDENCE_DIR;
    if(evidence) {
      mkdirSync(evidence,{recursive:true});
      writeFileSync(`${evidence}/takeone-overlays-rapid-pan-samples.json`,JSON.stringify({savedFrames:[2300,2306],times:frames.map((_,i)=>saved[2300+i]!.t),frames,metrics:plan.metrics},null,2));
      execFileSync("ffmpeg",["-y","-v","error","-f","rawvideo","-pixel_format","gray","-video_size","1920x1080","-framerate","60","-i","-","-c:v","libx264","-crf","12",`${evidence}/takeone-overlays-rapid-pan.mp4`],{input:pixels});
      execFileSync("ffmpeg",["-y","-v","error","-f","rawvideo","-pixel_format","gray","-video_size","1920x1080","-framerate","60","-i","-","-vf","select=eq(n\\,3)","-frames:v","1",`${evidence}/takeone-overlays-rapid-pan.png`],{input:pixels});
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("caption-enabled renders clip spotlight holes to the sampled card surface", {skip:!hasFfmpeg()},async()=>{
  const dir=mkdtempSync(`${process.cwd()}/tmp-spotlight-band-`);
  try {
    const settings={...d,fade_s:0,establish_s:0,outro_s:0,preset:"ultrafast",max_upscale:3};
    const meta:TakeMeta={width:640,height:360,trim_end:2,captions:[{t:0,d:2,text:"Caption"}],
      spotlight:[{t:0,d:2,rect:[0,0,640,360]}]};
    const b:Beat[]=[{id:"focus",t0:0,t1:2,anchor_t:0.3,kind:"shortcut",actions:[],
      zones:[{name:"subject",type:"act",bbox:[220,120,180,100]}]}];
    mkdirSync(`${dir}/analysis`);
    writeFileSync(`${dir}/take.json`,JSON.stringify(meta));
    writeFileSync(`${dir}/analysis/beats.json`,JSON.stringify(b));
    writeFileSync(`${dir}/analysis/decisions.jsonl`,JSON.stringify({beat:"focus",A:"subject",L:3,p:0,K:0,conf:1,decided_by:"test"}));
    execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=white:s=640x360:r=60:d=2","-c:v","libvpx-vp9","-lossless","1",`${dir}/screen.webm`]);
    const {out}=await renderTake(dir,settings);
    const frames=JSON.parse(readFileSync(`${dir}/camera.json`,"utf8")) as CameraFrame[];
    const index=frames.findIndex(f=>f.t>1 && f.x>20 && f.y>20 && f.x+f.w<620 && f.y+f.h<340);
    assert.ok(index>=0,`the production camera zooms into the source: ${JSON.stringify(frames[60])}`);
    const captions=takeCaptions(meta,t=>t,2);
    let text=bandText(captions,[],settings);
    let ink=await measureCaptions(dir,captions,text,true);
    const fitted=bandText(captions,ink,text);
    if(fitted!==text) ink=await measureCaptions(dir,captions,fitted,true);
    text=fitted;
    const st=bandLayout(640,360,text,captions,ink)!.stage;
    const pixels=execFileSync("ffmpeg",["-v","error","-i",out,"-vf",`select=eq(n\\,${index}),format=gray`,"-frames:v","1","-f","rawvideo","-"],{maxBuffer:1_000_000});
    const at=(x:number,y:number)=>pixels[y*640+x]!;
    const cx=st.screenX+Math.floor(st.baseW/2),cy=st.screenY+Math.floor(st.baseH/2);
    for(const [x,y] of [[st.screenX+1,cy],[st.screenX+st.baseW-2,cy],[cx,st.screenY+1],[cx,st.screenY+st.baseH-2]]) {
      assert.ok(at(x!,y!)<190,`card edge ${x},${y}: ${at(x!,y!)}`);
    }
    assert.ok(at(cx,cy)>240,"subject inside the card remains sharp");
    if(process.env.TAKEONE_OVERLAY_EVIDENCE_DIR) execFileSync("ffmpeg",["-y","-v","error","-i",out,"-vf",`select=eq(n\\,${index})`,"-frames:v","1",`${process.env.TAKEONE_OVERLAY_EVIDENCE_DIR}/takeone-overlays-caption-crop.png`]);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("rendered blur removes local high-frequency detail only during its interval", {skip:!hasFfmpeg()},()=>{
  const regions=[{t0:0.4,t1:0.8,rect:[100,100,100,100] as [number,number,number,number]}];
  const graph=`[0:v]format=yuv420p[region0];${blurGraph(regions)};[region1]format=gray[out]`;
  const pixels=execFileSync("ffmpeg",["-v","error","-f","lavfi","-i",
    "nullsrc=s=640x360:r=10:d=1,geq=lum='mod(X+Y,2)*255':cb=128:cr=128", "-filter_complex",graph,
    "-map","[out]","-f","rawvideo","-"],{maxBuffer:3_000_000});
  const contrast=(frame:number,x:number,y:number)=>Math.abs(pixels[frame*640*360+y*640+x]!-pixels[frame*640*360+y*640+x+1]!);
  assert.ok(contrast(1,140,140)>200);
  assert.ok(contrast(5,140,140)<10);
  assert.ok(contrast(5,40,40)>200);
  assert.ok(contrast(9,140,140)>200);
});

test("a narrow coloured blur has no corrupt chroma slices at render thread count", {skip:!hasFfmpeg()},()=>{
  const graph=`[0:v]format=yuv420p[region0];${blurGraph([{t0:0,t1:1,rect:[10,10,290,46]}])};[region1]format=rgb24[out]`;
  const pixels=execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=c=0x33443d:s=640x360:d=1",
    "-filter_complex_threads","32","-filter_complex",graph,"-map","[out]","-frames:v","1","-f","rawvideo","-"],{maxBuffer:1_000_000});
  for(let y=12;y<54;y++) for(let x=12;x<298;x++){
    const i=(y*640+x)*3;
    const delta=Math.max(...[0,1,2].map(c=>Math.abs(pixels[i+c]!-pixels[(100*640+100)*3+c]!)));
    assert.ok(delta<5,`corrupt blur pixel ${x},${y}: delta=${delta}`);
  }
});

let hasOcr=false;
try {execFileSync("tesseract",["--version"],{stdio:"ignore"});hasOcr=true;} catch { /* Optional local visual check. */ }
test("keycaps are OCR legible at both shortcut holds", {skip:!hasFfmpeg()||!hasOcr},()=>{
  const dir=mkdtempSync(`${process.cwd()}/tmp-keycap-ocr-`);
  try {
    writeFileSync(`${dir}/keys.ass`,keycapAss(beats([
      {k:"shortcut",t:500,combo:"Ctrl+K"},{k:"shortcut",t:2500,combo:"Ctrl+S"}]),0,5,DEFAULTS));
    for(const [t,key] of [[1,"K"],[3,"S"]] as const){
      const png=`${dir}/${key}.png`;
      execFileSync("ffmpeg",["-y","-v","error","-f","lavfi","-i","color=black:s=1920x1080:r=10:d=4",
        "-vf",`ass=${dir}/keys.ass:fontsdir=resources/fonts,select=gte(t\\,${t}),crop=650:180:635:710,format=gray,lut=y='if(gt(val,160),0,255)'`,"-frames:v","1",png]);
      const text=execFileSync("tesseract",[png,"stdout","--psm","7"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]});
      assert.equal(text.trim().replace(/\s+/g," "),`Ctrl + ${key}`);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("keycap glass blurs only its backdrop and stays translucent on light and dark", {skip:!hasFfmpeg()},()=>{
  const dir=mkdtempSync(`${process.cwd()}/tmp-keycap-glass-`);
  try {
    const b=beats([{k:"shortcut",t:0,combo:"Ctrl+K"}]);
    const cue=keycapCues(b,0,2,d)[0]!;
    writeFileSync(`${dir}/mask.ass`,keycapMaskAss(b,0,2,d));
    writeFileSync(`${dir}/keys.ass`,keycapAss(b,0,2,d));
    const graph=`[0:v]format=yuv420p[keycapInput];${keycapBackdropGraph(2,d,`${dir}/mask.ass`)};[keycapOutput]ass=${dir}/keys.ass:fontsdir=resources/fonts,select=gte(t\\,1),format=gray[out]`;
    const pixels=(source:string)=>execFileSync("ffmpeg",["-v","error","-f","lavfi","-i",source,
      "-filter_complex",graph,"-map","[out]","-frames:v","1","-f","rawvideo","-"],{maxBuffer:1_000_000});
    const x=Math.round(cue.cx),y=Math.round(cue.cy+cue.h*0.35),at=y*640+x;
    const light=pixels("color=white:s=640x360:r=60:d=2"),dark=pixels("color=black:s=640x360:r=60:d=2");
    assert.ok(light[at]!-dark[at]!>60,"the backdrop shows through the glass fill");
    const pattern=pixels("nullsrc=s=640x360:r=60:d=2,geq=lum='mod(X+Y,2)*255':cb=128:cr=128");
    assert.ok(Math.abs(pattern[at]!-pattern[at+1]!)<10,"detail behind the dock is frosted");
    assert.ok(Math.abs(pattern[30*640+30]!-pattern[30*640+31]!)>200,"detail outside the dock stays sharp");
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("platform labels are explicit and validated", () => {
  const b=beats([{k:"shortcut",t:1000,combo:"Ctrl+Alt+Meta+Shift+K"}]);
  assert.deepEqual(keycapCues(b,0,4,{...d,keycap_style:"mac"})[0]!.keys,["⌃","⌥","⇧","⌘","K"]);
  assert.deepEqual(keycapCues(b,0,4,d)[0]!.keys,["Ctrl","Alt","Meta","Shift","K"]);
  assert.equal(applyOverrides({keycap_style:"mac"}).keycap_style,"mac");
  assert.throws(()=>applyOverrides({keycap_style:"other"}),/invalid --set/);
});

test("placement clears focus and captions for the entire hold, or hides in a full frame",()=>{
  const b=beats([{k:"shortcut",t:1000,combo:"Ctrl+K"}]);
  const preferred=keycapCues(b,0,4,d)[0]!;
  assert.equal(preferred.cx,d.out_w/2);
  assert.ok(preferred.cy > d.out_h*0.65);
  const obstacles=[{t0:1,t1:3.5,rect:[200,210,240,80] as [number,number,number,number]},
    {t0:1,t1:3.5,rect:[0,300,640,60] as [number,number,number,number]}];
  assert.equal(keycapCues(b,0,4,d,obstacles).length,0,"occupied dock hides instead of floating over content");
  assert.equal(keycapCues(b,0,4,d,[{t0:1,t1:4,rect:[0,0,640,360]}]).length,0);
});

test("focus obstacles follow source regions through the actual stage camera",()=>{
  const b=beats([]);
  b[0]!.zones=[{name:"focus",type:"act",bbox:[10,20,100,50]}];
  const obstacles=keycapObstacles(b,[{beat:"b",A:"focus",L:1,p:0,K:0,conf:1,decided_by:"test"}],
    [{t:1,x:30,y:40,w:320,h:180}],{w:700,h:400,baseW:640,baseH:360,screenX:40,screenY:30,restScale:1},
    0,[],[],d);
  assert.deepEqual(obstacles[0]!.rect,[40,20,200,100]);
});


test("top caption ink preserves the bottom dock while bottom ink and subjects stay protected",()=>{
  const b=beats([{k:"shortcut",t:1000,combo:"Ctrl+K"}]);
  const captions=[{t0:0,t1:4,text:"Caption",title:false}];
  const stage={w:640,h:360,baseW:640,baseH:360,screenX:0,screenY:0,restScale:1};
  const top=keycapObstacles(b,[],[],stage,0,captions,[{w:160,h:24}],d,true);
  const preferred=keycapCues(b,0,4,d)[0]!;
  assert.deepEqual(keycapCues(b,0,4,d,top),[preferred],"top ink leaves a clear bottom dock unchanged");
  const bottom=keycapObstacles(b,[],[],stage,0,[{...captions[0]!,position:"bottom"}],[{w:160,h:24}],d,true);
  const cue=keycapCues(b,0,4,d,[...top,...bottom])[0]!;
  assert.ok(cue.cy>0 && cue.cy<preferred.cy);
  assert.ok(cue.cy+cue.h/2+cue.size*0.75<bottom[0]!.rect[1],"bottom ink has clearance throughout the spring");
  assert.equal(keycapCues(b,0,4,d,[...top,{t0:1,t1:4,rect:[0,preferred.cy-40,640,80]}]).length,0);
  const tallTop=keycapObstacles(b,[],[],stage,0,captions,[{w:160,h:260}],d,true);
  assert.equal(keycapCues(b,0,4,d,tallTop).length,0,"top ink remains a collision obstacle");
});
