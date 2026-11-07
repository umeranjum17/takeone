window.AFTER_MOUNT=window.AFTER_MOUNT??[];
// A glow promo's closing card with a logo follows Open Design's frame-logo-outro timing (Apache-2.0, adapted, see ENGINE.md): the
// logo's pieces arrive staggered from an offset at 1.4x and overshoot home, a glow blooms, the name lands, then an accent sweep crosses it.
const LOGO_PIECE_FROM = [[-1.25, -0.63], [0.94, -0.79], [-0.63, 0.79], [1.1, 0.63], [0, -1.1]]; // in logo heights
const LOGO_PIECE_SPRING = { omega: 11, zeta: 0.55 };
// One image per drawn shape, each the whole SVG with the others hidden, so its defs and styles still apply and its scripts never run.
// A logo that is one shape, or too many to read as pieces, gets null and arrives whole.
window.logoPieces = (svg) => {
  const doc = new DOMParser().parseFromString(svg ?? "", "image/svg+xml");
  if (doc.querySelector("parsererror")) return null;
  const drawn = (el) => [...el.children].filter((e) => !/^(defs|style|title|desc|metadata)$/i.test(e.localName));
  const shapes = (el) => { const kids = drawn(el); return kids.length === 1 && kids[0].localName === "g" ? shapes(kids[0]) : kids; };
  const parts = shapes(doc.documentElement);
  if (parts.length < 2 || parts.length > 8) return null;
  return parts.map((part) => {
    parts.forEach((p) => (p === part ? p.removeAttribute("display") : p.setAttribute("display", "none")));
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(doc))}`;
  });
};
// Returns the glyph sweep to run once the name is laid out.
window.riseFrom = (el, at, by) => {
  const y = track(1, [[at, 0]], TYPE_SPRING);
  tick((ms) => { const v = y(ms); el.style.transform = `translateY(${(v * by).toFixed(3)}px)`; el.style.opacity = (1 - v).toFixed(4); });
};
window.assembleLogo = (mark, s, H, u) => {
  const box = h(`<div style="position:relative"></div>`), accent = STORYBOARD.tokens.accent;
  mark.replaceWith(box); box.append(mark);
  mark.style.visibility = "hidden"; // keeps the whole logo's size, so the pieces land exactly on it
  const size = parseFloat(mark.style.height);
  (logoPieces(STORYBOARD.logo_svgs?.[s.logo_image]) ?? [mark.src]).forEach((src, i) => {
    const piece = mark.cloneNode(); piece.src = src;
    piece.style.cssText += ";visibility:visible;position:absolute;inset:0;width:100%;height:100%";
    box.append(piece);
    const [dx, dy] = LOGO_PIECE_FROM[i % 5], at = i * 110 - TYPE_LEAD;
    const home = track(0, [[at, 1]], LOGO_PIECE_SPRING), shown = track(0, [[at, 1]], { omega: 22, zeta: 1 });
    tick((ms) => {
      const away = 1 - home(ms);
      piece.style.transform = `translate(${(dx * size * away).toFixed(2)}px,${(dy * size * away).toFixed(2)}px) scale(${(1 + 0.4 * away).toFixed(4)})`;
      piece.style.opacity = shown(ms).toFixed(4);
    });
  });
  const dark = `drop-shadow(0 0 0px ${accent}00)`;
  K(box, [[0, { filter: dark }], [700, { filter: dark }, SMOOTH], [1400, { filter: `drop-shadow(0 0 ${u * 0.03}px ${accent}a0)` }]]);
  return (glyphs) => {
    const end = Math.max(...glyphs.map((g) => g.x + g.w)), band = end * 0.28;
    tick((ms) => {
      const x = (smootherstep((ms - 1250) / 1000) * 1.5 - 0.25) * end;
      glyphs.forEach((g) => {
        const near = Math.max(0, 1 - Math.abs(g.x + g.w / 2 - x) / band);
        g.span.style.color = near ? `color-mix(in srgb,${accent} ${(smootherstep(near) * 100).toFixed(1)}%,var(--text))` : "";
      });
    });
  };
};
PATTERNS["end-card"] = (layer,s,ctx) => {
  const {W,H}=ctx, u=Math.min(W,H);
  const assembled=s.glow&&s.logo_image;
  if(s.glow) glowBg(layer,W,H,[.5,1.05],assembled?s.d*1000:0); // a glow-reel's end card sits on its lit stage
  // supporting type follows the short side, so a 9:16 card reads on a phone too
  const group=h(`<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${H*.055}px"></div>`);
  const word=kernedLetters(s.logo);
  word.style.font=`400 ${Math.min(W*.16,H*.2)}px/1.1 var(--display)`;
  word.style.color="var(--text)"; // explicit: inherited body color would not follow a per-scene invert
  // The mark keeps a margin of its own (padding inside the box), so a logo whose paths touch its edges is never cut and never fills the box.
  const mark=s.logo_image?h(`<img src="${STORYBOARD.logos[s.logo_image]}" style="height:${H*(assembled?.18:.14)}px;max-width:${W*.3}px;padding:${H*.012}px;box-sizing:border-box;object-fit:contain;display:block">`):null;
  if(mark) group.append(mark);
  group.append(word);
  const cta=h(`<div style="background:var(--text);color:var(--bg);border-radius:999px;padding:18px 38px;font:${u*.056}px var(--body)">${esc(s.cta??"")}</div>`);
  const url=h(`<div style="color:var(--text);font:${u*.05}px var(--mono)">${esc(s.url??"")}</div>`);
  group.append(cta,url);layer.append(group);
  const base=BASE, sweep=assembled?assembleLogo(mark,s,H,u):null; // glyphs start half a fade early, so the card's first frame (a cut point) already shows the first glyph half in
  AFTER_MOUNT.push(()=>{BASE=base-275+(assembled?420:0); const glyphs=word.layoutGlyphs(); glyphs.forEach((g,i)=>K(g.span,[[i*35,{opacity:0,transform:`translate(${g.x}px,-${H*.08}px)`},SMOOTH],[550+i*35,{opacity:1,transform:`translate(${g.x}px,0px)`}]]));BASE=base;sweep?.(glyphs);BASE=0;});
  if(mark&&!assembled) K(mark,[[0,{opacity:0,transform:"scale(.92)"},SMOOTH],[650,{opacity:1,transform:"none"}]]);
  if(assembled){riseFrom(cta,950,H*.03);riseFrom(url,1120,H*.03);}
  else{K(cta,[[0,{opacity:0},SMOOTH],[650,{opacity:1}]]);K(url,[[0,{opacity:0},SMOOTH],[750,{opacity:1}]]);}
  K(group,[[0,{transform:"scale(1)"}],[s.d*1000,{transform:"scale(1.03)"}]]);
};
