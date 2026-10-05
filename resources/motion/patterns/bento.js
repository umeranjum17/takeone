// Bento recap beat: a static 2x2 checkerboard of four big serif titles (cream/black by tile,
// not by scene invert), each fading up in turn. Reading copy is the tiles themselves; no camera,
// no device chrome. Tile titles come from the scene and pass the glyph gate in the display role.
PATTERNS["bento"] = (layer,s,ctx) => {
  const {W,H}=ctx,t=ctx.tokens;
  const sx=W/1920,sy=H/1080,mx=t.margin_x*sx,my=t.margin_y*sy,gx=t.gutter_x*sx,gy=t.gutter_y*sy;
  const w=(W-2*mx-gx)/2,hh=(H-2*my-gy)/2;
  const grid=h(`<div style="position:absolute;left:${mx}px;top:${my}px;display:grid;grid-template-columns:${w}px ${w}px;grid-template-rows:${hh}px ${hh}px;column-gap:${gx}px;row-gap:${gy}px"></div>`);
  layer.append(grid); // connected before animating: WAAPI on detached nodes never joins the timeline
  (s.tiles??[]).slice(0,4).forEach((tile,i)=>{
    const dark=i===1||i===2;
    const cell=h(`<div style="display:flex;align-items:center;justify-content:center;text-align:center;padding:0 8%;border-radius:var(--radius);background:${dark?"var(--ink)":"var(--bg)"};color:${dark?"var(--bg)":"var(--text)"};font:400 ${Math.min(w*.1,hh*.2)}px/1.05 var(--display)">${esc(tile.title)}</div>`);
    grid.append(cell);
    K(cell,[[i*180,{opacity:0,transform:"translateY(24px)"},SMOOTH],[420+i*180,{opacity:1,transform:"none"}]]);
  });
};
