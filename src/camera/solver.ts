import { DEFAULTS, type CameraDefaults } from "./defaults.ts";
import type { Beat, CameraFrame, CameraState, Decision, TakeMeta, Zone } from "./types.ts";

export function zMax(width: number, d: CameraDefaults = DEFAULTS): number { return Math.max(1, width / (d.out_w / d.max_upscale)); }
function clamp(v: number, a: number, b: number): number { return Math.max(a, Math.min(b, v)); }
function stateFrame(s: CameraState, width: number, height: number, d: CameraDefaults): CameraFrame {
  const z = clamp(s.z, 1, zMax(width, d)), w = width / z, h = w * d.out_h / d.out_w;
  const x = clamp(s.cx - w / 2, 0, Math.max(0, width - w)), y = clamp(s.cy - h / 2, 0, Math.max(0, height - h));
  return { t: 0, x, y, w, h };
}
export function frame(zone: Zone, level: number, width: number, height: number, windowRect?: [number,number,number,number], d: CameraDefaults = DEFAULTS): CameraState {
  if (level === 0 || zone.type === "all") return { cx: width / 2, cy: height / 2, z: 1 };
  const [x,y,bw,bh] = zone.bbox;
  let r: [number,number,number,number] = level === 1 && windowRect && x >= windowRect[0] && y >= windowRect[1] && x+bw <= windowRect[0]+windowRect[2] && y+bh <= windowRect[1]+windowRect[3] ? windowRect : [x-bw*((level===1?d.l1_pad:level===2?d.l2_pad:d.l3_pad)-1)/2, y-bh*((level===1?d.l1_pad:level===2?d.l2_pad:d.l3_pad)-1)/2, bw*(level===1?d.l1_pad:level===2?d.l2_pad:d.l3_pad), bh*(level===1?d.l1_pad:level===2?d.l2_pad:d.l3_pad)];
  const aspect=d.out_w/d.out_h; let [rx,ry,rw,rh]=r;
  if (rw/rh < aspect) { const n=rw/aspect; ry+=(rh-n)/2; rh=n; } else { const n=rh*aspect; rx+=(rw-n)/2; rw=n; }
  const z=clamp(width/rw,1,zMax(width,d)); return {cx:rx+rw/2,cy:ry+rh/2,z};
}
export function moveDuration(drift: number, d: CameraDefaults = DEFAULTS): number { return clamp(d.move_t_min+d.move_t_slope*Math.log2(1+Math.max(0,drift)),d.move_t_min,d.move_t_max); }
const smooth=(u:number)=>u*u*u*(u*(u*6-15)+10);
function lowpass(prev:number,target:number,dt:number,omega:number):number { const e=Math.exp(-omega*Math.max(0,dt)); return target+(prev-target)*(1+omega*Math.max(0,dt))*e; }
function lerp(a:number,b:number,u:number){return a+(b-a)*u;}

export function solveCamera(beats: Beat[], decisions: Decision[], take: TakeMeta, d: CameraDefaults = DEFAULTS): CameraFrame[] {
  const width=take.width,height=take.height,fps=d.fps,start=take.trim_start??0,end=take.trim_end??Math.max(0,...beats.map(b=>b.t1));
  const byId=new Map(decisions.map(x=>[x.beat,x]));
  let shots=beats.flatMap(b=>{const q=byId.get(b.id),a=b.zones.find(z=>z.name===q?.A),z=b.zones.find(v=>v.name===q?.B)||a;if(!q||!a)return[];return [{b,q,a,z,arrival:Math.max(start,b.anchor_t-d.anchor_early)}];}).sort((a,b)=>a.arrival-b.arrival);
  // Suppress scroll reframing; rate and dwell limits drop low-importance excess.
  shots=shots.filter(s=>s.b.kind!=="scroll");
  let accepted:typeof shots=[];
  for(const s of shots){const prev=accepted.at(-1);if(prev){const dwell=s.q.K===2?d.dwell_k2:d.dwell, earliest=prev.arrival+dwell;if(s.arrival<earliest){if(earliest-s.arrival>d.dwell_merge_delay)continue;s.arrival=earliest;} if(s.arrival-prev.arrival<d.min_shot)continue;} accepted.push(s);}
  const arrivals:number[]=[]; accepted=accepted.filter(s=>{while(arrivals.length&&s.arrival-arrivals[0]>=d.rate_window)arrivals.shift();if(arrivals.length>=d.rate_max){const weakest=accepted.slice(Math.max(0,accepted.indexOf(s)-d.rate_max+1),accepted.indexOf(s)+1).sort((a,b)=>a.q.K-b.q.K)[0];if(weakest===s)return false;const ix=accepted.indexOf(weakest); if(ix>=0)accepted.splice(ix,1); } arrivals.push(s.arrival);return true;});
  const targets=accepted.map(s=>({t:s.arrival,state:frame(s.a,s.q.L,width,height,s.b.window_rect,d)}));
  let state:CameraState={cx:width/2,cy:height/2,z:1}, moveFrom=state,moveTo=state,moveStart=0,moveEnd=0,idx=0,pc=state,pt=start;
  const out:CameraFrame[]=[];
  for(let n=0;n<=Math.floor((end-start)*fps);n++){const t=start+n/fps;while(idx<targets.length&&targets[idx].t<=t){moveFrom=state;moveTo=targets[idx].state;const viewport=width/moveFrom.z,dist=Math.hypot(moveTo.cx-moveFrom.cx,moveTo.cy-moveFrom.cy)/viewport+Math.abs(Math.log(moveTo.z/moveFrom.z));let dur=moveDuration(dist,d);if(moveFrom.z>d.hop_zoom&&moveTo.z>d.hop_zoom&&Math.hypot(moveTo.cx-moveFrom.cx,moveTo.cy-moveFrom.cy)/viewport>d.hop_pan)dur*=d.hop_t_scale;moveEnd=targets[idx].t;moveStart=moveEnd-dur;idx++;}
    if(t>=moveStart&&t<moveEnd){const u=smooth(clamp((t-moveStart)/(moveEnd-moveStart),0,1));state={cx:lerp(moveFrom.cx,moveTo.cx,u),cy:lerp(moveFrom.cy,moveTo.cy,u),z:Math.exp(lerp(Math.log(moveFrom.z),Math.log(moveTo.z),u))};}else if(t>=moveEnd)state=moveTo;
    state={cx:lowpass(pc.cx,state.cx,t-pt,d.lowpass_omega),cy:lowpass(pc.cy,state.cy,t-pt,d.lowpass_omega),z:Math.exp(lowpass(Math.log(pc.z),Math.log(state.z),t-pt,d.lowpass_omega))};pc=state;pt=t;const f=stateFrame(state,width,height,d);out.push({t:t-start,...f});}
  return out;
}
