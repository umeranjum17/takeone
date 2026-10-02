import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { encodeFrames } from "../src/motion/render.ts";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { motionPage } from "../src/motion/page.ts";
import { INGEST_CLOCK } from "../src/motion/ingest-clock.ts";
import assert from "node:assert/strict";
import { filmDuration, validateStoryboard } from "../src/motion/storyboard.ts";
import { beatTime, fontCovers, lintCss } from "../src/motion/lint.ts";
import { parseMotionArgs, planStoryboard } from "../src/motion/cli.ts";
import { bitmapSize, heroSize } from "../src/motion/geometry.ts";
import { motionTokens } from "../src/motion/theme.ts";
import { fontFile } from "../src/motion/theme.ts";
import { planSpeeds } from "../src/motion/blur.ts";
import { averageRaw, decodePng, encodePng } from "../src/motion/png.ts";
import { ingest, parseStateOp } from "../src/motion/ingest.ts";
import { sceneCameras } from "../src/motion/camera.ts";
import type { Storyboard } from "../src/motion/types.ts";

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
  validateStoryboard({...board(),scenes:[{pattern:"fragment",kind:"input",state:"typing",d:3.5}]});
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
});


test("text reveal must finish before its reading hold on every timeline",()=>{
  const cases=[
    {pattern:"fragment",kind:"input",state:"typing",text:"ShipTheOctoberReleaseNow",d:1.1},
    {pattern:"end-card",logo:"A".repeat(32),d:1.1},
    {pattern:"hero-reveal",title:"One two three four five six seven eight",d:3.2},
    {pattern:"hero-reveal",subtitle:"Launch",d:1.6},
    {pattern:"end-card",logo:"",cta:"Launch",d:1.7},
    {pattern:"end-card",logo:"",url:"Launch",d:1.8},
  ];
  for(const scene of cases) {
    assert.throws(()=>validateStoryboard({...board(),scenes:[scene]}),/reveal and reading-time/);
    assert.throws(()=>validateStoryboard({...board(),layout:{kind:"bento",grid:"2x2",master:{d:6,scenes:[scene]},tiles:["TL","TR","BL","BR"].map(id=>({id,offset_s:0}))}}),/reveal and reading-time/);
    assert.throws(()=>validateStoryboard({...board(),layout:{kind:"bento",grid:"pinwheel-3x2",tiles:Object.fromEntries(["A","B","C","D"].map(id=>[id,[scene]]))}}),/reveal and reading-time/);
    validateStoryboard({...board(),scenes:[{...scene,d:6}]});
  }
  assert.throws(()=>validateStoryboard({...board(),tempo:{bpm:120,phase_s:0,snap:"beat"},scenes:[{pattern:"hero-reveal",title:"One two three four",d:2.5+1/60}]}),/reading-time/);
});

test("tour planning holds the effective minimum before reversing",()=>{
  const raw={...board(),theme:{name:"editorial",overrides:{min_shot:3}},regions:[{id:"r1",rect:[900,300,760,620],screen:"S1",from:"user"}],scenes:[{pattern:"zoom-tour",d:8,screen:"S1",stops:[{region:"r1"}]}]};
  const sb=validateStoryboard(raw),frames=sceneCameras(sb)["0"]!;
  const minimum=Math.min(...frames.map(f=>f.w));
  const hold=frames.filter(f=>Math.abs(f.w-minimum)<1e-8);
  assert.ok(hold.length/60>=3);
  assertBoundedCamera(frames.map(f=>f.output??f));
  assert.throws(()=>sceneCameras(validateStoryboard({...raw,scenes:[{...raw.scenes[0]!,d:5}]})),/bounded moves/);
});

test("bento rejects combined spacing that removes tile area",()=>{
  const scenes=[{pattern:"hero-reveal",d:6,title:"Launch"}];
  const layouts=[{kind:"bento",grid:"2x2",master:{d:6,scenes},tiles:["TL","TR","BL","BR"].map(id=>({id,offset_s:0}))},{kind:"bento",grid:"pinwheel-3x2",tiles:Object.fromEntries(["A","B","C","D"].map(id=>[id,scenes]))}];
  for(const layout of layouts) {
    assert.throws(()=>validateStoryboard({...board(),layout,theme:{name:"editorial",overrides:{margin_y:400,gutter_y:400}}}),/positive tile/);
    validateStoryboard({...board(),layout,output:{out_w:886,out_h:486}});
  }
  for(const layout of layouts)validateStoryboard({...board(),layout,theme:{name:"editorial",overrides:{margin_x:400,gutter_x:400}}});
});

test("encoding closes failed streams during warm-up and backpressure",{timeout:5000},async()=>{
  const options={stdio:["pipe","ignore","ignore"] as ["pipe","ignore","ignore"]};
  async function* frames() {yield Buffer.alloc(1024);yield Buffer.alloc(1024);}
  await encodeFrames(spawn(process.execPath,["-e","process.stdin.resume()"],options),frames());
  async function* warmup() {await delay(50);yield Buffer.alloc(1024);}
  await assert.rejects(encodeFrames(spawn(process.execPath,["-e","process.exit(2)"],options),warmup()),/exited 2|[Pp]remature|EPIPE/);
  async function* large() {for(let i=0;i<10;i++)yield Buffer.alloc(1024*1024);}
  await assert.rejects(encodeFrames(spawn(process.execPath,["-e","setTimeout(()=>process.exit(2),20)"],options),large()),/exited 2|[Pp]remature|EPIPE|ECONNRESET/);
  await assert.rejects(encodeFrames(spawn("./missing-motion-encoder",[],options),warmup()),/ENOENT/);
});


test("counter and device labels receive reveal and reading holds in every layout",()=>{
  for(const [kind,d] of [["counter",2.7],["browser-chrome",1.5],["phone-chrome",1.2]] as const) {
    const short={pattern:"fragment",kind,d:.25,text:""};
    const full={...short,d};
    const layouts=(scene:typeof short)=>[
      {kind:"single"},
      {kind:"bento",grid:"2x2",master:{d:6,scenes:[scene]},tiles:["TL","TR","BL","BR"].map(id=>({id,offset_s:0}))},
      {kind:"bento",grid:"pinwheel-3x2",tiles:Object.fromEntries(["A","B","C","D"].map(id=>[id,[scene]]))},
    ];
    for(const layout of layouts(short))assert.throws(()=>validateStoryboard({...board(),scenes:[short],layout}),/reveal and reading-time/);
    for(const layout of layouts(full))validateStoryboard({...board(),scenes:[full],layout});
  }
  assert.throws(()=>validateStoryboard({...board(),scenes:[{pattern:"fragment",kind:"counter",d:2}]}),/reading-time/);
  const context:Record<string,unknown>={document:{readyState:"loading"},addEventListener:()=>{}};context.window=context;
  vm.runInNewContext(readFileSync(new URL("../resources/motion/runtime.js",import.meta.url),"utf8"),context);
  context.h=()=>({textContent:""});
  vm.runInNewContext(readFileSync(new URL("../resources/motion/fragments.js",import.meta.url),"utf8"),context);
  const counter=(context.FRAGMENTS as Record<string,()=>{textContent:string}>).counter!();
  const seek=(context.TICKS as ((ms:number)=>void)[])[0]!;
  seek(250);assert.notEqual(counter.textContent,"60");
  seek(1500);assert.equal(counter.textContent,"60");
  seek((Math.round(2.7*60)-1)*1000/60);assert.equal(counter.textContent,"60");
  const normalized=JSON.parse(JSON.stringify(validateStoryboard({...board(),seed:123,transitions:[{after:0,kind:"cut",d:0}],scenes:[...board().scenes,...board().scenes]})));
  assert.equal(Object.hasOwn(normalized,"seed"),false);
  assert.equal(Object.hasOwn(normalized,"transitions"),false);
  assert.deepEqual(normalized.scenes.map((scene:{at:number})=>scene.at),[0,3]);
});


test("hero and tour device copy gets its post-reveal hold in every visible window",()=>{
  const tiles=["TL","TR","BL","BR"].map(id=>({id,offset_s:0}));
  for(const pattern of ["hero-reveal","zoom-tour"] as const) {
    for(const device of [undefined,"browser","phone"] as const) {
      const floor=device==="phone" ? 1.1 : 1.4;
      const minimum=floor+(pattern==="hero-reveal" ? .6 : 0);
      const scene={pattern,device,title:pattern==="hero-reveal" ? "Launch" : undefined,d:minimum};
      const layouts=(s:typeof scene)=>[
        {kind:"single"},
        {kind:"bento",grid:"2x2",master:{d:6,scenes:[s]},tiles},
        ...["A","B","C","D"].map(id=>({kind:"bento",grid:"pinwheel-3x2",tiles:Object.fromEntries(["A","B","C","D"].map(key=>[key,[key===id ? s : {...s,d:6}]]))})),
      ];
      for(const layout of layouts(scene))assert.throws(()=>validateStoryboard({...board(),scenes:[scene],layout}),/reveal and reading-time/);
      const full={...scene,d:minimum+1/60};
      for(const layout of layouts(full))validateStoryboard({...board(),scenes:[full],layout});
      for(const id of ["TL","TR","BL","BR"]) {
        for(const offset_s of [4-floor,minimum-6]) {
          const layout={kind:"bento",grid:"2x2",master:{d:6,scenes:[{...scene,d:4}]},tiles:tiles.map(tile=>({...tile,offset_s:tile.id===id ? offset_s : 0}))};
          assert.throws(()=>validateStoryboard({...board(),layout}),/visible window.*reading/);
        }
      }
    }
    for(const device of ["none","laptop"] as const)validateStoryboard({...board(),scenes:[{pattern,device,title:pattern==="hero-reveal" ? "Launch" : undefined,d:pattern==="hero-reveal" ? 1.6 : .5}]});
  }
  assert.throws(()=>validateStoryboard({...board(),scenes:[{pattern:"hero-reveal",title:"Launch",device:"browser",d:1.6}]}),/reading-time/);
  assert.throws(()=>validateStoryboard({...board(),scenes:[{pattern:"zoom-tour",device:"browser",d:.5}]}),/reading-time/);
});

test("effective bento windows preserve required reveals and holds",()=>{
  const spinner={pattern:"fragment",kind:"spinner",d:5};
  const counter={pattern:"fragment",kind:"counter",d:2.7};
  const tiles=["TL","TR","BL","BR"].map(id=>({id,offset_s:0}));
  const layout={kind:"bento",grid:"2x2",master:{d:6,scenes:[spinner,counter]},tiles};
  assert.throws(()=>validateStoryboard({...board(),layout}),/visible window.*reading-time/);
  const qualified=validateStoryboard({...board(),layout:{...layout,master:{d:7.7,scenes:[spinner,counter]}}});
  assert.equal(filmDuration(qualified),7.7);
  const shifted={...layout,master:{d:6,scenes:[counter]}};
  for(const id of ["TL","TR","BL","BR"]) {
    assert.throws(()=>validateStoryboard({...board(),layout:{...shifted,tiles:tiles.map(tile=>({...tile,offset_s:tile.id===id?1.7:0}))}}),/visible window.*reading-time/);
    assert.throws(()=>validateStoryboard({...board(),layout:{...shifted,tiles:tiles.map(tile=>({...tile,offset_s:tile.id===id?-4:0}))}}),/visible window.*reading-time/);
  }
  validateStoryboard({...board(),layout:{...shifted,tiles:tiles.map((tile,i)=>({...tile,offset_s:i*.5}))}});
  const hero={pattern:"hero-reveal",d:8,title:"Make it move",screen:"S1"};
  const canon=validateStoryboard({...board(),layout:{...layout,master:{d:6,scenes:[hero]},tiles:tiles.map((tile,i)=>({...tile,offset_s:i*.5}))}});
  assert.deepEqual(canon.layout.kind==="bento" && canon.layout.grid==="2x2" && canon.layout.tiles.map(tile=>tile.offset_s),[0,.5,1,1.5]);
  for(const at of [-1,-1/60]) {
    assert.throws(()=>validateStoryboard({...board(),layout:{...shifted,master:{d:6,scenes:[{...counter,at}]}}}),/at/);
    assert.throws(()=>validateStoryboard({...board(),layout:{kind:"bento",grid:"pinwheel-3x2",tiles:Object.fromEntries(["A","B","C","D"].map(id=>[id,[{...counter,at}]]))}}),/at/);
  }
  assert.throws(()=>validateStoryboard({...board(),tempo:{bpm:120,phase_s:-.01,snap:"beat"},layout:{...shifted,master:{d:6,scenes:[{...counter,d:3}]}}}),/negative scene starts/);
  const tour={pattern:"zoom-tour",d:6,screen:"S1",stops:[{region:"r1",caption:"Focus"}]};
  const regions=[{id:"r1",screen:"S1",rect:[900,300,760,620],from:"user"}];
  assert.throws(()=>validateStoryboard({...board(),regions,layout:{...layout,master:{d:5,scenes:[tour]}}}),/truncates camera/);
  assert.throws(()=>validateStoryboard({...board(),regions,layout:{...layout,master:{d:6,scenes:[tour]},tiles:tiles.map((tile,i)=>({...tile,offset_s:i*.5}))}}),/truncates camera/);
  validateStoryboard({...board(),regions,layout:{...layout,master:{d:6,scenes:[tour]}}});
});


test("state names preserve capture order and reject overwritten operations", async()=>{
  for (const input of ["page.html", "https://example.com"]) {
    for (const name of ["0", "1", "2", "4294967294"]) {
      assert.throws(()=>parseMotionArgs([input,"--state",`${name}=click #newTask`]),/non-index name/);
      const raw={...board(),source:{kind:input==="page.html"?"html":"url",file:input,url:input,states:{[name]:["click #newTask"]}}};
      assert.throws(()=>validateStoryboard(raw),/non-index name/);
      await assert.rejects(()=>ingest("unused-state-proof",raw as unknown as Storyboard),/non-index name/);
    }
    assert.throws(()=>parseMotionArgs([input,"--state","Draft=click #newTask","--state",'Draft=type #title "Draft"']),/duplicate screen id/);
    const args=parseMotionArgs([input,"--state","Second=click #newTask","--state",'First=type #title "Draft; launch"; wait 300']);
    const story=validateStoryboard(planStoryboard(args,"ordered"));
    assert.deepEqual(Object.entries(story.source.states!).map(([name,ops])=>[name,ops.map(parseStateOp)]),[
      ["Second",[["click","#newTask"]]],
      ["First",[["type","#title","Draft; launch"],["wait",300]]]
    ]);
    assert.throws(()=>planStoryboard({...args,states:[["Second","click #newTask"],["Second","wait 300"]]},"duplicate"),/duplicate screen id/);
    assert.throws(()=>planStoryboard({...args,states:[["2","click #newTask"],["1","wait 300"]]},"numeric"),/non-index name/);
    const stable=parseMotionArgs([input,"--state","01=wait 100","--state","4294967295=wait 200","--state","S1=wait 300"]);
    assert.deepEqual(Object.keys(validateStoryboard(planStoryboard(stable,"stable")).source.states!),["01","4294967295","S1"]);
  }
});


test("explicit worker counts reach storyboard validation",()=>{
  for(const workers of ["0","nope","-1","1.5","65"]) {
    assert.throws(()=>validateStoryboard(planStoryboard(parseMotionArgs(["page.html","--workers",workers]),"workers")),/output.workers/);
  }
  for(const workers of ["1","8","64"]) {
    assert.equal(validateStoryboard(planStoryboard(parseMotionArgs(["page.html","--workers",workers]),"workers")).output.workers,Number(workers));
  }
  assert.equal(validateStoryboard(planStoryboard(parseMotionArgs(["page.html"]),"workers")).output.workers,8);
});

test("prototype-named captures survive ingest and serialized storyboard consumption",()=>{
  const result=spawnSync(process.execPath,["--experimental-test-module-mocks","--input-type=module","-e",`
    import {mock} from 'node:test';
    import vm from 'node:vm';
    import assert from 'node:assert/strict';
    import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
    import {resolve,join} from 'node:path';
    import {encodePng} from './src/motion/png.ts';
    const png=encodePng({width:16,height:16,channels:3,data:new Uint8Array(16*16*3)});
    let closed=0;
    mock.module('./src/motion/cdp.ts',{namedExports:{
      launch:async()=>({send:async(method)=>method==='Page.captureScreenshot'?{data:png.toString('base64')}:{},evaluate:async()=>{},close:async()=>{closed++;}}),
      navigate:async()=>{},shellFlags:()=>[]
    }});
    mock.module('./src/motion/shell.ts',{namedExports:{pinnedShell:async()=>({path:'mock-shell'}),installShell:async()=>{throw new Error('unexpected install');}}});
    const {ingest}=await import('./src/motion/ingest.ts');
    const {parseMotionArgs,planStoryboard}=await import('./src/motion/cli.ts');
    const {validateStoryboard}=await import('./src/motion/storyboard.ts');
    const {readStoryboard,pageData}=await import('./src/motion/motion.ts');
    const {motionPage}=await import('./src/motion/page.ts');
    const dir=mkdtempSync(resolve('.motion-state-test-'));
    try {
      for(const direct of [false,true]) {
        const story=validateStoryboard(planStoryboard(parseMotionArgs(['page.html','--state','__proto__=wait 100','--state','constructor=wait 100','--state','S1=wait 100']),'captures'));
        story.source.viewport=[16,16];
        if(direct)story.screens={};
        await ingest(dir,story);
        assert.deepEqual(Object.keys(story.screens),['__proto__','constructor','S1']);
        assert.deepEqual(readFileSync(join(dir,'sources','__proto__.png')),png);
        writeFileSync(join(dir,'storyboard.json'),JSON.stringify(story));
        const restored=readStoryboard(dir);
        assert.equal(Object.hasOwn(restored.screens,'__proto__'),true);
        assert.deepEqual(restored.screens['__proto__'],{file:'sources/__proto__.png',width:16,height:16});
        const data=pageData(dir,restored,{});
        assert.deepEqual(Object.keys(data.screens),['__proto__','constructor','S1']);
        const html=motionPage(data,data.tokens,1920,1080);
        const bootstrap=html.slice(html.indexOf('<script>')+8,html.indexOf('</script>'));
        const window={};
        vm.runInNewContext(bootstrap,{window});
        assert.equal(Object.hasOwn(window.STORYBOARD.screens,'__proto__'),true);
        assert.equal(window.STORYBOARD.screens['__proto__'].width,16);
        assert.equal(Object.hasOwn(window.STORYBOARD.storyboard.screens,'__proto__'),true);
      }
      assert.equal(closed,2);
    } finally {rmSync(dir,{recursive:true,force:true});}
  `],{encoding:"utf8",timeout:5000});
  assert.equal(result.status,0,result.stderr);
});
