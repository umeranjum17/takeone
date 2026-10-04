// Offline camera-contract proof from the saved synthetic board recording.
// node scripts/proof-camera-contract.ts [output-dir] [source.webm] [--reuse] [--case name]
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {DEFAULTS} from '../src/camera/defaults.ts';
import {renderTake} from '../src/render/render.ts';
import {editTimeline} from '../src/render/edits.ts';
import {cameraMetrics,reversals} from '../scripts/quality.ts';
import type {CameraFrame} from '../src/camera/types.ts';
const args=process.argv.slice(2);
const root=resolve(args[0] && !args[0].startsWith('--') ? args.shift()! : 'tmp/camera-contract-proof');
const reuse=args.includes('--reuse'); const caseAt=args.indexOf('--case'); const selected=caseAt>=0?args[caseAt+1]:undefined;
if(caseAt>=0&&!selected)throw Error('--case needs a case name');
mkdirSync(root,{recursive:true});
const source=resolve(args[0] && !args[0].startsWith('--') ? args.shift()! : 'tmp/board-edit-proof/source.webm');
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const ff=(a:string[])=>execFileSync('ffmpeg',["-nostdin","-y","-v","error","-threads","8","-filter_threads","8","-filter_complex_threads","8",...a.slice(0,-1),"-threads","8",a.at(-1)!],{stdio:['ignore','ignore','inherit']});
// Exact outer modal geometry from scripts/e2e/scene.html, box-sizing:border-box.
const bbox=[900,340,760,620];
const contexts=[{name:"sidebar",type:"win",bbox:[0,88,280,1352]},{name:"todo-context",type:"win",bbox:[320,128,520,1272]},{name:"progress-context",type:"win",bbox:[872,128,520,1272]},{name:"done-context",type:"win",bbox:[1424,128,520,1272]},{name:"activity",type:"win",bbox:[1984,128,544,1272]}];
const beat={id:'board',kind:'type',t0:0,t1:12,anchor_t:1,zones:[{name:'all',type:'all',bbox:[0,0,2560,1440]},{name:'modal',type:'act',bbox,t_change:1},...contexts],actions:[]};
const decision={beat:'board',A:'modal',L:2,K:1,p:0,conf:1,decided_by:'heuristic'};
const todo=[320,128,520,1272], progress=[872,128,520,1272], done=[1424,128,520,1272];
const created={id:'created',kind:'click',t0:7,t1:10,anchor_t:7,window_rect:todo,zones:[{name:'todo',type:'res',bbox:todo,t_change:7},{name:'progress',type:'win',bbox:progress},{name:'done',type:'win',bbox:done},contexts[0],contexts[4]],actions:[]};
const overview={id:'overview',kind:'dwell',t0:10,t1:12,anchor_t:10,window_rect:[320,128,1624,1272],zones:[{name:'columns',type:'win',bbox:[320,128,1624,1272]}],actions:[]};
const beats=[beat,created,overview];const decisions=[decision,{...decision,beat:'created',A:'todo',L:1},{...decision,beat:'overview',A:'columns',L:1}];
const base={width:2560,height:1440,trim_start:0,trim_end:12,id:'demo',captions:[{t:1,d:3,text:'Create an onboarding task'}]};
const provenance={source,source_sha256:hash(source),ui_geometry_file:resolve('scripts/e2e/scene.html'),ui_geometry_sha256:hash('scripts/e2e/scene.html'),target:bbox,result_geometry:{todo,progress,done,newCard:[336,200,488,132],appearance:7},description:'Saved source with fixture camera targets from Tidewater CSS; supplied footage is diagnostic only unless its UI geometry matches. No model call or desktop capture.'};
writeFileSync(join(root,'active-target-provenance.json'),JSON.stringify(provenance,null,2));
const manifestPath=join(root,'manifest.json');
const manifest:any=(reuse||selected)&&existsSync(manifestPath)?JSON.parse(readFileSync(manifestPath,'utf8')):{provenance,cases:{}};
manifest.provenance=provenance;
for(const name of (selected?[selected]:['portrait','square1920','manual','manual-sufficient','manual-cut','edits'])){
 const dir=join(root,name);
 if(reuse&&!existsSync(join(root,`takeone-${name}-after.mp4`)))throw Error(`${name}: missing video for receipt reuse`);
 mkdirSync(join(dir,'analysis'),{recursive:true});
 if(!reuse)copyFileSync(source,join(dir,'screen.webm'));
 const take:any={...base,id:name};
 if(name.startsWith('manual'))take.zooms=[{t0:name==='manual'?1:name==='manual-sufficient'?6:3,t1:name==='manual-sufficient'?10:name==='manual-cut'?9:8,bbox,level:3}];
 if(name==='manual-cut')take.cuts=[{t0:1.5,t1:2.5}];
 if(name==='edits'){take.cuts=[{t0:9,t1:10}];take.speed=[{t0:3,t1:5,rate:2}];}
 if(!reuse){
  // Sufficient-lead manual control starts from the full board, so the proof
  // demonstrates an actual move rather than a target already reached by auto.
  const fixtureBeats=name==='manual-sufficient'?[{...beat,zones:beat.zones.filter(z=>z.type==='all')}]:beats;
  const fixtureDecisions=name==='manual-sufficient'?[{...decision,A:'all',L:0}]:decisions;
  writeFileSync(join(dir,'take.json'),JSON.stringify(take,null,2));
  writeFileSync(join(dir,'analysis/beats.json'),JSON.stringify(fixtureBeats,null,2));
  writeFileSync(join(dir,'analysis/decisions.jsonl'),fixtureDecisions.map(d=>JSON.stringify(d)).join('\n')+'\n');
 }
 const d={...DEFAULTS,idle_speed:1,out_w:name==='portrait'||name.startsWith('manual')?1080:1920,out_h:name==='portrait'||name.startsWith('manual')?1920:name==='square1920'?1920:1080,preset:'fast'};
 const video=join(root,`takeone-${name}-after.mp4`);
 console.log(reuse?'collect':'render',name);
 const result=reuse?{out:video,seconds:JSON.parse(readFileSync(join(dir,'edit-clock.json'),'utf8')).duration}:await renderTake(dir,d);
 if(!reuse)copyFileSync(result.out,video);
 const raw=JSON.parse(readFileSync(join(dir,'camera.json'),'utf8'));const geometry=JSON.parse(readFileSync(join(dir,'render-camera.json'),'utf8')),frames:CameraFrame[]=geometry.frames;writeFileSync(join(dir,'padded-camera.json'),JSON.stringify(frames));
 const savedTake=JSON.parse(readFileSync(join(dir,'take.json'),'utf8'));
 const savedBeats=JSON.parse(readFileSync(join(dir,'analysis/beats.json'),'utf8'));
 const clock=editTimeline(savedTake,savedBeats,0,12,d);writeFileSync(join(dir,'edit-clock.json'),JSON.stringify({duration:clock.duration,filter:clock.filter,samples:Array.from({length:721},(_,i)=>({source:i/60,output:clock.at(i/60),retained:clock.contains(i/60)}))},null,2));
 ff(['-i',video,'-vf','fps=4/3,scale=270:-2,tile=4x4','-frames:v','1',join(root,`takeone-${name}-after.png`)]);
 for(const t of [0,.5,1,2,4,7.9,8,9,10,11.9].filter(t=>t<result.seconds))ff(['-ss',String(t),'-i',video,'-frames:v','1',join(root,`takeone-${name}-t${t}-after.png`)]);
 const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-show_streams','-of','json',video],{encoding:'utf8'}));
 const cornerX=frames.map(f=>(geometry.sourceOrigin.x-f.x)*d.out_w/f.w),cornerY=frames.map(f=>(geometry.sourceOrigin.y-f.y)*d.out_h/f.h),vel=(a:number[])=>a.slice(1).map((v,i)=>(v-a[i]!)*60);
 const physicalBounce=[...reversals(vel(cornerX),60,1),...reversals(vel(cornerY),60,1)].filter(h=>h<d.min_shot).length;
 const timing=JSON.parse(readFileSync(join(dir,'camera-arrivals.json'),'utf8'));
 for(const a of timing) for(const t of [a.requested,Math.ceil(a.actualArrival*60)/60,a.holdEnd-1/60,a.holdEnd].filter(t=>t>=0&&t<result.seconds))ff(['-ss',String(t),'-i',video,'-frames:v','1',join(root,`takeone-${name}-arrival-${t.toFixed(6)}-after.png`)]);
 const held=frames[4*60];
 if(!held)throw Error(`${name}: no reference frame at4s`); const samples=[0,.5,1,2,4,7.9,8,9,10,11.9].filter(t=>t<result.seconds).map(t=>({t,raw:raw[Math.round(t*60)],padded:frames[Math.round(t*60)],width_vs_held:frames[Math.round(t*60)]!.w/held.w}));
 const requestedHolds=(savedTake.zooms ?? []).map((z:any) => {
  const requested=clock.at(z.t0),holdEnd=clock.at(z.t1);
  const arrival=timing.find((a:any)=>Math.abs(a.requested-requested)<1e-9&&Math.abs(a.holdEnd-holdEnd)<1e-9);
  if(!arrival)throw Error(`${name}: missing receipt for requested hold ${requested}..${holdEnd}`);
  const measure=(from:number)=>{
   const held=frames.filter(f=>f.t>=from-1e-9&&f.t<holdEnd-1e-9);
   const error=held.map(f=>Math.max(...(['x','y','w','h'] as const).map(k=>Math.abs(f[k]-arrival.requestedFrame[k]))));
   return {from,to:holdEnd,samples:held.length,sampled_seconds:held.length/d.fps,max_geometry_error:error.length?Math.max(...error):null,
    width_range:held.length?[Math.min(...held.map(f=>f.w)),Math.max(...held.map(f=>f.w))]:null};
  };
  return {source:{from:z.t0,to:z.t1},requested:measure(requested),actual:measure(Math.max(requested,arrival.actualArrival)),arrival};
 });
 const hold=requestedHolds.length?frames.filter(f=>f.t>=requestedHolds[0].requested.from-1e-9&&f.t<requestedHolds[0].requested.to-1e-9):[];
 const seams=name==='edits'?[3,5,9,10].map(t=>{const at=clock.at(t),index=Math.round(at*60);return {source:t,output:at,frames:frames.slice(index-2,index+3)}}):[];
 const files=[join(dir,'screen.webm'),join(dir,'take.json'),join(dir,'analysis/beats.json'),join(dir,'analysis/decisions.jsonl'),join(dir,'camera.json'),join(dir,'padded-camera.json'),join(dir,'render-camera.json'),join(dir,'edit-clock.json'),join(dir,'camera-arrivals.json'),video];
 manifest.cases[name]={video,probe,arrivals:JSON.parse(readFileSync(join(dir,'camera-arrivals.json'),'utf8')),samples,requestedHolds,hold_width_range:hold.length?[Math.min(...hold.map(f=>f.w)),Math.max(...hold.map(f=>f.w))]:null,motion:cameraMetrics(frames,60,d.out_w,d.out_h,d.min_shot),physicalBounceInformOnly:{count:physicalBounce,recipe:'(screenOffset-stageViewportOrigin)*outputSize/stageViewportSize; outputpx/s epsilon1 rest1.2 fps60'},seams,hashes:Object.fromEntries(files.map(p=>[p,hash(p)]))};
 const motion=manifest.cases[name].motion;
 const receipt=manifest.cases[name].probe.streams[0];
 const invalidHolds=requestedHolds.filter((h:any)=>!Number.isFinite(h.arrival.actualArrival)||!h.actual.samples||!Number.isFinite(h.actual.max_geometry_error)||h.actual.max_geometry_error>1e-6);
 const failures=['max_upscale','zoom_speed','zoom_acceleration','pan_acceleration','pan_bounce','zoom_opposite_hold'].filter(k=>!motion[k].goalPassed);
 if(invalidHolds.length)failures.push('actual manual hold geometry or empty samples');
 if(receipt.width!==d.out_w||receipt.height!==d.out_h||receipt.r_frame_rate!=='60/1'||!Number.isFinite(Number(receipt.nb_read_frames))||Math.abs(Number(receipt.nb_read_frames)-frames.length)>1)failures.push('encoded geometry/frame clock');
 manifest.cases[name].failures=failures;
 manifest.cases[name].qualification='camera-contract diagnostic only; decoded judder/calibration, VMAF and cost acceptance require separate real-take proof';
 writeFileSync(join(root,'manifest.json'),JSON.stringify(manifest,null,2));
 if(failures.length)throw Error(`${name}: ${failures.join(', ')}`);
}
