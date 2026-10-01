// Headless Tidewater evidence for edit controls. No live desktop or user profile.
// Requires chrome-devtools-axi and ffmpeg. node scripts/proof-board-edits.ts [dir]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULTS } from "../src/camera/defaults.ts";
import { renderTake } from "../src/render/render.ts";
import { editTimeline } from "../src/render/edits.ts";
import type { Beat, TakeMeta } from "../src/camera/types.ts";

const root = resolve(process.argv[2] ?? "tmp/board-edit-proof");
mkdirSync(root,{recursive:true});
const env = {...process.env, CHROME_DEVTOOLS_AXI_SESSION:`takeone-board-edits-${process.pid}`,
  CHROME_DEVTOOLS_AXI_USER_DATA_DIR:join(root,"profile"), CHROME_DEVTOOLS_AXI_CHROME_ARGS:"--headless=new",
  CHROME_DEVTOOLS_AXI_AUTO_CONNECT:"0", CHROME_DEVTOOLS_AXI_HEADED:"0"};
const browser = (...args:string[]) => execFileSync("chrome-devtools-axi",args,{env,encoding:"utf8",maxBuffer:2_000_000});
const evaluate = (js:string) => browser("eval",js);
const shot = (name:string) => browser("screenshot",join(root,`${name}.png`));
const ff = (args:string[]) => execFileSync("ffmpeg",["-nostdin","-y","-v","error",...args],{stdio:["ignore","ignore","inherit"]});
try {
  browser("open",pathToFileURL(resolve("scripts/e2e/scene.html")).href);
  browser("resize","2560","1440");
  evaluate("() => { const s=document.createElement('style');s.textContent='* { animation: none !important; transition: none !important; caret-color: transparent !important; }';document.head.append(s);return document.title; }");
  shot("board");
  evaluate("() => { document.getElementById('newTask').click(); return true; }");
  shot("modal");
  evaluate("() => { document.getElementById('title').value='Record onboarding'; return true; }");
  shot("typing");
  evaluate("() => { document.getElementById('title').value='Record onboarding video'; document.getElementById('notes').value='A polished walkthrough for the launch.'; return true; }");
  shot("typed");
  evaluate("() => { document.getElementById('prio').click(); return true; }");
  shot("priority");
  evaluate("() => { [...document.querySelectorAll('#menu .opt')].find(e=>e.textContent==='High').click(); return true; }");
  shot("high");
  evaluate("() => { document.getElementById('create').click(); return true; }");
  shot("created");
} finally { browser("stop"); }
// A deliberately staged source with exact timestamps, suitable for repeatable
// edit comparisons. Only demo DOM screenshots enter the source video.
const states = [{file:"board",d:1},{file:"modal",d:1},{file:"typing",d:1},{file:"typed",d:2},
  {file:"priority",d:1},{file:"high",d:1},{file:"created",d:8}];
const concat = states.map(s=>`file '${s.file}.png'\nduration ${s.d}`).join("\n")+"\nfile 'created.png'\n";
writeFileSync(join(root,"states.txt"),concat);
ff(["-f","concat","-safe","0","-i",join(root,"states.txt"),"-vf","fps=60,format=yuv420p","-t","15",
  "-c:v","libvpx-vp9","-crf","18","-b:v","0","-deadline","realtime","-cpu-used","8",join(root,"source.webm")]);
const beat:Beat={id:"board",kind:"type",t0:0,t1:15,anchor_t:0.5,zones:[{name:"all",type:"all",bbox:[0,0,2560,1440]}],
  actions:[{k:"click",t:1000,x:2300,y:44},{k:"type",t0:2000,t1:4000},{k:"click",t:5000,x:1090,y:800},
    {k:"click",t:6000,x:1100,y:970},{k:"click",t:7000,x:1530,y:908}]};
const base:TakeMeta={width:2560,height:1440,trim_start:0,trim_end:15,
  captions:[{t:1,d:3,text:"Create an onboarding task"},{t:5,d:2,text:"Choose the priority"},{t:7,d:3,text:"Ready for the launch"}]};
const edits={cuts:[{t0:4.2,t1:4.8}],speed:[{kind:"type_speed" as const,rate:2}],
  zooms:[{t0:1,t1:8,bbox:[940,430,680,640] as [number,number,number,number],level:3 as const}]};
const camera={...DEFAULTS,idle_speed:1,preset:"fast"};
for(const name of ["before","after"]){
  const dir=join(root,name);mkdirSync(join(dir,"analysis"),{recursive:true});
  const meta={...base,...(name==="after"?edits:{}),id:name};
  copyFileSync(join(root,"source.webm"),join(dir,"screen.webm"));
  writeFileSync(join(dir,"take.json"),JSON.stringify(meta,null,2));
  writeFileSync(join(dir,"analysis/beats.json"),JSON.stringify([beat]));
  writeFileSync(join(dir,"analysis/decisions.jsonl"),JSON.stringify({beat:beat.id,A:"all",L:0,K:1,p:0,conf:1,decided_by:"heuristic"}));
  console.log(`rendering Tidewater ${name}`);
  const result=await renderTake(dir,camera);
  const video=join(root,`takeone-board-edits-${name}.mp4`);
  copyFileSync(result.out,video);
  ff(["-ss",name==="after"?"3.8":"5.4","-i",video,"-frames:v","1",join(root,`takeone-board-edits-${name}.png`)]);
  ff(["-i",video,"-vf",`fps=16/${result.seconds},scale=480:270,tile=4x4`,"-frames:v","1",join(root,`takeone-board-edits-${name}-contact.png`)]);
}
const clock=editTimeline({...base,...edits},[beat],0,15,camera);
ff(["-i",join(root,"takeone-board-edits-after.mp4"),"-t","10","-c","copy",join(root,"takeone-board-edits-after-clip.mp4")]);
ff(["-i",join(root,"source.webm"),"-i",join(root,"takeone-board-edits-after.mp4"),"-filter_complex",
  `[0:v]${clock.filter},fps=60,scale=960:540[raw];[1:v]scale=960:540[out];[raw][out]hstack[v]`,
  "-map","[v]","-t","10","-c:v","libx264","-preset","fast","-crf","20",join(root,"takeone-board-edits-raw-vs-render.mp4")]);
ff(["-i",join(root,"takeone-board-edits-before.mp4"),"-i",join(root,"takeone-board-edits-after.mp4"),"-filter_complex",
  `[0:v]${clock.filter},fps=60,scale=960:540[old];[1:v]scale=960:540[new];[old][new]hstack[v]`,
  "-map","[v]","-t","10","-c:v","libx264","-preset","fast","-crf","20",join(root,"takeone-board-edits-side-by-side.mp4")]);
const probe=JSON.parse(execFileSync("ffprobe",["-v","error","-count_frames","-show_streams","-of","json",join(root,"takeone-board-edits-after.mp4")],{encoding:"utf8"}));
const frames=JSON.parse(readFileSync(join(root,"after/camera.json"),"utf8"));
writeFileSync(join(root,"manifest.json"),JSON.stringify({source:"scripts/e2e/scene.html",source_seconds:15,output_seconds:clock.duration,
  stream:probe.streams[0],camera_frames:frames.length,edits},null,2));
console.log(`Tidewater output evidence: ${root}`);
