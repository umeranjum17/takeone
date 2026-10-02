// Reproducible edit-control fixtures and visual proof; fictional UI, no capture.
// node scripts/synth-edits.ts [output-dir]
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULTS } from "../src/camera/defaults.ts";
import { renderTake } from "../src/render/render.ts";
import { cameraMetrics } from "./quality.ts";
import { editTimeline } from "../src/render/edits.ts";
import type { Beat, CameraFrame, TakeMeta } from "../src/camera/types.ts";

const root = resolve(process.argv[2] ?? "tmp/edit-proof");
mkdirSync(root, { recursive: true });
const font = ["/usr/share/fonts/Adwaita/AdwaitaSans-Regular.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/liberation/LiberationSans-Regular.ttf"].find(existsSync);
if (!font) throw new Error("synth-edits: a sans-serif font is required");
const ff = (args: string[]) => execFileSync("ffmpeg", ["-nostdin", "-y", "-v", "error", ...args], {stdio: ["ignore","ignore","inherit"]});
const text = (s: string, x: number, y: number, size: number, enable?: string) =>
  `drawtext=fontfile=${font}:text='${s}':x=${x}:y=${y}:fontsize=${size}:fontcolor=0x202124${enable ? `:enable='${enable}'` : ""}`;
const source = join(root, "source.webm");
const titleFile = join(root, "title.txt");
writeFileSync(titleFile, "TakeOne   /   Umer's demo workspace\n");
const sourceGraph = [
  "drawbox=x=0:y=0:w=1920:h=80:color=white:t=fill", `drawtext=fontfile=${font}:textfile=${titleFile}:x=64:y=24:fontsize=28:fontcolor=0x202124`,
  "drawbox=x=0:y=80:w=300:h=1000:color=0xe9eef5:t=fill", text("Reports",60,160,28), text("Overview",60,240,24), text("Members",60,320,24),
  text("Quarterly reports",400,200,48), text("Find the report, then export",400,275,28),
  "drawbox=x=400:y=350:w=1200:h=90:color=white:t=fill", text("Search",430,380,28,"lt(t,3)"),
  text("q",430,380,28,"between(t,3,3.6)"), text("qua",430,380,28,"between(t,3.6,4.2)"),
  text("quarter",430,380,28,"between(t,4.2,5)"), text("quarterly",430,380,28,"gte(t,5)"),
  "drawbox=x=400:y=510:w=1200:h=320:color=white:t=fill", text("Quarterly summary",450,560,36),
  text("Owner   Umer",450,630,28), text("Status   Ready for review",450,690,28),
  "drawbox=x=1370:y=710:w=170:h=65:color=0x356fe0:t=fill", text("Export",1400,725,28),
  text("Export complete",1160,900,32,"gte(t,9)"),
];
// drawbox does not re-evaluate t. An overlay provides an actual source-clock bar.
ff(["-f","lavfi","-i","color=c=0xf6f8fb:s=1920x1080:r=60:d=12", "-f","lavfi","-i","color=c=0x356fe0:s=1920x12:r=60:d=12",
  "-filter_complex",`[0:v]${sourceGraph.join(",")}[ui];[ui][1:v]overlay=x='-1920+1920*t/12':y=1050[v]`, "-map","[v]",
  "-c:v","libvpx-vp9","-crf","18","-b:v","0","-deadline","realtime","-cpu-used","8",source]);
const beat: Beat = { id:"report", kind:"type", t0:0, t1:12, anchor_t:1,
  zones:[{name:"all",type:"all",bbox:[0,0,1920,1080]}],
  actions:[{k:"click",t:3000,x:450,y:380},{k:"type",t0:3000,t1:7000},{k:"click",t:9000,x:1450,y:740}],
};
const base: TakeMeta = {id:"demo",width:1920,height:1080,trim_start:0,trim_end:12,
  captions:[{t:1,d:2,text:"Find any report"},{t:9,d:2,text:"Export in one click"}]};
const cases: Record<string, Partial<TakeMeta>> = {
  before: {}, cuts: {cuts:[{t0:4,t1:6}]}, speed:{speed:[{t0:3,t1:7,rate:2}]},
  typing:{speed:[{kind:"type_speed",rate:3}]}, zooms:{zooms:[{t0:2,t1:8,bbox:[400,350,1200,90],level:3}]},
  after:{cuts:[{t0:7,t1:8}],speed:[{kind:"type_speed",rate:2}],zooms:[{t0:2,t1:8,bbox:[400,350,1200,90],level:3}]},
};
const d = {...DEFAULTS,idle_speed:1,out_w:1920,out_h:1080,preset:"fast"};
const manifest: Record<string, unknown> = {};
for (const [name, edits] of Object.entries(cases)) {
  const dir = join(root,name);
  mkdirSync(join(dir,"analysis"),{recursive:true});
  copyFileSync(source,join(dir,"screen.webm"));
  writeFileSync(join(dir,"take.json"),JSON.stringify({...base,...edits,id:name},null,2));
  writeFileSync(join(dir,"analysis/beats.json"),JSON.stringify([beat]));
  writeFileSync(join(dir,"analysis/decisions.jsonl"),JSON.stringify({beat:beat.id,A:"all",L:0,K:1,p:0,conf:1,decided_by:"heuristic"}));
  console.log(`rendering ${name}`);
  const result = await renderTake(dir,d);
  const video = join(root,`takeone-edit-controls-${name}.mp4`);
  copyFileSync(result.out,video);
  const sheet = join(root,`takeone-edit-controls-${name}.png`);
  ff(["-i",video,"-vf",`fps=16/${result.seconds},scale=480:270,tile=4x4`,"-frames:v","1",sheet]);
  const clock = editTimeline({...base,...edits},[beat],0,12,d);
  // Align raw and rendered footage through the exact same edit map.
  ff(["-i",source,"-i",video,"-filter_complex",`[0:v]${clock.filter},fps=60,scale=960:540[raw];[1:v]scale=960:540[render];[raw][render]hstack[v]`,
    "-map","[v]","-t",String(result.seconds),"-c:v","libx264","-preset","fast","-crf","20",join(root,`takeone-edit-controls-${name}-raw-vs-render.mp4`)]);
  const frames = JSON.parse(readFileSync(join(dir,"render-camera.json"),"utf8")).frames as CameraFrame[];
  const probe = JSON.parse(execFileSync("ffprobe",["-v","error","-count_frames","-show_streams","-of","json",video],{encoding:"utf8"}));
  const stream = probe.streams[0];
  const metrics = cameraMetrics(frames, d.fps, d.out_w, d.out_h, d.min_shot);
  const maxUpscale = metrics.max_upscale!.value;
  if (stream.r_frame_rate !== "60/1" || stream.width !== 1920 || stream.height !== 1080
    || stream.color_space !== "bt709" || stream.color_range !== "tv"
    || Math.abs(Number(stream.nb_read_frames) - frames.length) > 1 || maxUpscale > 1.5
    || metrics.zoom_speed!.value > 1 || metrics.zoom_acceleration!.value > 4 || metrics.pan_acceleration!.value > 9000) {
    throw new Error(`synth-edits: ${name} failed video or camera gates`);
  }
  const arrivals = (edits.zooms ?? []).map(z => Math.min(result.seconds-0.1,clock.at(z.t0)+2));
  for (const [i,t] of [clock.at(1)+0.5,clock.at(9)+0.5,...arrivals].entries()) {
    const crop = i < 2 ? "crop=1920:240:0:840" : "crop=960:540:480:270";
    ff(["-ss",String(t),"-i",video,"-vf",crop,"-frames:v","1",join(root,`takeone-edit-controls-${name}-crop-${i}.png`)]);
  }
  manifest[name]={video,sheet,seconds:result.seconds,fps:stream.r_frame_rate,size:[stream.width,stream.height],
    frames:Number(stream.nb_read_frames),camera_frames:frames.length,colour:stream.color_space,max_upscale:maxUpscale,camera:metrics};
}
// Review both outputs on the edited output clock. Map the unedited baseline to
// the after clock, so typing and cut sections line up instead of drifting.
const afterClock = editTimeline({...base,...cases.after},[beat],0,12,d);
ff(["-i",join(root,"takeone-edit-controls-before.mp4"),"-i",join(root,"takeone-edit-controls-after.mp4"),
  "-filter_complex",`[0:v]${afterClock.filter},fps=60,scale=960:540[old];[1:v]scale=960:540[new];[old][new]hstack[v]`,
  "-map","[v]","-t",String(afterClock.duration),"-c:v","libx264","-preset","fast","-crf","20",join(root,"takeone-edit-controls-side-by-side.mp4")]);
// Report the low-SSIM frames for human review; framing changes are expected.
execFileSync("ffmpeg",["-nostdin","-v","info","-i",join(root,"takeone-edit-controls-before.mp4"),
  "-i",join(root,"takeone-edit-controls-after.mp4"),"-filter_complex",`[0:v]${afterClock.filter},fps=60[old];[old][1:v]ssim=stats_file=${join(root,"ssim.log")}`,
  "-t",String(afterClock.duration),"-f","null","-"],{encoding:"utf8",stdio:["ignore","ignore","pipe"]});
const lowSsim = readFileSync(join(root,"ssim.log"),"utf8").split("\n").flatMap(line=> {
  const m=line.match(/n:(\d+).*All:([\d.]+)/);return m && Number(m[2])<0.95 ? [{frame:Number(m[1]),ssim:Number(m[2])}] : [];
});
writeFileSync(join(root,"manifest.json"),JSON.stringify({fixtures:manifest,low_ssim:lowSsim},null,2));
console.log(`visual proof: ${root}`);
