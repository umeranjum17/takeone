import type { CameraFrame } from "../camera/types.ts";
import { allTimelines } from "./layout.ts";
import { readingFloor } from "./storyboard.ts";
import type { Storyboard } from "./types.ts";

export function sceneCameras(sb: Storyboard): Record<string, CameraFrame[]> {
  const paths: Record<string, CameraFrame[]> = {};
  const lists = allTimelines(sb.layout, sb.scenes);
  lists.forEach((scenes, list) => scenes.forEach((scene, i) => {
    if (scene.pattern !== "zoom-tour") return;
    const screen = sb.screens[scene.screen ?? Object.keys(sb.screens)[0]!]!;
    if (!screen) throw new Error("zoom-tour: screen missing");
    const full = { x:0,y:0,w:screen.width,h:screen.height };
    const stops = scene.stops ?? [];
    // Reserve a smooth two-second move and a reading hold at every stop; cap zoom at native resolution.
    const move = 1.4;
    const establish = .4;
    const holds = stops.map(s => Math.max(1.2, s.hold ?? 0, readingFloor(s.caption ?? "")));
    const need = establish + (stops.length ? move : 0) + stops.length * move + holds.reduce((a,b) => a+b,0);
    if (scene.d < need) throw new Error(`zoom-tour.d: needs ${need.toFixed(2)} s for moves and reading holds`);
    const targets = stops.map(s => {
      const r = sb.regions.find(r => r.id === s.region)!;
      if (r.screen !== (scene.screen ?? Object.keys(sb.screens)[0])) throw new Error("zoom-tour: stops must belong to the scene screen");
      const aspect = screen.width/screen.height;
      const w = Math.min(screen.width, Math.max(r.rect[2]*1.3, r.rect[3]*1.3*aspect, Math.min(sb.output.out_w*.88,sb.output.out_h*.65*aspect)));
      const h = w/aspect;
      return {x:Math.max(0, Math.min(screen.width-w,r.rect[0]+r.rect[2]/2-w/2)),y:Math.max(0,Math.min(screen.height-h,r.rect[1]+r.rect[3]/2-h/2)),w,h};
    });
    const segments: {at:number;from:typeof full;to:typeof full}[]=[];
    let at=establish, from=full;
    targets.forEach((to,j)=>{segments.push({at,from,to});at+=move+holds[j]!;from=to;});
    if(targets.length) segments.push({at,from,to:full});
    const frames: CameraFrame[] = [];
    for (let f=0;f<=Math.ceil(scene.d*sb.output.fps);f++) {
      const t=f/sb.output.fps;
      let view=full;
      for (const segment of segments) {
        if (t<segment.at) break;
        const u=Math.min(1,(t-segment.at)/move), a=u*u*u*(u*(u*6-15)+10), {from,to}=segment;
        // Bounded rectangle interpolation avoids a projected pan reversal at a clamped screen edge.
        view={x:from.x+(to.x-from.x)*a,y:from.y+(to.y-from.y)*a,w:from.w+(to.w-from.w)*a,h:from.h+(to.h-from.h)*a};
      }
      frames.push({t,...view});
    }
    const key=sb.layout.kind === "single" ? String(i) : sb.layout.grid === "2x2" ? `master:${i}` : `${["A","B","C","D"][list]}:${i}`;
    paths[key]=frames;
  }));
  return paths;
}
