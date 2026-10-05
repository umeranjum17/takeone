// Full-type beat: one big serif line (plus an optional smaller second line) on the bare
// theme background, no device frame — unless the scene names a device and a screen, in which
// case the type steps aside and the screen rides in that frame as illustration (the big type
// stays the reading copy). Per-scene `invert` (applied in film.js) alternates black and cream
// beats; the glyph gate covers title/subtitle in their font roles.
PATTERNS["kinetic-type"] = (layer,s,ctx) => {
  const {W,H}=ctx;
  const words=(text)=>text.split(/\s+/).filter(Boolean).map(word=>`<span style="display:inline-block;overflow:hidden;vertical-align:bottom"><span class="type-word" style="display:inline-block">${esc(word)}</span></span>`).join(" ");
  const title=(size)=>h(`<div style="font:400 ${size}px/1.05 var(--display);color:var(--text)">${words(s.title??"")}</div>`);
  const sub=(size)=>s.subtitle?h(`<div style="font:${size}px/1.3 var(--body);color:var(--text)">${esc(s.subtitle)}</div>`):null;
  const stagger=(root)=>$$(".type-word",root).forEach((word,i)=>K(word,[[i*70,{transform:"translateY(108%)"},SMOOTH],[420+i*70,{transform:"none"}]]));
  if(s.device && s.device!=="none" && s.screen) {
    const scr=ctx.screen(s.screen);
    const {frame}=deviceFrame(scr,s.device,H*.34,H*.7);
    frame.style.cssText+=`;flex:none`;
    const copy=h(`<div style="flex:1;text-align:left;padding-left:8%"></div>`);
    const t=title(Math.min(W*.05,H*.085)),u=sub(Math.min(W*.024,H*.04));
    copy.append(t);if(u)copy.append(u);
    const row=h(`<div style="position:absolute;inset:0;display:flex;flex-direction:row;align-items:center;justify-content:center;gap:5%;padding:0 7%"></div>`);
    row.append(copy,frame);layer.append(row);
    stagger(copy);
    K(frame,[[0,{transform:"scale(.97)"}],[s.d*1000,{transform:"scale(1.02)"}]]);
    return;
  }
  const group=h(`<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${H*.045}px;text-align:center;padding:0 8%"></div>`);
  group.append(title(Math.min(W*.085,H*.14)));
  const u=sub(Math.min(W*.026,H*.044));if(u)group.append(u);
  layer.append(group);
  stagger(group);
  K(group,[[0,{transform:"scale(1)"}],[s.d*1000,{transform:"scale(1.04)"}]]);
};
