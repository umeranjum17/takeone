PATTERNS["zoom-tour"] = (layer,s,ctx) => {
  const {W,H}=ctx,scr=ctx.screen(s.screen),cw=Math.min(W*.88,H*.65*scr.width/scr.height),ch=cw*scr.height/scr.width;
  const {frame,img,viewport}=deviceFrame(scr,s.device??"browser",cw,ch);
  frame.style.cssText+=`;position:absolute;left:${(W-cw)/2}px;top:${H*.08}px`;
  img.style.cssText=`position:absolute;left:0;top:0;width:${scr.width}px;height:${scr.height}px;max-width:none;transform-origin:0 0`;
  img.dataset.moves="";
  layer.append(frame);
  const paths=ctx.camera;
  const caption=h(`<div style="position:absolute;bottom:8%;left:50%;transform:translateX(-50%);padding:16px 28px;border-radius:var(--radius);background:var(--card);color:var(--ink);font:${Math.min(W*.024,H*.04)}px var(--body);white-space:nowrap"></div>`);
  layer.append(caption);
  tick(ms=>{
    const t=Math.max(0,Math.min(s.d,ms/1000)),f=t*ctx.fps,i=Math.min(Math.floor(f),Math.max(0,(paths?.length??1)-2)),a=f-i;
    const p=paths?.[i]??{x:0,y:0,w:scr.width,h:scr.height},q=paths?.[i+1]??p;
    const x=p.x+(q.x-p.x)*a,y=p.y+(q.y-p.y)*a,w=p.w+(q.w-p.w)*a;
    img.style.transform=`scale(${cw/w}) translate(${-x}px,${-y}px)`;
    let start=.4,txt="";
    for(const stop of s.stops??[]) { const hold=Math.max(1.2,stop.hold??0,.3*(stop.caption??"").split(/\s+/).filter(Boolean).length+.8); if(t>=start+.6) txt=stop.caption??""; start+=1.4+hold; }
    caption.textContent=txt; caption.style.display=txt ? "block" : "none";
  });
};
