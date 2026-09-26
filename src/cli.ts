#!/usr/bin/env node
import { renderTake } from "./render/render.ts";
const [cmd,dir,...args]=process.argv.slice(2);
if(cmd!=="render"||!dir){console.error("usage: takeone render <take-dir>");process.exitCode=2;}else{
 try { const overrides:Record<string,number>={}; for(let i=0;i<args.length;i++){if(args[i]==="--set"){const [k,v]=String(args[++i]).split("=");const n=Number(v);if(!k||!Number.isFinite(n))throw Error(`invalid --set ${k}=${v}`);overrides[k]=n;}} const {applyOverrides}=await import("./camera/defaults.ts"); console.log(await renderTake(dir,applyOverrides(overrides))); }
 catch(e){console.error(e instanceof Error?e.message:e);process.exitCode=1;}
}
