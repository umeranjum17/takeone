import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { solveCamera } from "../camera/solver.ts";
import { DEFAULTS, type CameraDefaults } from "../camera/defaults.ts";
import type { Beat, Decision, TakeMeta } from "../camera/types.ts";

export function sendcmd(frames: {t:number;x:number;y:number;w:number;h:number}[]): string {
  return frames.map(f=>`${f.t.toFixed(6)} [enter] crop@a w ${Math.round(f.w)}, crop@a h ${Math.round(f.h)}, crop@a x ${Math.round(f.x)}, crop@a y ${Math.round(f.y)};`).join("\n")+"\n";
}
function run(args:string[]):Promise<void>{return new Promise((resolve,reject)=>{const p=spawn("ffmpeg",args,{stdio:["ignore","ignore","pipe"]});let tail="";p.stderr.setEncoding("utf8").on("data",s=>{tail=(tail+s).slice(-10000);});p.on("error",reject);p.on("close",code=>code===0?resolve():reject(new Error(`ffmpeg exited ${code}\n${tail.split("\n").slice(-20).join("\n")}`)));});}
export async function renderTake(dir:string,d:CameraDefaults=DEFAULTS):Promise<string>{
 const meta=JSON.parse(await readFile(join(dir,"take.json"),"utf8")) as TakeMeta;
 const beats=JSON.parse(await readFile(join(dir,"analysis/beats.json"),"utf8")) as Beat[];
 const decisions=(await readFile(join(dir,"analysis/decisions.jsonl"),"utf8")).split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x) as Decision);
 const frames=solveCamera(beats,decisions,meta,d); await writeFile(join(dir,"camera.json"),JSON.stringify(frames));
 const cmd=join(dir,"camera.cmd"); await writeFile(cmd,sendcmd(frames)); const out=join(dir,"out",`${meta.id??dir.split("/").at(-1)}.mp4`); await mkdir(join(dir,"out"),{recursive:true});
 await run(["-y","-ss",String(meta.trim_start??0),"-to",String(meta.trim_end??beats.at(-1)?.t1??0),"-i",join(dir,"screen.webm"),"-vf",`sendcmd=f=${cmd},crop@a=w=iw:h=ih:x=0:y=0:exact=1,scale=${d.out_w}:${d.out_h}:flags=lanczos,format=yuv420p`,"-r",String(d.fps),"-an","-c:v","libx264","-crf","18","-preset","slow","-movflags","+faststart",out]); return out;
}
