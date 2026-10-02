import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { validateStoryboard } from "../src/motion/storyboard.ts";
import { writePage } from "../src/motion/motion.ts";
import { withPage } from "../src/motion/render.ts";
import { allTimelines } from "../src/motion/layout.ts";

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
