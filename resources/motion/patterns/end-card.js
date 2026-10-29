window.AFTER_MOUNT=window.AFTER_MOUNT??[];
PATTERNS["end-card"] = (layer,s,ctx) => {
  const {W,H}=ctx, u=Math.min(W,H);
  if(s.glow) glowBg(layer,W,H,[.5,1.05]); // a glow-reel's end card sits on its lit stage
  // supporting type follows the short side, so a 9:16 card reads on a phone too
  const group=h(`<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${H*.055}px"></div>`);
  const word=kernedLetters(s.logo);
  word.style.font=`400 ${Math.min(W*.16,H*.2)}px/1.1 var(--display)`;
  word.style.color="var(--text)"; // explicit: inherited body color would not follow a per-scene invert
  const mark=s.logo_image?h(`<img src="${STORYBOARD.logos[s.logo_image]}" style="height:${H*.14}px;max-width:${W*.3}px;object-fit:contain;display:block">`):null;
  if(mark) group.append(mark);
  group.append(word);
  const cta=h(`<div style="background:var(--text);color:var(--bg);border-radius:999px;padding:18px 38px;font:${u*.056}px var(--body)">${esc(s.cta??"")}</div>`);
  const url=h(`<div style="color:var(--text);font:${u*.05}px var(--mono)">${esc(s.url??"")}</div>`);
  group.append(cta,url);layer.append(group);
  const base=BASE; // glyphs start half a fade early, so the card's first frame (a cut point) already shows the first glyph half in
  AFTER_MOUNT.push(()=>{BASE=base-275; const glyphs=word.layoutGlyphs(); glyphs.forEach((g,i)=>K(g.span,[[i*35,{opacity:0,transform:`translate(${g.x}px,-${H*.08}px)`},SMOOTH],[550+i*35,{opacity:1,transform:`translate(${g.x}px,0px)`}]]));BASE=0;});
  if(mark) K(mark,[[0,{opacity:0,transform:"scale(.92)"},SMOOTH],[650,{opacity:1,transform:"none"}]]);
  K(cta,[[0,{opacity:0},SMOOTH],[650,{opacity:1}]]);
  K(url,[[0,{opacity:0},SMOOTH],[750,{opacity:1}]]);
  K(group,[[0,{transform:"scale(1)"}],[s.d*1000,{transform:"scale(1.03)"}]]);
};
