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
  for(const s of shots){const prev=accepted.at(-1);if(prev){const dwell=s.q.K===2?d.dwell_k2:d.dwell, earliest=prev.arrival+dwell;if(s.arrival<earliest){if(earliest-s.arrival>d.dwell_merge_delay){const x=Math.min(prev.a.bbox[0],s.a.bbox[0]),y=Math.min(prev.a.bbox[1],s.a.bbox[1]),r=Math.max(prev.a.bbox[0]+prev.a.bbox[2],s.a.bbox[0]+s.a.bbox[2]),b=Math.max(prev.a.bbox[1]+prev.a.bbox[3],s.a.bbox[1]+s.a.bbox[3]);s.a={...s.a,bbox:[x,y,r-x,b-y]};}s.arrival=earliest;} if(s.arrival-prev.arrival<d.min_shot)continue;} accepted.push(s);}
  for(let i=0;i<accepted.length;i++){const window=accepted.filter(s=>s.arrival>=accepted[i].arrival&&s.arrival<accepted[i].arrival+d.rate_window);if(window.length>d.rate_max){const keep=new Set([...window].sort((a,b)=>b.q.K-a.q.K).slice(0,d.rate_max));accepted=accepted.filter(s=>!window.includes(s)||keep.has(s));}}
  const settled=(b:Beat,t:number)=>{if(b.kind!=="cut"||!b.changed_frac?.length)return t;const samples=b.changed_frac;for(let i=0;i<samples.length;i++){if(samples[i].t<t||samples[i].f>=d.cut_max)continue;const end=samples[i].t+d.cut_settle_ms/1000;if(samples.some(x=>x.t>=samples[i].t&&x.t<end&&x.f>=d.cut_max))continue;return Math.max(t,end);}return t;};
  const targets=accepted.flatMap(s=>{
    const a=frame(s.a,s.q.L,width,height,s.b.window_rect,d);
    const out=[{t:settled(s.b,s.arrival),state:a,importance:s.q.K}];
    if(s.z!==s.a&&s.q.B){const changed=s.z.t_change??s.b.t1;out.push({t:changed+d.result_late,state:frame(s.z,s.q.L,width,height,s.b.window_rect,d),importance:s.q.K});}
    return out;
  }).concat(beats.filter((b,i)=>b.kind==="idle"&&b.t1-b.t0>d.idle_s&&(!beats[i+1]||beats[i+1].t0-b.t1>d.next_beat_s)).map(b=>({t:b.t0+d.breathe_s,state:frame(b.zones[0]??{name:"all",type:"all",bbox:[0,0,width,height]},1,width,height,b.window_rect,d),importance:0}))).sort((a,b)=>a.t-b.t);
  let state:CameraState={cx:width/2,cy:height/2,z:1}, moveFrom=state,moveTo=state,moveMid=state,moveHop=false,moveStart=0,moveEnd=0,idx=0,pc=state,pt=start,lastArrival=start,vx=0,vy=0;
  const out:CameraFrame[]=[];
  for(let n=0;n<=Math.floor((end-start)*fps);n++){const t=start+n/fps;while(idx<targets.length){const candidate=targets[idx].state,vw=width/state.z,vh=vw*d.out_h/d.out_w;const dist=Math.hypot(candidate.cx-state.cx,candidate.cy-state.cy)/vw+Math.abs(Math.log(candidate.z/state.z));let dur=moveDuration(dist,d);if(state.z>d.hop_zoom&&candidate.z>d.hop_zoom&&Math.hypot(candidate.cx-state.cx,candidate.cy-state.cy)/vw>d.hop_pan)dur*=d.hop_t_scale;const arrival=targets[idx].t;if(arrival-dur>t)break;idx++;if(Math.abs(candidate.cx-state.cx)<=vw*(0.5-d.deadzone_margin)&&Math.abs(candidate.cy-state.cy)<=vh*(0.5-d.deadzone_margin)&&Math.max(candidate.z/state.z,state.z/candidate.z)<d.deadzone_zoom)continue;moveFrom=state;moveTo=candidate;moveHop=moveFrom.z>d.hop_zoom&&moveTo.z>d.hop_zoom&&Math.hypot(moveTo.cx-moveFrom.cx,moveTo.cy-moveFrom.cy)/vw>d.hop_pan;moveMid=moveHop?{cx:(moveFrom.cx+moveTo.cx)/2,cy:(moveFrom.cy+moveTo.cy)/2,z:Math.max(1,Math.min(moveFrom.z,moveTo.z)/d.hop_zoom_div)}:moveFrom;moveEnd=arrival;moveStart=moveEnd-dur;lastArrival=arrival;}
    if(t>=moveStart&&t<moveEnd){let u=clamp((t-moveStart)/(moveEnd-moveStart),0,1),from=moveFrom,to=moveTo;if(moveHop){if(u<.5){u*=2;to=moveMid;}else{u=(u-.5)*2;from=moveMid;}}u=smooth(u);state={cx:lerp(from.cx,to.cx,u),cy:lerp(from.cy,to.cy,u),z:Math.exp(lerp(Math.log(from.z),Math.log(to.z),u))};}else if(t>=moveEnd)state=moveTo;
    const active=beats.find(b=>b.t0<=t&&b.t1>=t&&["drag","travel","type"].includes(b.kind));if(active){const pointer=[...active.actions].reverse().map(a=>a as {x?:number;y?:number;t?:number}).find(a=>Number.isFinite(a.x)&&Number.isFinite(a.y))??(()=>{const decision=byId.get(active.id),z=active.zones.find(zone=>zone.name===decision?.A);return z?{x:z.bbox[0]+z.bbox[2]/2,y:z.bbox[1]+z.bbox[3]/2}:undefined;})();if(pointer){const vw=width/state.z,vh=vw*d.out_h/d.out_w,dx=(pointer.x as number)-state.cx,dy=(pointer.y as number)-state.cy;if(Math.abs(dx)>vw*d.follow_inner/2||Math.abs(dy)>vh*d.follow_inner/2){const dt=Math.max(0,t-pt),w=d.follow_omega,ex=Math.exp(-w*dt),ox=pc.cx-(pointer.x as number),oy=pc.cy-(pointer.y as number);state={...state,cx:(pointer.x as number)+(ox+(vx+w*ox)*dt)*ex,cy:(pointer.y as number)+(oy+(vy+w*oy)*dt)*ex};vx=(vx-w*(vx+w*ox)*dt)*ex;vy=(vy-w*(vy+w*oy)*dt)*ex;}}}
    state={cx:lowpass(pc.cx,state.cx,t-pt,d.lowpass_omega),cy:lowpass(pc.cy,state.cy,t-pt,d.lowpass_omega),z:Math.exp(lowpass(Math.log(pc.z),Math.log(state.z),t-pt,d.lowpass_omega))};pc=state;pt=t;const f=stateFrame(state,width,height,d);out.push({...f,t:t-start});}
  return out;
}
