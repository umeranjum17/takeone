#!/usr/bin/env node
// Rebuild overlay visual proof from fictional demo data; never captures a screen.
// node scripts/synth-overlays.ts <output-dir>
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULTS } from "../src/camera/defaults.ts";
import { renderTake } from "../src/render/render.ts";
import type { Beat, Decision, TakeMeta } from "../src/camera/types.ts";

const root=resolve(process.argv[2] ?? "tmp/overlays");
await mkdir(root,{recursive:true});
const width=1280, height=720;
const duration=6;
const sourceScale=1.5;
const rect=(values: [number,number,number,number]): [number,number,number,number] =>
  values.map(value => value * sourceScale) as [number,number,number,number];
const source=join(root,"screen.webm");
execFileSync("ffmpeg",["-y","-v","error","-f","lavfi","-i",`color=c=0x151923:s=${width}x${height}:r=60:d=${duration}`,
  "-vf",[
    "drawbox=x=28:y=28:w=1224:h=70:color=0x252c3d:t=fill",
    "drawtext=text='Umer  /  Demo workspace':x=60:y=48:fontsize=28:fontcolor=white",
    "drawbox=x=70:y=160:w=750:h=190:color=0x303e5d:t=fill",
    "drawtext=text='Command palette':x=100:y=190:fontsize=34:fontcolor=white",
    "drawtext=text='Find a project or run a command':x=100:y=260:fontsize=22:fontcolor=0xb8c8e9",
    "drawbox=x=880:y=170:w=320:h=180:color=0x33443d:t=fill",
    "drawtext=text='Demo access token':x=900:y=195:fontsize=22:fontcolor=white",
    "drawtext=text='FICTIONAL-012345':x=900:y=245:fontsize=22:fontcolor=white",
    "drawbox=x=70:y=430:w=1130:h=180:color=0x252c3d:t=fill",
    "drawtext=text='Project saved':x=100:y=470:fontsize=32:fontcolor=white",
    "drawtext=text='All changes are ready to share':x=100:y=540:fontsize=22:fontcolor=0xb8c8e9",
  ].join(",") + ",scale=1920:1080:flags=lanczos","-an","-c:v","libvpx-vp9","-lossless","1",source]);
const base:TakeMeta={id:"demo",width:width*sourceScale,height:height*sourceScale,trim_end:duration};
const beats:Beat[]=[
  {id:"palette",t0:0,t1:3,anchor_t:1,kind:"shortcut",actions:[],zones:[{name:"palette",type:"act",bbox:rect([70,160,750,190])}]},
  {id:"save",t0:3,t1:6,anchor_t:4,kind:"shortcut",actions:[],zones:[{name:"saved",type:"res",bbox:rect([70,430,1130,180])}]},
];
const decisions:Decision[]=beats.map(b=>({beat:b.id,A:b.zones[0]!.name,L:1,p:0,K:0,conf:1,decided_by:"synthetic"}));
const d={...DEFAULTS,idle_speed:1,fade_s:0,preset:"fast"};
for(const version of ["before","after"] as const){
  const dir=join(root,version);
  await mkdir(join(dir,"analysis"),{recursive:true});
  await writeFile(join(dir,"screen.webm"),await readFile(source));
  const meta:TakeMeta={...base};
  const b=structuredClone(beats);
  if(version==="after"){
    meta.spotlight=[{t:0.7,d:2.2,rect:rect([60,150,770,210])}];
    meta.blur=[{t:0,d:6,rect:rect([890,235,290,45])}];
    b[0]!.actions=[{k:"shortcut",t:1000,combo:"Ctrl+K"},
      {k:"key",t:1100,cls:"char",down:true,char:"NEVER_RENDER_THIS",text:"NEVER_RENDER_THIS"},
      {k:"shortcut",t:1200,combo:"Ctrl+NEVER_RENDER_THIS"}];
    b[1]!.actions=[{k:"shortcut",t:4000,combo:"Ctrl+S"}];
  }
  await writeFile(join(dir,"take.json"),JSON.stringify(meta));
  await writeFile(join(dir,"analysis/beats.json"),JSON.stringify(b));
  await writeFile(join(dir,"analysis/decisions.jsonl"),decisions.map(v=>JSON.stringify(v)).join("\n"));
  const {out}=await renderTake(dir,d);
  execFileSync("ffmpeg",["-y","-v","error","-ss","1.5","-i",out,"-frames:v","1",join(root,`takeone-overlays-${version}.png`)]);
}
execFileSync("ffmpeg",["-y","-v","error","-i",join(root,"before/out/demo.mp4"),"-i",join(root,"after/out/demo.mp4"),
  "-filter_complex","[0:v]scale=960:540[a];[1:v]scale=960:540[b];[a][b]hstack",
  "-an","-c:v","libx264","-crf","18","-preset","fast",join(root,"takeone-overlays-before-after.mp4")]);
console.log(root);
