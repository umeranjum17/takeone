// Bento recap beat: a static 2x2 checkerboard of real cropped screen states, each with its
// label pill, fading up in turn. Tiles name crop screens cut at ingest (aspect-matched to the
// tile, so cover never slices); a tile without a screen falls back to bare serif type. Reading
// copy is the tile titles, covered by the glyph gate in the display role. No camera.
PATTERNS["bento"] = (layer,s,ctx) => {
  const {W,H}=ctx,t=ctx.tokens;
  const sx=W/1920,sy=H/1080,mx=t.margin_x*sx,my=t.margin_y*sy,gx=t.gutter_x*sx,gy=t.gutter_y*sy;
  const w=(W-2*mx-gx)/2,hh=(H-2*my-gy)/2;
  const grid=h(`<div style="position:absolute;left:${mx}px;top:${my}px;display:grid;grid-template-columns:${w}px ${w}px;grid-template-rows:${hh}px ${hh}px;column-gap:${gx}px;row-gap:${gy}px"></div>`);
  layer.append(grid); // connected before animating: WAAPI on detached nodes never joins the timeline
  (s.tiles??[]).slice(0,4).forEach((tile,i)=>{
    const cell=h(`<div style="position:relative;overflow:hidden;border-radius:var(--radius);background:var(--bg)"></div>`);
    if (tile.screen) {
      const scr=ctx.screen(tile.screen);
      cell.append(h(`<img src="${scr.url}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block">`));
      cell.append(h(`<div style="position:absolute;bottom:7%;left:50%;transform:translateX(-50%);padding:12px 24px;border-radius:var(--radius);background:var(--card);color:var(--ink);font:${Math.min(w*.036,40)}px var(--body);white-space:nowrap">${esc(tile.title)}</div>`));
    } else {
      cell.append(h(`<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 8%;color:var(--text);font:400 ${Math.min(w*.1,hh*.2)}px/1.05 var(--display)">${esc(tile.title)}</div>`));
    }
    grid.append(cell);
    K(cell,[[i*180,{opacity:0,transform:"translateY(24px)"},SMOOTH],[420+i*180,{opacity:1,transform:"none"}]]);
  });
};
