import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {renderTake} from '../src/render/render.ts';
import {renderTake as beforeRender} from './before-src/render/render.ts';
import {DEFAULTS} from '../src/camera/defaults.ts';
import {keycapAss,keycapMaskAss,keycapBackdropGraph} from '../src/render/overlays.ts';
const evidence=resolve('tmp/evidence/t1-pm-12');await mkdir(evidence,{recursive:true});
const log=await readFile('tmp/overlay-take/events.txt','utf8');
const encoded=log.match(/^result: (.*)$/m)![1]!;
const events=JSON.parse(JSON.parse(encoded));
if(events.length!==4||events.some(e=>!e.trusted))throw new Error('expected four trusted real shortcuts');
const duration=20.5;
const meta={id:'overlays',width:2540,height:1360,trim_end:duration,
 captions:events.map(e=>({t:e.t/1000,d:2.3,text:e.combo==='Ctrl+K'?'Find any task on the launch board':'Save your progress'})),
 spotlight:events.filter(e=>e.combo==='Ctrl+K').map(e=>({t:e.t/1000,d:2.2,rect:[980,20,600,48]})),
 blur:[{t:0,d:duration,rect:[2000,310,490,55]}]};
const beats=events.map((e,i)=>({id:'shortcut-'+i,t0:e.t/1000,t1:e.t/1000+2.5,anchor_t:e.t/1000,
 kind:'shortcut',actions:[{k:'shortcut',t:e.t,combo:e.combo}],zones:[{name:'search',type:'act',bbox:[980,20,600,48]}]}));
const decisions=beats.map(b=>({beat:b.id,A:'search',L:1,p:0,K:0,conf:1,decided_by:'proof'}));
const defaults={...DEFAULTS,idle_speed:1,fade_s:0,preset:'fast'};
const ffmpeg=(args)=>execFileSync('ffmpeg',['-y','-v','error',...args],{maxBuffer:2000000});
for(const version of (process.argv.includes('--after-only')?['after']:['before','after'])){
 const dir=resolve('tmp/overlay-proof-'+version);await mkdir(join(dir,'analysis'),{recursive:true});
 await copyFile('tmp/overlay-take/cropped.webm',join(dir,'screen.webm'));
 await writeFile(join(dir,'take.json'),JSON.stringify(meta));
 await writeFile(join(dir,'analysis/beats.json'),JSON.stringify(beats));
 await writeFile(join(dir,'analysis/decisions.jsonl'),decisions.map(d=>JSON.stringify(d)).join('\n'));
 console.log('render',version);
 const {out}=await(version==='before'?beforeRender:renderTake)(dir,defaults);
 await copyFile(out,join(evidence,'takeone-overlays-'+version+'.mp4'));
 for(const event of events){const theme=event.theme;const key=event.combo.at(-1)!.toLowerCase();
  ffmpeg(['-ss',String(event.t/1000+0.75),'-i',out,'-frames:v','1',join(evidence,`takeone-overlays-${version}-${theme}-ctrl-${key}.png`)]);
 }
 ffmpeg(['-ss',String(events[0].t/1000-0.2),'-i',out,'-t','2.7','-an','-c:v','libx264','-crf','18',join(evidence,`takeone-overlays-${version}-ctrl-k-clip.mp4`)]);
}
for(const version of ['before','after'])await copyFile(join(evidence,`takeone-overlays-${version}-light-ctrl-k.png`),join(evidence,`takeone-overlays-${version}.png`));
ffmpeg(['-i',join(evidence,'takeone-overlays-before-ctrl-k-clip.mp4'),'-i',join(evidence,'takeone-overlays-after-ctrl-k-clip.mp4'),'-filter_complex','[0:v]scale=960:540[a];[1:v]scale=960:540[b];[a][b]hstack','-an','-c:v','libx264','-crf','18',join(evidence,'takeone-overlays-before-after-ctrl-k.mp4')]);
ffmpeg(['-i',join(evidence,'takeone-overlays-before.png'),'-i',join(evidence,'takeone-overlays-after.png'),'-filter_complex','[0:v]scale=960:540[a];[1:v]scale=960:540[b];[a][b]hstack','-frames:v','1',join(evidence,'takeone-overlays-before-after.png')]);
ffmpeg(['-i',join(evidence,'takeone-overlays-after.mp4'),'-vf',`select='${events.map(e=>`eq(n,${Math.round((e.t/1000+0.75)*defaults.fps)})`).join('+')}',scale=640:360,tile=4x1`,'-frames:v','1',join(evidence,'takeone-overlays-real-take-strip.png')]);
const macBeats=[{id:'mac',t0:0,t1:3,anchor_t:0,kind:'shortcut',zones:[],actions:[{k:'shortcut',t:500,combo:'Ctrl+Alt+Shift+Meta+K'}]}];
const macD={...DEFAULTS,keycap_style:'mac' as const};
const ass=keycapAss(macBeats,0,3,macD);
await writeFile('tmp/mac-keycaps-mask.ass',keycapMaskAss(macBeats,0,3,macD));
await writeFile('tmp/mac-keycaps.ass',ass);
ffmpeg(['-ss',String(events[0].t/1000+0.75),'-i','tmp/overlay-take/cropped.webm','-vf','scale=1920:1080','-frames:v','1','tmp/mac-background.png']);
ffmpeg(['-loop','1','-framerate','30','-i','tmp/mac-background.png','-filter_complex',`[0:v]format=yuv420p[keycapInput];${keycapBackdropGraph(3,macD,'tmp/mac-keycaps-mask.ass')};[keycapOutput]ass=tmp/mac-keycaps.ass:fontsdir=resources/fonts,select=gte(t\\,1)[out]`,'-map','[out]','-frames:v','1',join(evidence,'takeone-overlays-mac-keycaps.png')]);
await writeFile(join(evidence,'takeone-overlays-provenance.json'),JSON.stringify({events,source:'Continuous 60fps x11grab of isolated Tidewater Chromium surface; real chrome-devtools-axi key presses with trusted browser key events. Cropped off browser chrome only.',sourceCrop:[10,70,2540,1360],defaults},null,2));
console.log(evidence);
