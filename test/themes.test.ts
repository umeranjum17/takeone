import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, applyOverrides } from "../src/camera/defaults.ts";
import { resolveTheme, THEMES } from "../src/themes.ts";
import { renderTake } from "../src/render/render.ts";
import { resolveCamera, parseSet } from "../src/cli.ts";
import { hasFfmpeg } from "./helpers.ts";

mkdirSync(join(process.cwd(), "tmp"), {recursive:true});

test("theme precedence and validation, including saved portrait takes", () => {
  const dir = mkdtempSync(join(process.cwd(), "tmp/theme-config-"));
  try {
    writeFileSync(join(dir,"take.json"), JSON.stringify({theme:"paper",stream:{w:360,h:640}}));
    assert.equal(resolveCamera(dir, [])!.display_font, "Instrument Serif");
    assert.equal(resolveCamera(dir, [])!.out_h, 1920);
    assert.equal(resolveCamera(dir, ["accent=#123456"],"sand")!.accent,"#123456");
    assert.equal(resolveCamera(dir, [],"midnight")!.background,DEFAULTS.background);
    writeFileSync(join(dir,"take.json"), JSON.stringify({stream:{w:360,h:640}}));
    assert.equal(resolveCamera(dir, []).out_h, 1920);
    assert.deepEqual(resolveTheme(undefined),resolveTheme("midnight"));
    assert.equal(parseSet(["caption_font=123"]).caption_font,"123");
    for (const name of ["invalid", "__proto__", "constructor", 42, null]) assert.throws(()=>resolveTheme(name), /unknown theme/);
    for (const bad of [{bg_stops:"#ffffff"},{bg_stops:"#ffffff,red"},{bg_style:"url"},{display_font:"x,evil"},{grain:101},{shadow_blur:-1},{pace:0},{spring_zeta:0.5},{text:123},{bg_pattern:"unknown"},{caption_rounding:2},{caption_opacity:2},{caption_border:17},{shadow_color:"red"}]) {
      assert.throws(()=>applyOverrides(bad), /invalid --set/);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("all bundled themes render with bundled faces; midnight decoded frames equal the default", {skip:!hasFfmpeg(),timeout:120000}, async () => {
  const dir=mkdtempSync(join(process.cwd(),"tmp/theme-render-"));
  const previousConfig = process.env["FONTCONFIG_FILE"];
  const config = join(dir,"fonts.conf");
  writeFileSync(config, "<fontconfig></fontconfig>");
  process.env["FONTCONFIG_FILE"] = config;
  try {
    mkdirSync(join(dir,"analysis"));
    writeFileSync(join(dir,"take.json"),JSON.stringify({id:"themes",width:640,height:360,trim_end:1.2,title:"Umer builds",captions:[{t:0.35,d:1,text:"Select a card"}]}));
    writeFileSync(join(dir,"analysis/beats.json"),"[]");
    writeFileSync(join(dir,"analysis/decisions.jsonl"),"");
    execFileSync("ffmpeg",["-v","error","-y","-f","lavfi","-i","testsrc2=s=640x360:r=60:d=1.2","-c:v","libvpx-vp9","-threads","2",join(dir,"screen.webm")]);
    const small={out_w:640,out_h:360,caption_size:22,preset:"ultrafast",fade_s:0};
    const hashes = (file:string)=>execFileSync("ffmpeg",["-v","error","-i",file,"-f","framemd5","-"],{encoding:"utf8"});
    const base=hashes((await renderTake(dir,applyOverrides(small))).out);
    const selected: Record<string,string>={};
    for (const name of Object.keys(THEMES)) {
      const d=resolveTheme(name,small);
      const result=await renderTake(dir,d);
      const log=readFileSync(join(dir,"render.log"),"utf8");
      assert.doesNotMatch(log,/failed to find|fontselect:.*fallback|Glyph.*not found/i);
      const fonts=[...log.matchAll(/fontselect: \(([^,]+),[^\n]+ -> ([^\n]+)/g)];
      for (const family of new Set([d.caption_font,d.display_font])) {
        const font=fonts.find(m=>m[1]===family);
        assert.ok(font,`no libass selection for ${name}: ${family}\n${log}`);
        assert.ok(font[2]!.replace(/[^a-z0-9]/gi, "").startsWith(family.replace(/[^a-z0-9]/gi, "")), `substituted ${family}: ${font[2]}`);
      }
      const decoded=hashes(result.out);
      if(name==="midnight")assert.equal(decoded,base);
      selected[name]=decoded;
    }
    assert.equal(new Set(Object.values(selected)).size,Object.keys(THEMES).length,"themes should produce distinct appearances");
  } finally {
    if (previousConfig === undefined) delete process.env["FONTCONFIG_FILE"];
    else process.env["FONTCONFIG_FILE"] = previousConfig;
    rmSync(dir,{recursive:true,force:true});
  }
});

test("caption ink meets 4.5:1 contrast after compositing on any grey screen", () => {
  const rgb=(colour:string)=>[1,3,5].map(i=>parseInt(colour.slice(i,i+2),16)/255);
  const luminance=(channels:number[])=>channels.map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4)
    .reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i]!,0);
  for(const name of Object.keys(THEMES)) {
    const d=resolveTheme(name);
    const ink=luminance(rgb(d.text));
    const card=rgb(d.card);
    for(let grey=0;grey<=255;grey++) {
      const background=luminance(card.map(v=>v*d.caption_opacity+grey/255*(1-d.caption_opacity)));
      const contrast=(Math.max(ink,background)+.05)/(Math.min(ink,background)+.05);
      assert.ok(contrast>=4.5,`${name} on ${grey}: ${contrast.toFixed(2)}:1`);
    }
  }
});
