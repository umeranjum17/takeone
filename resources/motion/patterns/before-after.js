// Before/after: one device, the after screen wipes in from the right over the before screen behind a handle.
PATTERNS["before-after"] = (layer,s,ctx) => {
  const {W,H}=ctx,after=ctx.screen(s.screen),before=ctx.screen(s.before);
  const {width:cw,height:ch}=heroSize(after,s,W,H);
  const {frame,viewport,img}=deviceFrame(after,s.device??"browser",cw,ch);
  const under=img.cloneNode();under.src=before.url;viewport.prepend(under);
  img.style.cssText+=";position:absolute;inset:0";under.style.cssText+=";position:absolute;inset:0";
  const handle=h(`<div data-moves style="position:absolute;top:0;bottom:0;width:0;border-left:3px solid var(--design-accent, var(--ink))"><svg width="56" height="56" viewBox="0 0 56 56" style="position:absolute;left:-29.5px;top:calc(50% - 28px)"><circle cx="28" cy="28" r="26" fill="var(--card)" stroke="var(--design-accent, var(--ink))" stroke-width="3"/><path d="M23 20 L15 28 L23 36 M33 20 L41 28 L33 36" fill="none" stroke="var(--design-accent, var(--ink))" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`);
  viewport.append(handle);
  const stage=h(`<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center"></div>`);
  stage.append(frame);
  const label=(text,side)=>h(`<div style="position:absolute;top:50%;${side}:${(W-cw)/4}px;transform:translate(${side==="left"?"-50%":"50%"},-50%);font:400 ${Math.min(W*.04,H*.07)}px/1 var(--display);color:var(--text)">${text}</div>`);
  const was=label("Before","left"),now=label("After","right");
  layer.append(stage,was,now);
  K(frame,[[0,{opacity:0,transform:"translateY(30px) scale(.96)"},SMOOTH],[600,{opacity:1,transform:"none"}],[s.d*1000,{opacity:1,transform:"scale(1.02)"}]]);
  K(was,[[0,{opacity:0},SMOOTH],[500,{opacity:1}],[1400,{opacity:1,color:"var(--text)"},SMOOTH],[2600,{opacity:1,color:"var(--muted)"}]]);
  K(now,[[0,{opacity:0},SMOOTH],[500,{opacity:1}],[1400,{opacity:1,color:"var(--muted)"},SMOOTH],[2600,{opacity:1,color:"var(--text)"}]]);
  tick(ms=>{const p=100*(1-smootherstep((ms-1400)/1200));img.style.clipPath=`inset(0 0 0 ${p}%)`;handle.style.left=`${p}%`;handle.style.opacity=String(smootherstep((ms-900)/400)*(1-smootherstep((ms-2700)/400)));});
};
