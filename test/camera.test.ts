import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { frame, moveDuration, solveCamera, zMax } from "../src/camera/solver.ts";
import { renderTake, sendcmd } from "../src/render/render.ts";
import { applyOverrides } from "../src/camera/defaults.ts";
import type { Beat, Decision } from "../src/camera/types.ts";
const zone=(name:string,bbox:[number,number,number,number])=>({name,type:"act" as const,bbox});
test("framing obeys aspect, source and zoom limits at L0-L3",()=>{
 assert.equal(zMax(3840),2.5); for(let L=0;L<=3;L++){const s=frame(zone("x",[3600,1900,100,100]),L,3840,2160);assert.ok(s.z>=1&&s.z<=2.5);assert.ok(s.cx>=0&&s.cx<=3840);assert.ok(s.cy>=0&&s.cy<=2160);}
});
test("move timing and sendcmd syntax",()=>{assert.equal(moveDuration(0),.6);assert.ok(moveDuration(100)<=1.4);assert.match(sendcmd([{t:0,x:0,y:0,w:3840,h:2160}]),/^0\.000000 \[enter\] crop@a w 3840, crop@a h 2160, crop@a x 0, crop@a y 0;\n$/);});
test("resamples frames with continuous log zoom and stable output dimensions",()=>{
 const beats:Beat[]=[{id:"a",t0:.5,t1:2,anchor_t:1,actions:[],zones:[zone("one",[2800,1300,200,100])],kind:"click"},{id:"b",t0:2,t1:3,anchor_t:2.5,actions:[],zones:[zone("two",[500,400,200,100])],kind:"type"}];
 const ds:Decision[]=[{beat:"a",A:"one",L:3,p:0,K:1,conf:1,decided_by:"test"},{beat:"b",A:"two",L:2,p:0,K:1,conf:1,decided_by:"test"}];
 const f=solveCamera(beats,ds,{width:3840,height:2160,trim_start:0,trim_end:4});assert.equal(f.length,121);assert.ok(f.every(x=>Math.abs(x.w/x.h-16/9)<1e-9&&x.w<=3840&&x.h<=2160));
 for(let i=1;i<f.length;i++)assert.ok(Math.abs(Math.log(f[i].w/f[i-1].w))<.5);
});
test("scroll beats never create camera targets and overrides validate",()=>{const b:Beat={id:"s",t0:1,t1:2,anchor_t:1,actions:[],zones:[zone("z",[10,10,20,20])],kind:"scroll"};const f=solveCamera([b],[{beat:"s",A:"z",L:3,p:1,K:2,conf:1,decided_by:"test"}],{width:3840,height:2160,trim_start:0,trim_end:2});assert.equal(f[60].w,3840);assert.equal(applyOverrides({fps:24}).fps,24);assert.throws(()=>applyOverrides({bogus:1}));});
test("deadzone avoids a redundant move and dwell/rate limits keep sparse shots",()=>{const mk=(id:string,t:number,x:number,K:0|1|2):Beat=>({id,t0:t,t1:t+1,anchor_t:t,actions:[],zones:[zone(id,[x,900,160,80])],kind:"click"});const bs=[mk("a",2,2500,1),mk("b",2.4,2510,1),mk("c",3,500,2),mk("d",4,3400,0),mk("e",5,100,0),mk("f",6,2000,0)];const ds=bs.map(b=>({beat:b.id,A:b.id,L:3 as const,p:0,K:(b.id==="c"?2:0) as 0|1|2,conf:1,decided_by:"test"}));const frames=solveCamera(bs,ds,{width:3840,height:2160,trim_start:0,trim_end:8});assert.ok(frames.every((f,i)=>i===0||Math.abs(Math.log(f.w/frames[i-1].w))<.5));});
test("real synthetic 4K clip renders H.264 at expected duration",{timeout:120000},async()=>{const dir=await mkdtemp(join(tmpdir(),"takeone-render-"));try{await mkdir(join(dir,"analysis"));execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=c=blue:s=3840x2160:r=30:d=2","-c:v","libvpx-vp9","-deadline","realtime","-cpu-used","8","-y",join(dir,"screen.webm")]);await writeFile(join(dir,"take.json"),JSON.stringify({id:"fixture",width:3840,height:2160,trim_start:0,trim_end:2}));await writeFile(join(dir,"analysis/beats.json"),JSON.stringify([{id:"b",t0:.2,t1:1.5,anchor_t:.6,actions:[],zones:[zone("button",[2600,1200,300,160])],kind:"click"}]));await writeFile(join(dir,"analysis/decisions.jsonl"),JSON.stringify({beat:"b",A:"button",L:3,p:0,K:1,conf:1,decided_by:"test"})+"\n");const out=await renderTake(dir);const info=execFileSync("ffprobe",["-v","error","-select_streams","v:0","-show_entries","stream=width,height,nb_frames,codec_name","-of","csv=p=0",out],{encoding:"utf8"});assert.match(info,/h264/);assert.match(info,/1920,1080,60/);}finally{await rm(dir,{recursive:true,force:true});}});
