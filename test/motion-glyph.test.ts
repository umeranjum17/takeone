import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { validateStoryboard } from "../src/motion/storyboard.ts";
import { writePage } from "../src/motion/motion.ts";
import { withPage } from "../src/motion/render.ts";
import { allTimelines } from "../src/motion/layout.ts";
import { parseMotionArgs, planStoryboard } from "../src/motion/cli.ts";
import { ingest } from "../src/motion/ingest.ts";
import { sceneCameras } from "../src/motion/camera.ts";
import { clippedFractions, HIGH_CLIP_FRACTION, LABEL_AREA_MAX } from "../src/camera/solver.ts";
import { detectUiBoxes } from "../src/perceive/boxes.ts";
import { edgeCuts } from "../src/render/framing.ts";

test("end-card defaults and explicit logos reach display coverage on every timeline",()=>{
  for(const display_font of ["Instrument Serif","Geist SemiBold"]) {
    for(const logo of [undefined,"","Launch"]) {
      const scene={pattern:"end-card",d:6,...(logo===undefined?{}:{logo})};
      const layouts=[
        {kind:"single"},
        {kind:"bento",grid:"2x2",master:{d:6,scenes:[scene]},tiles:["TL","TR","BL","BR"].map(id=>({id,offset_s:0}))},
        {kind:"bento",grid:"pinwheel-3x2",tiles:Object.fromEntries(["A","B","C","D"].map(id=>[id,[scene]]))},
      ];
      for(const layout of layouts) {
        const raw={version:1,source:{kind:"image"},theme:{name:"editorial",overrides:{display_font}},scenes:[scene],layout};
        const sb=validateStoryboard(raw);
        for(const list of allTimelines(sb.layout,sb.scenes))assert.equal(list[0]!.logo,logo??"TakeOne");
        assert.throws(()=>validateStoryboard({...raw,scenes:[{...scene,logo:"\u{10ffff}"}],layout:{kind:"single"}}),new RegExp(`missing glyph in ${display_font}`));
      }
    }
  }
  const raw={version:1,source:{kind:"image"},theme:{name:"editorial"},scenes:[{pattern:"end-card",logo:"Cafe\u0301",d:1.8}]};
  assert.equal(validateStoryboard(raw).scenes[0]!.logo,"Cafe\u0301");
  assert.throws(()=>validateStoryboard({...raw,scenes:[{...raw.scenes[0]!,d:1.75}]}),/reveal and reading-time/);
});

test("hero and end-card reveals seek eased outgoing segments",async()=>{
  const dir=mkdtempSync(resolve(".motion-easing-test-"));
  try {
    const sb=validateStoryboard({version:1,theme:{name:"editorial"},source:{kind:"image"},screens:{S1:{file:resolve("resources/demo/tidewater-board.png"),width:2560,height:1440}},regions:[],scenes:[
      {pattern:"hero-reveal",title:"Launch now",subtitle:"Made for you",d:6,screen:"S1"},
      {pattern:"end-card",logo:"Cafe\u0301",cta:"Try it",url:"takeone.test",d:6},
    ]});
    await withPage(writePage(dir,sb).html,1920,1080,async b=>{
      const read=async(selector:string,ms:number,property:"opacity"|"y")=>{
        await b.evaluate(`__seek(${ms})`);
        return b.evaluate<number>(`(()=>{const cs=getComputedStyle(document.querySelector(${JSON.stringify(selector)}));return ${property==="opacity" ? "Number(cs.opacity)" : "cs.transform==='none'?0:new DOMMatrixReadOnly(cs.transform).m42"};})()`);
      };
      const cases=[
        {selector:'[data-scene="0"] .hero-word',start:0,duration:400,property:"y"},
        {selector:'[data-scene="0"] span:nth-of-type(2) .hero-word',start:60,duration:400,property:"y"},
        {selector:'[data-scene="0"] > div:last-child',start:0,duration:600,property:"opacity"},
        {selector:'[data-scene="1"] .kern [data-x]',start:6000,duration:550,property:"y"},
        {selector:'[data-scene="1"] .kern [data-x]:last-child',start:6105,duration:550,property:"opacity"},
        {selector:'[data-scene="1"] .kern + div',start:6000,duration:650,property:"opacity"},
        {selector:'[data-scene="1"] .kern + div + div',start:6000,duration:750,property:"opacity"},
      ] as const;
      for(const {selector,start,duration,property} of cases) {
        const initial=await read(selector,start,property);
        const final=await read(selector,start+duration,property);
        assert.notEqual(initial,final,selector);
        const quarter=await read(selector,start+duration/4,property);
        assert.ok(Math.abs((quarter-initial)/(final-initial)-.1035)<.001,`${selector}: ${quarter}`);
        assert.equal(await read(selector,start+duration/4,property),quarter,selector);
        assert.equal(await read(selector,start,property),initial,selector);
        assert.equal(await read(selector,start+duration,property),final,selector);
      }
    });
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("emitted motion glyphs use bundled faces with default and serif roles", async()=>{
  const dir=mkdtempSync(resolve(".motion-glyph-test-"));
  try {
    for(const overrides of [{},{caption_font:"Instrument Serif",mono_font:"Instrument Serif"},{display_font:"Geist SemiBold"}]) {
      const scenes=[
        {pattern:"fragment",kind:"toast",d:6},
        {pattern:"fragment",kind:"feed-row",d:6},
        {pattern:"fragment",kind:"browser-chrome",d:6,screen:"S1"},
        {pattern:"fragment",kind:"phone-chrome",d:6,screen:"S1"},
        {pattern:"hero-reveal",title:"Launch",d:6,screen:"S1",device:"browser"},
        {pattern:"hero-reveal",title:"Launch",d:6,screen:"S1",device:"phone"},
        {pattern:"zoom-tour",d:6,screen:"S1",device:"browser",stops:[]},
        {pattern:"zoom-tour",d:6,screen:"S1",device:"phone",stops:[]},
        {pattern:"end-card",d:6},
        {pattern:"end-card",logo:"Cafe\u0301",d:6}
      ];
      const sb=validateStoryboard({version:1,theme:{name:"editorial",overrides},source:{kind:"image"},screens:{S1:{file:resolve("resources/demo/tidewater-board.png"),width:2560,height:1440}},regions:[],scenes});
      const html=writePage(dir,sb).html;
      await withPage(html,1920,1080,async b=>{
        await b.send("DOM.enable"); await b.send("CSS.enable");
        for(let i=0;i<scenes.length;i++) {
          await b.evaluate(`__seek(${(i*6+3)*1000})`);
          const text=await b.evaluate<string>(`document.querySelector('[data-scene="${i}"]').innerText`);
          const device=scenes[i]!.device??(scenes[i]!.kind==="browser-chrome"?"browser":scenes[i]!.kind==="phone-chrome"?"phone":null);
          if(i===0)assert.ok(text.replace(/\s+/g," ").includes("✓ Task created"),text);
          if(i===1) {
            assert.ok(text.includes("Just now"),text);
            const family=await b.evaluate<string>(`getComputedStyle(document.querySelector('[data-scene="${i}"] [style*="var(--mono)"]')).fontFamily`);
            assert.ok(family.includes(overrides.mono_font??"Geist Mono"),family);
          }
          if(device==="browser")assert.ok(text.includes("● ● ●")&&text.includes("Design preview"),text);
          if(device==="phone")assert.ok(text.includes("9:41")&&text.includes("━"),text);
          if(scenes[i]!.pattern==="end-card") {
            const logo=scenes[i]!.logo??"TakeOne";
            assert.ok(text.replace(/\s+/g,"").includes(logo),text);
            const family=await b.evaluate<string>(`getComputedStyle(document.querySelector('[data-scene="${i}"] .kern')).fontFamily`);
            assert.ok(family.includes(overrides.display_font??"Instrument Serif"),family);
            const layout=await b.evaluate<{clusters:string[];max_error:number;advance_error:number;mark_width_error:number}>(`(()=>{
              const el=document.querySelector('[data-scene="${i}"] .kern'),ghost=el.firstElementChild.cloneNode(true),cs=getComputedStyle(el);
              ghost.style.cssText='position:fixed;left:0;top:0;white-space:pre;font:'+cs.font+';font-kerning:'+cs.fontKerning+';letter-spacing:'+cs.letterSpacing+';font-variant-ligatures:none';
              document.body.append(ghost);
              const spans=[...el.querySelectorAll('[data-x]')],node=ghost.firstChild,r=document.createRange(),x0=ghost.getBoundingClientRect().left;
              const scale=el.getBoundingClientRect().width/ghost.getBoundingClientRect().width;
              let j=0,max_error=0,mark_width_error=0;
              for(const {segment,index} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(ghost.textContent)) {
                r.setStart(node,index);r.setEnd(node,index+segment.length);
                if(!segment.trim())continue;
                const expected=r.getBoundingClientRect(),actual=spans[j++].getBoundingClientRect();
                max_error=Math.max(max_error,Math.abs((actual.left-el.getBoundingClientRect().left)/scale-(expected.left-x0)));
                if(segment==='e\\u0301')mark_width_error=Math.abs(actual.width/scale-expected.width);
              }
              const result={clusters:spans.map(span=>span.textContent),max_error,advance_error:Math.abs(ghost.getBoundingClientRect().width-el.offsetWidth),mark_width_error};
              ghost.remove();return result;
            })()`);
            assert.deepEqual(layout.clusters,logo==="TakeOne"?["T","a","k","e","O","n","e"]:["C","a","f","e\u0301"]);
            assert.ok(layout.max_error<=.5,JSON.stringify(layout));
            assert.ok(layout.advance_error<=.5,JSON.stringify(layout));
            assert.ok(layout.mark_width_error<=.5,JSON.stringify(layout));
          }
          const {root}=await b.send<{root:{nodeId:number}}>("DOM.getDocument");
          const {nodeIds}=await b.send<{nodeIds:number[]}>("DOM.querySelectorAll",{nodeId:root.nodeId,selector:`[data-scene="${i}"] *`});
          let glyphs=0;
          for(const nodeId of nodeIds) {
            const {fonts}=await b.send<{fonts:{isCustomFont:boolean;familyName:string;glyphCount:number}[]}>("CSS.getPlatformFontsForNode",{nodeId});
            for(const font of fonts)if(font.glyphCount){glyphs+=font.glyphCount;assert.equal(font.isCustomFont,true,JSON.stringify(font));}
          }
          assert.ok(glyphs>0);
        }
      });
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("launch-film close-ups and bento crops show whole words, fields and buttons",{timeout:240_000},async()=>{
  const dir=mkdtempSync(resolve(".motion-whole-test-"));
  try {
    const a=parseMotionArgs([resolve("scripts/e2e/scene.html"),"--title","Tidewater","--device","browser",
      "--state","board=wait 200","--state",'newtask=click #newTask; type #title "Book demo room"; type #notes "Friday 10am, room 4"; wait 400',
      "--state","created=click #create; wait 800",
      "--region","320,128,1624,620:Plan the launch@board","--region","900,340,760,620:Capture a task@newtask","--region","320,128,520,760:Ship it@created"]);
    const sb=validateStoryboard(planStoryboard(a,"motion"));
    const planned=Object.entries(sb.crops??{}).map(([id,c])=>[id,c.screen,[...c.rect]] as const);
    await ingest(dir,sb);
    // Whole: no box (field, button, card) sliced short of the sliver allowance, no word under an edge.
    const judges=new Map<string,(r:{x:number;y:number;w:number;h:number})=>string[]>();
    const judge=(screen:string)=>{
      if(judges.has(screen))return judges.get(screen)!;
      const {file,width,height}=sb.screens[screen]!;
      const grey=(w:number,h:number)=>new Uint8Array(execFileSync("ffmpeg",["-nostdin","-v","error","-i",resolve(dir,file),"-vf",`scale=${w}:${h},format=gray`,"-f","rawvideo","-"],{maxBuffer:w*h+1024}));
      const qw=Math.floor(width/4),qh=Math.floor(height/4);
      const boxes=detectUiBoxes(grey(qw,qh),qw,qh,width,height).filter(b=>b[2]*b[3]<=width*height*LABEL_AREA_MAX);
      const cuts=edgeCuts([grey(width,height)],width,height);
      const f=(r:{x:number;y:number;w:number;h:number})=>[
        ...clippedFractions(r,boxes).flatMap((c,i)=>c>0&&c<HIGH_CLIP_FRACTION?[`box ${boxes[i]} clipped ${c.toFixed(2)}`]:[]),
        ...(cuts(r)?[`edge cuts ${cuts(r)}`]:[])];
      judges.set(screen,f);return f;
    };
    const rect=([x,y,w,h]:readonly number[])=>({x:x!,y:y!,w:w!,h:h!});
    assert.ok(planned.some(([,screen,r])=>judge(screen)(rect(r)).length),"the planned crops already were whole; this journey no longer covers the defect");
    for(const [id,c] of Object.entries(sb.crops??{}))assert.deepEqual(judge(c.screen)(rect(c.rect)),[],`crop ${id} ${c.rect}`);
    const holds=(cameras:ReturnType<typeof sceneCameras>)=>sb.scenes.flatMap((scene,i)=>{
      if(scene.pattern!=="zoom-tour")return [];
      const {width}=sb.screens[scene.screen!]!;
      const views=new Set(cameras[String(i)]!.filter((v,j,all)=>j&&v.w<width&&["x","y","w","h"].every(k=>v[k as "x"]===all[j-1]![k as "x"])).map(v=>JSON.stringify([v.x,v.y,v.w,v.h])));
      assert.ok(views.size,`tour ${i} settles on a close-up`);
      return [...views].map(h=>[i,scene.screen!,JSON.parse(h) as number[]] as const);
    });
    assert.ok(holds(sceneCameras(sb)).some(([,screen,r])=>judge(screen)(rect(r)).length),"the planned tour holds already were whole; this journey no longer covers the defect");
    for(const [i,screen,r] of holds(sceneCameras(sb,dir)))assert.deepEqual(judge(screen)(rect(r)),[],`tour ${i} hold ${r}`);
    const bento=sb.scenes.find(s=>s.pattern==="bento")!;
    assert.deepEqual(bento.tiles!.map(t=>t.title),["Plan the launch","Capture a task","Ship it",""]);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
