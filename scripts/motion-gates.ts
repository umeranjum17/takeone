// Measure the saved motion outputs, with no desktop or model access.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { compare, widestRun } from "./quality.ts";
import { motionEdgePosition } from "./motion-edge.ts";
import { join, resolve } from "node:path";
const root=resolve("tmp/evidence/t1-l8");
const reports: Record<string,unknown>={};
const failures:string[]=[];
const regressions:Record<string,unknown>={};
const duplicates:Record<string,unknown>={};
for(const id of ["timing","hero-reveal","zoom-tour","end-card","bento"]) {
  const video=join(root,`takeone-motion-${id}.mp4`), manifest=JSON.parse(readFileSync(join(root,`takeone-motion-${id}-render.json`),"utf8"));
  const result=JSON.parse(execFileSync("ffprobe",["-v","error","-count_frames","-show_streams","-of","json",video],{encoding:"utf8"}));
  const s=result.streams[0];
  assert.equal(s.width,1920);assert.equal(s.height,1080);assert.equal(s.codec_name,"h264");assert.equal(s.profile,"High");assert.equal(s.pix_fmt,"yuv420p");assert.equal(s.r_frame_rate,"60/1");assert.equal(s.avg_frame_rate,"60/1");assert.equal(s.color_space,"bt709");assert.equal(s.color_primaries,"bt709");assert.equal(s.color_transfer,"bt709");assert.equal(s.color_range,"tv");assert.equal(Number(s.nb_read_frames),manifest.frames);
  reports[id]={container:true,frames:Number(s.nb_read_frames),duration:Number(s.duration),blur:manifest.motion_blur};
  const qualityDir=join(root,`encoder-${id}`);mkdirSync(qualityDir,{recursive:true});
  const regression=compare(video,join(root,`takeone-motion-${id}-reference.mkv`),qualityDir,true);
  regressions[id]=regression;
  if(regression.timelineMismatch || !Number.isFinite(regression.minSSIM)) failures.push(`${id}: invalid encoder comparison`);
  if(regression.vmaf===null || !Number.isFinite(regression.vmaf) || regression.vmaf<95) failures.push(`${id}: encoder VMAF must be >=95`);
  if(regression.framesBelow095.length) failures.push(`${id}: ${regression.framesBelow095.length} frames need human SSIM review`);
  if(manifest.camera) {
    const dir=resolve("tmp/motion-proof",id),story=JSON.parse(readFileSync(join(dir,"storyboard.json"),"utf8"));
    const paths=JSON.parse(readFileSync(join(dir,"camera-scenes.json"),"utf8"));
    const md5=execFileSync("ffmpeg",["-v","error","-i",video,"-f","framemd5","-"],{encoding:"utf8",maxBuffer:16e6}).split("\n").filter(line=>line && !line.startsWith("#")).map(line=>line.split(",").at(-1)!.trim());
    const movingDuplicates:number[]=[];
    for(let f=1;f<md5.length;f++) {
      const pairs: [Record<string,number> | undefined,Record<string,number> | undefined][]=[];
      const add=(scenes:{at:number;d:number}[],prefix:string,offset:number)=>{
        const t=f/60+offset,previous=(f-1)/60+offset;
        scenes.forEach((scene,i)=>{
          if(previous<scene.at || t>=scene.at+scene.d)return;
          const n=Math.round((t-scene.at)*60),path=paths[prefix+i];
          pairs.push([path?.[n-1],path?.[n]]);
        });
      };
      if(story.layout.kind==="single")add(story.scenes,"",0);
      else if(story.layout.grid==="2x2")for(const tile of story.layout.tiles)add(story.layout.master.scenes,"master:",tile.offset_s);
      else for(const [tile,scenes]of Object.entries(story.layout.tiles))add(scenes as {at:number;d:number}[],tile+":",0);
      const moving=pairs.some(([a,b])=>a && b && ["x","y","w","h"].some(k=>Math.abs(a[k]-b[k])>1e-7));
      if(moving && md5[f]===md5[f-1])movingDuplicates.push(f);
    }
    duplicates[id]={frames:movingDuplicates,pass:movingDuplicates.length===0};
    if(movingDuplicates.length)failures.push(`${id}: moving-camera duplicate frames`);
  }
  const metrics=JSON.parse(readFileSync(join(root,`takeone-motion-${id}-camera-gates.json`),"utf8"));
  for(const [scene,values]of Object.entries(metrics))for(const [name,m]of Object.entries(values as Record<string,{goalPassed:boolean}>))assert.equal(m.goalPassed,true,`${id} ${scene} ${name}`);
}
const determinism=JSON.parse(readFileSync(join(root,"takeone-motion-determinism.json"),"utf8"));assert.equal(determinism.identical,true);
assert.equal(readFileSync(join(root,"takeone-motion-run1.framemd5"),"utf8"),readFileSync(join(root,"takeone-motion-run2.framemd5"),"utf8"));
// Settled copy is compared to the actual OCR text. These strips contain only one owned line.
const png=join(root,"takeone-motion-ocr-title.png");
execFileSync("ffmpeg",["-v","error","-y","-ss","1.5","-i",join(root,"takeone-motion-timing.mp4"),"-vf","crop=1700:150:110:90","-frames:v","1",png]);
const ocr=execFileSync("tesseract",[png,"stdout","--psm","7"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim();assert.equal(ocr,"Make it move");
assert.equal(determinism.timing_pass,true);assert.ok(determinism.wall_s<=15,"timing exceeds 15 seconds");
reports.ocr={expected:"Make it move",actual:ocr,pass:true};reports.determinism=determinism;
const captionTexts=["Launch board","Draft your launch","Task created","Keep work moving","Umer moved it","Done tasks archived"];
const captionOcr=[];
for(const [i,text]of captionTexts.entries()) {
 const strip=join(root,`takeone-motion-caption-${i+1}.png`);
 execFileSync("ffmpeg",["-v","error","-y","-ss",String(i*5+3),"-i",join(root,"takeone-motion-zoom-tour.mp4"),"-vf","crop=1700:110:110:900","-frames:v","1",strip]);
 const actual=execFileSync("tesseract",[strip,"stdout","--psm","7"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim();captionOcr.push({text,actual,pass:actual===text});
}
reports.caption_ocr=captionOcr;
// Follow a straight modal edge through the camera arrival at native 60 fps.
const rows=execFileSync("ffmpeg",["-v","error","-ss","5.4","-t","1.4","-i",join(root,"takeone-motion-zoom-tour.mp4"),"-vf","crop=1920:100:0:400,format=gray","-f","rawvideo","-"],{maxBuffer:32e6});
const paths=JSON.parse(readFileSync(resolve("tmp/motion-proof/zoom-tour/camera-scenes.json"),"utf8"))["1"];
const residuals:number[]=[];
for(let f=0;f<Math.floor(rows.length/(1920*100));f++) {
 const p=paths[24+f],predicted=338+(900-p.x)*1248/p.w;
 const y=Math.round(86.4+2+52.65+(600-p.y)*1248/p.w)-400;
 if(y<0||y>=100)continue;
 const row=rows.subarray(f*192000+y*1920,f*192000+(y+1)*1920),edge=motionEdgePosition(row,predicted);
 if(edge===null)throw new Error("missing moving modal edge");residuals.push(edge-predicted);
}
const jitter=residuals.slice(2).map((v,i)=>v-2*residuals[i+1]!+residuals[i]!);
const rms=Math.sqrt(jitter.reduce((a,b)=>a+b*b,0)/jitter.length);
reports.subpixel_judder={rms,samples:jitter.length,pass:rms<=.15};
reports.encoder_regression=regressions;
reports.moving_camera_duplicates=duplicates;
const rampRows=(input:string)=>execFileSync("ffmpeg",["-v","error","-i",input,"-vf","crop=1920:1:0:540:exact=1,format=gray","-frames:v","1","-f","rawvideo","-"],{maxBuffer:1e6});
const rampReference=rampRows(join(root,"takeone-motion-ramp-reference.png"));
assert.equal(rampReference.length,1920);assert.ok(Math.max(...rampReference)-Math.min(...rampReference)>150,"banding fixture must be a smooth ramp");
assert.ok(widestRun(rampReference)<=64,"reference ramp must meet banding bound");
const ramp=rampRows(join(root,"takeone-motion-ramp.mp4"));
assert.equal(ramp.length,1920);
const flatRun=widestRun(ramp);
reports.banding={widest_flat_run:flatRun,limit:64,pass:flatRun<=64};
if(flatRun>64)failures.push(`banding flat run ${flatRun}>64`);
reports.failures=failures;
writeFileSync(join(root,"takeone-motion-gates.json"),JSON.stringify(reports,null,2));
console.log(JSON.stringify(reports));
assert.ok(captionOcr.every(c=>c.pass),"caption OCR gate failed");
assert.ok(rms<=.15,`subpixel judder gate failed ${rms}`);

assert.deepEqual(failures,[],failures.join("; "));
