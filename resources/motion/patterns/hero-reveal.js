PATTERNS["hero-reveal"] = (layer,s,ctx) => {
  const {W,H}=ctx,scr=ctx.screen(s.screen),portrait=H>W;
  const phone=s.device==="phone";
  const cw=phone ? Math.min(W*.6,H*.3) : Math.min(W*.78,H*.58*scr.width/scr.height),ch=phone ? H*.52 : cw*scr.height/scr.width;
  const {frame}=deviceFrame(scr,s.device??"browser",cw,ch);
  frame.style.cssText+=`;position:absolute;left:${(W-cw)/2}px;top:${H*.34}px;transform-origin:center`;
  const title=h(`<div style="position:absolute;left:6%;right:6%;top:10%;text-align:center;font:400 ${Math.min(W*.06,H*.1)}px/1.1 var(--display);color:var(--text)">${(s.title??"").split(/\s+/).filter(Boolean).map(word=>`<span style="display:inline-block;overflow:hidden;vertical-align:bottom"><span class="hero-word" style="display:inline-block">${esc(word)}</span></span>`).join(" ")}</div>`);
  const sub=h(`<div style="position:absolute;left:6%;right:6%;top:24%;text-align:center;font:${Math.min(W*.023,H*.038)}px/1.2 var(--body);color:var(--text)">${esc(s.subtitle??"")}</div>`);
  layer.append(frame,title,sub);
  K(frame,[[0,{transform:"translateY(30px) scale(.96)",opacity:0}],[600,{transform:"none",opacity:1},SMOOTH],[s.d*1000,{transform:`scale(${1+(s.push??.03)})`,opacity:1}]]);
  $$(".hero-word",title).forEach((word,i)=>K(word,[[i*60,{transform:"translateY(105%)"}],[400+i*60,{transform:"none"},SMOOTH]]));
  if(s.focus) {const r=ctx.region(s.focus);frame.style.transformOrigin=`${(r.rect[0]+r.rect[2]/2)/scr.width*100}% ${(r.rect[1]+r.rect[3]/2)/scr.height*100}%`;}
  K(title,[[0,{opacity:1,transform:"none"}],[s.d*1000,{opacity:1,transform:"scale(1.03)"}]]);
  K(sub,[[0,{opacity:0}],[600,{opacity:1},SMOOTH]]);
};
