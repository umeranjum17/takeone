import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOverrides } from "../src/camera/defaults.ts";
import { resolveTheme, THEMES } from "../src/themes.ts";
import { renderTake } from "../src/render/render.ts";
import { hasFfmpeg } from "./helpers.ts";
import { decodePng } from "../src/motion/png.ts";

test("all bundled themes render with bundled faces; midnight decoded frames equal the default", {skip:!hasFfmpeg(),timeout:120000}, async () => {
  const dir=mkdtempSync(join(tmpdir(),"takeone-theme-render-"));
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
    // The actual renderer must add one cursor only to a cursor-free take,
    // and keep old footage usable when its pointer track is absent.
    const meta = JSON.parse(readFileSync(join(dir,"take.json"),"utf8"));
    writeFileSync(join(dir,"frames.tsv"),"0\t0\n");
    writeFileSync(join(dir,"events.jsonl"),'{"k":"ptr","t":0,"x":320,"y":180}\n');
    writeFileSync(join(dir,"take.json"),JSON.stringify({...meta,cursor_free:true}));
    const cursor = hashes((await renderTake(dir,applyOverrides(small))).out);
    assert.notEqual(cursor,base,"the encoded film contains the drawn pointer");
    assert.notEqual(hashes((await renderTake(dir,applyOverrides({...small,cursor_size:2}))).out),cursor,
      "cursor_size redraws the pointer at a different size");
    writeFileSync(join(dir,"events.jsonl"),'{"k":"ptr","t":0,"x":639,"y":180}\n');
    const edge = (await renderTake(dir,applyOverrides(small))).out;
    const pixels = (file:string, filter:string) => execFileSync("ffmpeg",["-v","error","-i",file,
      "-frames:v","1","-vf",filter,"-pix_fmt","gray","-f","rawvideo","-"],{maxBuffer:640*360+4096});
    const ink = pixels(edge,"format=gray"), holes = pixels(join(dir,"stage-holes.png"),"alphaextract");
    const spilled = ink.reduce((n,v,i)=>n+Number(holes[i]!>=254 && v>230),0);
    assert.equal(spilled,0,"pointer ink stays inside the rendered screen card, not on the wallpaper");
    writeFileSync(join(dir,"take.json"),JSON.stringify({...meta,cursor_free:false}));
    assert.equal(hashes((await renderTake(dir,applyOverrides(small))).out),base,
      "a baked-cursor take never receives a second arrow");
    unlinkSync(join(dir,"events.jsonl"));
    writeFileSync(join(dir,"take.json"),JSON.stringify({...meta,cursor_free:true}));
    assert.equal(hashes((await renderTake(dir,applyOverrides(small))).out),base,
      "missing pointer samples do not break the footage");
    writeFileSync(join(dir,"take.json"),JSON.stringify(meta));
    // Narration and a music bed mux into one audio stream the length of the picture; the default stays silent.
    for (const [file,src] of [["voice.wav","sine=f=220:d=1"],["bed.wav","sine=f=660:d=1"]]) execFileSync("ffmpeg",["-v","error","-y","-f","lavfi","-i",src!,"-ac","2",join(dir,file!)]);
    const streams = (file:string)=>execFileSync("ffprobe",["-v","error","-show_entries","stream=codec_type,duration","-of","csv=p=0",file],{encoding:"utf8"}).trim().split("\n");
    assert.deepEqual(streams((await renderTake(dir,applyOverrides(small))).out).map(l=>l.split(",")[0]),["video"]);
    const sound = streams((await renderTake(dir,applyOverrides({...small,narration:"voice.wav",music:"bed.wav",click_sound:1}))).out).map(l=>l.split(","));
    assert.deepEqual(sound.map(l=>l[0]),["video","audio"]);
    assert.ok(Math.abs(Number(sound[0]![1])-Number(sound[1]![1]))<0.1,"the sound runs the length of the film");
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

const needsFfmpeg = hasFfmpeg() ? undefined : "requires system ffmpeg and ffprobe on PATH";
test("a stage gradient is dithered in every channel, so a hue ramp never bands", {skip:needsFfmpeg,timeout:60000}, async () => {
  const dir=mkdtempSync(join(tmpdir(),"takeone-stage-dither-"));
  try {
    mkdirSync(join(dir,"analysis"));
    writeFileSync(join(dir,"take.json"),JSON.stringify({id:"stage",width:640,height:360,trim_end:0.5}));
    writeFileSync(join(dir,"analysis/beats.json"),"[]");
    writeFileSync(join(dir,"analysis/decisions.jsonl"),"");
    execFileSync("ffmpeg",["-v","error","-y","-f","lavfi","-i","testsrc2=s=640x360:r=60:d=0.5","-c:v","libvpx-vp9","-threads","2",join(dir,"screen.webm")]);
    // The old blue-to-violet ramp with grain off: undithered, 88% of neighbours sit on one flat 8-bit step; dithered,
    // 51% (the dither holds over 2x2 output pixels so 4:2:0 chroma keeps it).
    await renderTake(dir,applyOverrides({out_w:640,out_h:360,fade_s:0,grain:0,bg_style:"linear",bg_stops:"#233b60,#735580"}));
    const stage=decodePng(readFileSync(join(dir,"stage.png"))), c=stage.channels;
    let pairs=0, equal=0;
    for (let y=0;y<Math.round(stage.height*0.04);y++) for (let x=0;x+1<stage.width;x++) {
      const i=(y*stage.width+x)*c;
      pairs++; equal+=Number([0,1,2].every(k=>stage.data[i+k]===stage.data[i+c+k]));
    }
    assert.ok(equal/pairs<0.7,`the stage is banded: ${(100*equal/pairs).toFixed(1)}% of neighbouring wallpaper pixels are equal`);
  } finally {rmSync(dir,{recursive:true,force:true});}
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
