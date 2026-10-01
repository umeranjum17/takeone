// Measure the saved motion outputs, with no desktop or model access.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { motionEdgePosition } from "./motion-edge.ts";
import { join, resolve } from "node:path";
const root=resolve("tmp/evidence/t1-l8");
const reports: Record<string,unknown>={};
for(const id of ["timing","hero-reveal","zoom-tour","end-card","bento"]) {
  const video=join(root,`takeone-motion-${id}.mp4`), manifest=JSON.parse(readFileSync(join(root,`takeone-motion-${id}-render.json`),"utf8"));
  const result=JSON.parse(execFileSync("ffprobe",["-v","error","-count_frames","-show_streams","-of","json",video],{encoding:"utf8"}));
  const s=result.streams[0];
  assert.equal(s.width,1920);assert.equal(s.height,1080);assert.equal(s.codec_name,"h264");assert.equal(s.profile,"High");assert.equal(s.pix_fmt,"yuv420p");assert.equal(s.r_frame_rate,"60/1");assert.equal(s.avg_frame_rate,"60/1");assert.equal(s.color_space,"bt709");assert.equal(s.color_primaries,"bt709");assert.equal(s.color_transfer,"bt709");assert.equal(s.color_range,"tv");assert.equal(Number(s.nb_read_frames),manifest.frames);
  reports[id]={container:true,frames:Number(s.nb_read_frames),duration:Number(s.duration),blur:manifest.motion_blur};
}
const determinism=JSON.parse(readFileSync(join(root,"takeone-motion-determinism.json"),"utf8"));assert.equal(determinism.identical,true);
assert.equal(readFileSync(join(root,"takeone-motion-run1.framemd5"),"utf8"),readFileSync(join(root,"takeone-motion-run2.framemd5"),"utf8"));
const cameras=JSON.parse(readFileSync(join(root,"takeone-motion-camera-gates.json"),"utf8"));
for(const [scene,metrics] of Object.entries(cameras))for(const [name,m]of Object.entries(metrics as Record<string,{goalPassed:boolean}>))assert.equal(m.goalPassed,true,`${scene} ${name}`);
// Settled copy is compared to the actual OCR text. These strips contain only one owned line.
const png=join(root,"takeone-motion-ocr-title.png");
execFileSync("ffmpeg",["-v","error","-y","-ss","1.5","-i",join(root,"takeone-motion-timing.mp4"),"-vf","crop=1700:150:110:90","-frames:v","1",png]);
const ocr=execFileSync("tesseract",[png,"stdout","--psm","7"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim();assert.equal(ocr,"Make it move");
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
reports.regression={ssim:1,decoded_frames_identical:determinism.identical,reason:"Two renders of the same candidate have identical decoded frames; the core has no previous golden output."};
reports.banding={applicable:false,reason:"Core pages use intentional solid theme fills, not raster gradients; CSS gradient rejection is exercised by validator fixture."};
writeFileSync(join(root,"takeone-motion-gates.json"),JSON.stringify(reports,null,2));
console.log(JSON.stringify(reports));
assert.ok(captionOcr.every(c=>c.pass),"caption OCR gate failed");
assert.ok(rms<=.15,`subpixel judder gate failed ${rms}`);
