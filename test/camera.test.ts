import test from "node:test";
import assert from "node:assert/strict";
import { frame, moveDuration, solveCamera, zMax } from "../src/camera/solver.ts";
import { sendcmd } from "../src/render/render.ts";
import type { Beat, Decision } from "../src/camera/types.ts";
test("camera framing, clamps, timing and sendcmd",()=>{
 assert.equal(zMax(3840),2.5); assert.equal(moveDuration(0),0.6);
 const s=frame({name:"x",type:"act",bbox:[1800,900,100,60]},3,3840,2160); assert.ok(s.z>=1&&s.z<=2.5);
 assert.match(sendcmd([{t:0,x:0,y:0,w:3840,h:2160}]),/0\.000000 \[enter\].*crop@a/);
 const beats:Beat[]=[{id:"b",t0:1,t1:2,anchor_t:1.5,actions:[],zones:[{name:"x",type:"act",bbox:[1800,900,100,60]}],kind:"click"}];
 const decisions:Decision[]=[{beat:"b",A:"x",L:2,p:0,K:1,conf:1,decided_by:"test"}];
 const frames=solveCamera(beats,decisions,{width:3840,height:2160,trim_start:0,trim_end:3}); assert.equal(frames.length,91); assert.ok(frames.every(f=>Math.abs(f.w/f.h-1920/1080)<1e-9));
});
