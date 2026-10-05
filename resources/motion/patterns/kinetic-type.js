// Full-type beat: one big serif line (plus an optional smaller second line) on the bare
// theme background, no device frame. Per-scene `invert` (applied in film.js) alternates
// black and cream beats; the glyph gate covers title/subtitle in their font roles.
PATTERNS["kinetic-type"] = (layer,s,ctx) => {
  const {W,H}=ctx;
  const group=h(`<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${H*.045}px;text-align:center;padding:0 8%"></div>`);
  const title=h(`<div style="font:400 ${Math.min(W*.085,H*.14)}px/1.05 var(--display);color:var(--text)">${(s.title??"").split(/\s+/).filter(Boolean).map(word=>`<span style="display:inline-block;overflow:hidden;vertical-align:bottom"><span class="type-word" style="display:inline-block">${esc(word)}</span></span>`).join(" ")}</div>`);
  group.append(title);
  if(s.subtitle) group.append(h(`<div style="font:${Math.min(W*.026,H*.044)}px/1.3 var(--body);color:var(--text)">${esc(s.subtitle)}</div>`));
  layer.append(group);
  $$(".type-word",title).forEach((word,i)=>K(word,[[i*70,{transform:"translateY(108%)"},SMOOTH],[420+i*70,{transform:"none"}]]));
  K(group,[[0,{transform:"scale(1)"}],[s.d*1000,{transform:"scale(1.04)"}]]);
};
