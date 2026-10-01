import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DEFAULTS } from "../src/camera/defaults.ts";
import type { Beat } from "../src/camera/types.ts";
import { blurGraph, keycapAss, overlayRegions, shortcutKeys, spotlightAss } from "../src/render/overlays.ts";
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
  const ass=keycapAss(warped,2,5,d);
  const dialogues=ass.split("\n").filter(l=>l.startsWith("Dialogue:"));
  assert.equal(dialogues.length,4); // only S, two keycaps, each with shape and text
  assert.ok(dialogues.every(l=>l.includes(",0:00:03.00,")));
});

test("region validation and timing preserve privacy coverage across trims and speed changes", () => {
  const meta={width:640,height:360,blur:[{t:1,d:5,rect:[20,30,100,60] as [number,number,number,number]}]};
  assert.deepEqual(overlayRegions(meta,"blur",t=>(t-2)/2,2,5),[{t0:0,t1:1.5,rect:[20,30,100,60]}]);
  for(const rect of [[-1,0,20,20],[600,0,100,20],[0,0,0,20],[0,0,NaN,20]]) {
    assert.throws(()=>overlayRegions({...meta,blur:[{t:0,d:1,rect:rect as [number,number,number,number]}]},"blur",t=>t,0,5),/invalid blur\[0\]/);
  }
});

test("rendered spotlights preserve holes and dim only the rest, including overlapping regions", {skip:!hasFfmpeg()},()=>{
  const dir=mkdtempSync(`${process.cwd()}/tmp/spotlight-`);
  try {
    writeFileSync(`${dir}/spot.ass`,spotlightAss([
      {t0:0,t1:2,rect:[50,50,160,100]}, {t0:0,t1:2,rect:[150,50,160,100]}],640,360,d));
    const pixels=execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=white:s=640x360:d=1",
      "-vf",`ass=${dir}/spot.ass,format=gray`,"-frames:v","1","-f","rawvideo","-"],{maxBuffer:1_000_000});
    assert.ok(pixels[20*640+20]!<180);
    for(const x of [80,180,280]) assert.ok(pixels[90*640+x]!>240,`hole x=${x}`);
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
  const dir=mkdtempSync(`${process.cwd()}/tmp/keycap-ocr-`);
  try {
    writeFileSync(`${dir}/keys.ass`,keycapAss(beats([
      {k:"shortcut",t:500,combo:"Ctrl+K"},{k:"shortcut",t:2500,combo:"Ctrl+S"}]),0,5,DEFAULTS));
    for(const [t,key] of [[1,"K"],[3,"S"]] as const){
      const png=`${dir}/${key}.png`;
      execFileSync("ffmpeg",["-y","-v","error","-f","lavfi","-i","color=black:s=1920x1080:r=10:d=4",
        "-vf",`ass=${dir}/keys.ass,select=gte(t\\,${t}),crop=1920:200:0:0`,"-frames:v","1",png]);
      const text=execFileSync("tesseract",[png,"stdout","--psm","6"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]});
      assert.equal(text.trim().replace(/\s+/g," "),`Ctrl ${key}`);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
