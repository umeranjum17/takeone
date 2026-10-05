// Type-only beat: words rise out of a mask one by one; the last word lands muted, then settles to full ink.
PATTERNS["kinetic-type"] = (layer,s,ctx) => {
  const {W,H}=ctx,words=(s.title??"").split(/\s+/).filter(Boolean);
  const wrap=h(`<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${H*.04}px"></div>`);
  const kicker=h(`<div style="font:${Math.min(W*.014,H*.024)}px var(--mono);letter-spacing:.18em;color:var(--muted)">${esc(s.subtitle??"")}</div>`);
  const line=h(`<div style="max-width:84%;text-align:center;font:400 ${Math.min(W*.075,H*.13)}px/1.12 var(--display);color:var(--text)">${words.map(word=>`<span style="display:inline-block;overflow:hidden;vertical-align:bottom;padding:0 .03em .08em"><span class="kt-word" style="display:inline-block">${esc(word)}</span></span>`).join(" ")}</div>`);
  if(s.subtitle) wrap.append(kicker);
  wrap.append(line);layer.append(wrap);
  const spans=$$(".kt-word",line),last=spans.length-1;
  spans.forEach((word,i)=>K(word,[[i*140,{transform:"translateY(110%)"},SMOOTH],[520+i*140,{transform:"none"}]]));
  if(last>0) K(spans[last],[[0,{color:"var(--muted)"}],[520+last*140,{color:"var(--muted)"},SMOOTH],[920+last*140,{color:"var(--text)"}]]);
  K(kicker,[[0,{opacity:0},SMOOTH],[500,{opacity:1}]]);
  K(line,[[0,{transform:"scale(1)"}],[s.d*1000,{transform:"scale(1.04)"}]]);
};
