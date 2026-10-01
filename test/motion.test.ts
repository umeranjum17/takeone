import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { motionPage } from "../src/motion/page.ts";
import { INGEST_CLOCK } from "../src/motion/ingest-clock.ts";
import assert from "node:assert/strict";
import { validateStoryboard } from "../src/motion/storyboard.ts";
import { beatTime, fontCovers, lintCss } from "../src/motion/lint.ts";
import { parseMotionArgs, planStoryboard } from "../src/motion/cli.ts";
import { bitmapSize, heroSize } from "../src/motion/geometry.ts";
import { motionTokens } from "../src/motion/theme.ts";
import { fontFile } from "../src/motion/theme.ts";
import { planSpeeds } from "../src/motion/blur.ts";
import { averageRaw, decodePng, encodePng } from "../src/motion/png.ts";
import { parseStateOp } from "../src/motion/ingest.ts";
import { sceneCameras } from "../src/motion/camera.ts";

const board=()=>({version:1,source:{kind:"image",files:["board.png"]},theme:{name:"editorial"},screens:{S1:{file:"board.png",width:2560,height:1440}},scenes:[{pattern:"hero-reveal",d:3,screen:"S1",title:"Launch"}],regions:[]});
test("validator rejects off-beat cuts and snaps a one-frame drift",()=>{
  const tempo={bpm:120,phase_s:0,snap:"beat" as const};
  assert.throws(()=>beatTime(1.1,tempo,60,"cut"),/off the beat/);
  assert.equal(beatTime(1+1/60,tempo,60,"cut"),1);
  assert.equal(beatTime(1.25,{...tempo,snap:"half"},60,"swap"),1.25);
  assert.throws(()=>validateStoryboard({...board(),tempo,scenes:[{pattern:"hero-reveal",d:3.1}]}),/off the beat/);
  assert.equal(validateStoryboard({...board(),tempo,scenes:[{pattern:"hero-reveal",d:3+1/60}]}).scenes[0]!.d,3);
});
test("pattern CSS rejects nondeterministic gradients",()=>{
  assert.throws(()=>lintCss(".tile { background:linear-gradient(#000,#fff) }"),/CSS gradients/);
  assert.throws(()=>lintCss(".tile { background: radial-gradient (#000,#fff) }"),/CSS gradients/);
  lintCss('<svg><linearGradient id="g"></linearGradient></svg>');
});
test("bundled font glyph lint fails instead of silently substituting",()=>{
  assert.equal(fontCovers(fontFile("Instrument Serif")!,"TakeOne AV"),true);
  assert.equal(fontCovers(fontFile("Instrument Serif")!,"\u{10ffff}"),false);
  assert.throws(()=>validateStoryboard({...board(),scenes:[{pattern:"hero-reveal",d:3,title:"\u{10ffff}"}]}),/missing glyph/);
});
test("bento canon and pinwheel parse from JSON with bounded timelines",()=>{
  const master={d:6,scenes:[{pattern:"hero-reveal",d:6,title:"Launch"}]};
  const b=validateStoryboard({...board(),layout:{kind:"bento",grid:"2x2",master,tiles:["TL","TR","BL","BR"].map((id,i)=>({id,offset_s:i*.5}))}});
  assert.equal(b.layout.kind,"bento");
  assert.throws(()=>validateStoryboard({...board(),layout:{kind:"bento",grid:"2x2",master,tiles:[]}}),/TL/);
  validateStoryboard({...board(),layout:{kind:"bento",grid:"pinwheel-3x2",tiles:Object.fromEntries(["A","B","C","D"].map(id=>[id,master.scenes]))}});
});
test("subframe schedule bounds ghost spacing and codec averages deterministically",()=>{
  const p=planSpeeds([0,36,80,36,0],60);
  assert.equal(p.metrics.blurredFrames,3);assert.ok(p.metrics.maxSamples>=24);assert.ok(p.metrics.maxSpacingPx<=2);
  const a={width:1,height:1,channels:3 as const,data:new Uint8Array([0,100,200])};
  const b={...a,data:new Uint8Array([1,200,255])};
  const mean=averageRaw([a,b]);assert.deepEqual([...mean.data],[1,150,228]);
  assert.deepEqual(decodePng(encodePng(mean)),mean);
});
test("DOM operations parse selectors and quoted text without executing commands",()=>{
  assert.deepEqual(parseStateOp('type #title "Draft launch announcement"'),["type","#title","Draft launch announcement"]);
  assert.deepEqual(parseStateOp('drag #card → #lane'),["drag","#card","#lane"]);
  assert.throws(()=>parseStateOp('execute anything'),/invalid/);
});
test("camera tour emits native-bounded smooth paths and checks hold floor",()=>{
  const sb=validateStoryboard({...board(),regions:[{id:"r1",rect:[900,300,760,620],screen:"S1",from:"user"}],scenes:[{pattern:"zoom-tour",d:6,screen:"S1",stops:[{region:"r1",caption:"Launch task"}]}]});
  const frames=sceneCameras(sb)["0"]!;assert.equal(frames.length,361);
  assert.ok(frames.every(f=>f.w>=1248 && f.x>=-1e-8 && f.x+f.w<=2560+1e-8));
  assert.equal(frames[0]!.w,2560);
});

test("fragment reading floor and states are validated",()=>{
  assert.throws(()=>validateStoryboard({...board(),scenes:[{pattern:"fragment",kind:"feed-row",d:1}]}),/reading-time floor/);
  assert.throws(()=>validateStoryboard({...board(),scenes:[{pattern:"fragment",kind:"button",state:"missing",d:3}]}),/idle, hover, pressed/);
  validateStoryboard({...board(),scenes:[{pattern:"fragment",kind:"input",state:"typing",d:3}]});
});

test("ingest timer clock preserves order, nested timers and cancellation",async()=>{
  const context: Record<string,unknown>={performance:{now:()=>999}};context["window"]=context;
  const result=await vm.runInNewContext(INGEST_CLOCK+`(async()=>{
    const trace=[];
    if (typeof Date() !== 'string' || new Date().getTime() !== Date.now() || new Date(123).getTime() !== 123) throw new Error('Date API mismatch');
    setTimeout(()=>{trace.push(Date.now());setTimeout(()=>trace.push('nested'),0)},10);
    const interval=setInterval(()=>trace.push(performance.now()),5);
    await __advanceIngest(20);clearInterval(interval);await __advanceIngest(50);
    return JSON.stringify(trace);
  })()`,context);
  assert.deepEqual(JSON.parse(result),[5,946684800010,10,"nested",15,20]);
});


function assertBoundedCamera(frames:{x:number;y:number;w:number;h:number}[]) {
  const velocities=frames.slice(1).map((f,i)=>Math.log(frames[i]!.w/f.w)*60);
  assert.ok(frames.every(f=>1920/f.w<=1.5+1e-9));
  assert.ok(velocities.every(v=>Math.abs(v)<=1+1e-9));
  assert.ok(velocities.slice(1).every((v,i)=>Math.abs(v-velocities[i]!)*60<=4+1e-9));
  const positions=frames.map(f=>[-f.x*1920/f.w,-f.y*1080/f.h]);
  assert.ok(positions.slice(2).every((p,i)=>Math.hypot(p[0]!-2*positions[i+1]![0]!+positions[i]![0]!,p[1]!-2*positions[i+1]![1]!+positions[i]![1]!)*3600<=9000+1e-9));
}

test("motion planning preserves screen ownership, quoted states and bounded bitmap cameras",()=>{
  const plan=validateStoryboard({...planStoryboard(parseMotionArgs(["first.png","second.png","--region","100,100,200,200:Focus","--region","100,100,200,200:Other@S2"]),"regression") as object,screens:{S1:{file:"first.png",width:2560,height:1440},S2:{file:"second.png",width:2560,height:1440}}});
  assert.deepEqual(plan.scenes.filter(s=>s.pattern==="zoom-tour").map(s=>s.screen),["S1","S2"]);
  const paths=sceneCameras(plan);
  assert.ok(paths["0"]!.some(f=>f.w!==paths["0"]![0]!.w));
  for(const frames of Object.values(paths))assertBoundedCamera(frames.map(f=>f.output??f));
  for(const input of ["page.html","https://example.test"]) {
    const state=validateStoryboard(planStoryboard(parseMotionArgs([input,"--state",'S1=type #title "Draft; launch"; wait 300']),"state"));
    assert.deepEqual(state.source.states!.S1!.map(op=>parseStateOp(op)),[["type","#title","Draft; launch"],["wait",300]]);
  }
  const mono=motionTokens("mono");assert.equal(mono.text,"#ffffff");assert.equal(mono.background,"#000000");assert.equal(mono.ink,"#000000");assert.equal(mono.card,"#ffffff");
  for(const device of ["browser","phone","laptop","none"] as const) {
    const small={width:100,height:100},scene={pattern:"hero-reveal" as const,d:5,device};
    const hero=heroSize(small,scene,1920,1080);assert.ok(Math.max(hero.width/100,hero.height/100)*1.03<=1+1e-9);
    const hard=bitmapSize(small,600,800);assert.ok(Math.max(hard.width/100,hard.height/100)<=1.5);
  }
  const browser:Record<string,unknown>={};browser.window=browser;
  const bootstrap=motionPage({},mono,1920,1080).match(/<script>([\s\S]*?)<\/script>/)![1]!;
  vm.runInNewContext(bootstrap,browser);
  const browserHero=browser.heroSize as typeof heroSize;
  assert.deepEqual(JSON.parse(JSON.stringify(browserHero({width:100,height:100},{pattern:"hero-reveal",d:5,device:"phone"},1920,1080))),heroSize({width:100,height:100},{pattern:"hero-reveal",d:5,device:"phone"},1920,1080));
  browser.CHROME={};vm.runInNewContext(readFileSync(new URL("../resources/motion/chrome.js",import.meta.url),"utf8"),browser);
  const requested:string[]=[];browser.deviceFrame=()=>({frame:"frame"});
  const chrome=browser.CHROME as Record<string,(ctx:unknown)=>unknown>;
  const ctx={scene:{screen:"S2"},W:1920,H:1080,screen:(id:string)=>{requested.push(id);return {width:100,height:100};}};
  chrome.browser!(ctx);chrome.phone!(ctx);assert.deepEqual(requested,["S2","S2"]);
  const large=validateStoryboard({...board(),screens:{S1:{file:"large.png",width:16384,height:9216}},regions:[{id:"r1",rect:[100,100,20,20],screen:"S1",from:"user"}],scenes:[{pattern:"zoom-tour",screen:"S1",d:60,stops:[{region:"r1"}]}]});
  const frames=sceneCameras(large)["0"]!;
  assertBoundedCamera(frames.map(f=>f.output??f));
  assert.throws(()=>sceneCameras({...large,scenes:[{...large.scenes[0]!,d:5}]}),/bounded moves/);
  assert.throws(()=>validateStoryboard({...board(),regions:[{id:"r1",rect:[0,0,10,10],screen:"S1",from:"user"}],scenes:[{pattern:"hero-reveal",screen:"S2",focus:"r1",d:5}]}),/screen/);
  assert.throws(()=>parseMotionArgs(["first.png","--aspect","9:16"]),/unknown option/);
  assert.throws(()=>parseMotionArgs(["first.png","--fps","30"]),/unknown option/);
  assert.throws(()=>validateStoryboard({...board(),output:{quality:"draft"}}),/not supported/);
  assert.throws(()=>validateStoryboard({...board(),scenes:[...board().scenes,...board().scenes],transitions:[{after:0,kind:"xfade",d:.25}]}),/expected cut/);
});
