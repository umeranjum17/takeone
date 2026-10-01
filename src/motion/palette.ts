import { readFileSync } from "node:fs";
import { decodePng } from "./png.ts";

/** Deterministic palette sampling from an ingested PNG. Quantize a fixed pixel lattice, never a random sample. */
export function samplePalette(file: string): { background: string; accent: string; accent_text: string } | null {
  let image;
  try { image = decodePng(readFileSync(file)); } catch { return null; }
  const buckets = new Map<number, number>();
  for (let i=0; i<image.width*image.height; i+=97) {
    const p=i*image.channels,r=image.data[p]!>>4,g=image.data[p+1]!>>4,b=image.data[p+2]!>>4;
    const key=(r<<8)|(g<<4)|b;buckets.set(key,(buckets.get(key)??0)+1);
  }
  const ranked=[...buckets].sort((a,b)=>b[1]-a[1] || a[0]-b[0]);
  const hex=(k:number)=>"#"+[(k>>8)&15,(k>>4)&15,k&15].map(v=>(v*17).toString(16).padStart(2,"0")).join("");
  const accent=ranked.find(([k,count])=>count>=3 && Math.max((k>>8)&15,(k>>4)&15,k&15)-Math.min((k>>8)&15,(k>>4)&15,k&15)>=4);
  const colour=accent?.[0]??0;
  const rgb=[(colour>>8)&15,(colour>>4)&15,colour&15].map(v=>{const n=v/15;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});
  const luminance=.2126*rgb[0]!+.7152*rgb[1]!+.0722*rgb[2]!;
  return ranked[0] ? {background:hex(ranked[0][0]),accent:hex(colour),accent_text:luminance>.179?"#000000":"#ffffff"} : null;
}
