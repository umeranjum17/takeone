window.AFTER_MOUNT=window.AFTER_MOUNT??[];
PATTERNS["end-card"] = (layer,s,ctx) => {
  const {W,H}=ctx;
  const group=h(`<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${H*.055}px"></div>`);
  const word=kernedLetters(s.logo);
  word.style.font=`400 ${Math.min(W*.12,H*.2)}px/1.1 var(--display)`;
  word.style.color="var(--text)"; // explicit: inherited body color would not follow a per-scene invert
  group.append(word);
  const cta=h(`<div style="background:var(--text);color:var(--bg);border-radius:999px;padding:18px 38px;font:${Math.min(W*.028,H*.046)}px var(--body)">${esc(s.cta??"")}</div>`);
  const url=h(`<div style="color:var(--text);font:${Math.min(W*.019,H*.032)}px var(--mono)">${esc(s.url??"")}</div>`);
  group.append(cta,url);layer.append(group);
  const base=BASE;
  AFTER_MOUNT.push(()=>{BASE=base; const glyphs=word.layoutGlyphs(); glyphs.forEach((g,i)=>K(g.span,[[i*35,{opacity:0,transform:`translate(${g.x}px,-${H*.08}px)`},SMOOTH],[550+i*35,{opacity:1,transform:`translate(${g.x}px,0px)`}]]));BASE=0;});
  K(cta,[[0,{opacity:0},SMOOTH],[650,{opacity:1}]]);
  K(url,[[0,{opacity:0},SMOOTH],[750,{opacity:1}]]);
  K(group,[[0,{transform:"scale(1)"}],[s.d*1000,{transform:"scale(1.03)"}]]);
};
