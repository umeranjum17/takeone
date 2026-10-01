import { withPage, type FramePlan } from "./render.ts";
import type { Storyboard } from "./types.ts";
export interface BlurMetrics { enabled: boolean; blurredFrames: number; maxSamples: number; maxSpacingPx: number; peakSpeedPx: number }

export function planSpeeds(speeds: number[], fps: number): {plan: FramePlan; metrics: BlurMetrics} {
  const peak=Math.max(0,...speeds), peakAt=speeds.indexOf(peak);
  let count=0,maxSamples=1,maxSpacingPx=0;
  const samples=speeds.map((speed,i)=>{
    if(speed<=35)return undefined;
    const fast=Math.abs(i-peakAt)<fps*.25;
    let active=0;
    for (let j=0; j<6 && i-j>=0 && speeds[i-j]!>35; j++) active++;
    const ramp=active/6;
    const shutter=(.5+(speed/peak)*(1/3))*ramp;
    // Eight normally, 24 near the peak; increase only when needed to keep ghost spacing <=2 px.
    const n=Math.max(fast?24:8,Math.ceil(speed*shutter/2));
    if(n>256)throw new Error("motion too fast for 2 px blur spacing; lengthen the move");
    count++;maxSamples=Math.max(maxSamples,n);maxSpacingPx=Math.max(maxSpacingPx,speed*shutter/n);
    return Array.from({length:n},(_,j)=>((j+.5)/n-.5)*shutter);
  });
  return {plan:{samples},metrics:{enabled:true,blurredFrames:count,maxSamples,maxSpacingPx,peakSpeedPx:peak}};
}
export async function blurPlan(html: string, sb: Storyboard, frames: number): Promise<{plan:FramePlan;metrics:BlurMetrics}> {
  if(!sb.output.motion_blur)return {plan:{},metrics:{enabled:false,blurredFrames:0,maxSamples:1,maxSpacingPx:0,peakSpeedPx:0}};
  const speeds=await withPage<number[]>(html,sb.output.out_w,sb.output.out_h,b=>b.evaluate(`Array.from({length:${frames}},(_,i)=>__speed(i*1000/${sb.output.fps},(i+1)*1000/${sb.output.fps}))`));
  return planSpeeds(speeds,sb.output.fps);
}
