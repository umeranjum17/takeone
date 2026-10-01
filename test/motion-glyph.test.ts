import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { validateStoryboard } from "../src/motion/storyboard.ts";
import { writePage } from "../src/motion/motion.ts";
import { withPage } from "../src/motion/render.ts";

test("emitted motion glyphs use bundled faces with default and serif roles", async()=>{
  const dir=mkdtempSync(resolve(".motion-glyph-test-"));
  try {
    for(const overrides of [{},{caption_font:"Instrument Serif",mono_font:"Instrument Serif"}]) {
      const scenes=[
        {pattern:"fragment",kind:"toast",d:6},
        {pattern:"fragment",kind:"feed-row",d:6},
        {pattern:"fragment",kind:"browser-chrome",d:6,screen:"S1"},
        {pattern:"fragment",kind:"phone-chrome",d:6,screen:"S1"},
        {pattern:"hero-reveal",title:"Launch",d:6,screen:"S1",device:"browser"},
        {pattern:"hero-reveal",title:"Launch",d:6,screen:"S1",device:"phone"},
        {pattern:"zoom-tour",d:6,screen:"S1",device:"browser",stops:[]},
        {pattern:"zoom-tour",d:6,screen:"S1",device:"phone",stops:[]}
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
