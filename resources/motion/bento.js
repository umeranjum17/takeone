window.mountBento = async (stage, sb) => {
  stage.style.background = "var(--page)";
  const {out_w:W,out_h:H}=sb.output, t=STORYBOARD.tokens;
  const sx=W/1920, sy=H/1080, mx=t.margin_x*sx,my=t.margin_y*sy,gx=t.gutter_x*sx,gy=t.gutter_y*sy;
  const iw=W-2*mx,ih=H-2*my;
  const tile=(id,x,y,w,h,scenes,shift,key) => {
    const clip=window.h(`<div class="tile" data-tile="${id}" style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;overflow:hidden;border-radius:var(--radius);will-change:transform;background:var(--bg)"></div>`);
    stage.append(clip);
    // Every tile is a clipped viewport. Canon tiles share exactly the same virtual viewport.
    const root=window.h(`<div style="position:absolute;width:${w}px;height:${h}px;overflow:hidden;background:var(--bg)"></div>`);
    clip.append(root); mountScenes(root,scenes,[],w,h,shift,key);
  };
  if(sb.layout.grid==="2x2") {
    const w=(iw-gx)/2,h=(ih-gy)/2;
    const positions={TL:[mx,my],TR:[mx+w+gx,my],BL:[mx,my+h+gy],BR:[mx+w+gx,my+h+gy]};
    for(const q of sb.layout.tiles) tile(q.id,...positions[q.id],w,h,sb.layout.master.scenes,-q.offset_s*1000,"master:");
  } else {
    const unit=(iw-2*gx)/3,h=(ih-gy)/2;
    const boxes={A:[mx,my,2*unit+gx,h],B:[mx+2*(unit+gx),my,unit,h],C:[mx,my+h+gy,unit,h],D:[mx+unit+gx,my+h+gy,2*unit+gx,h]};
    for(const id of ["A","B","C","D"]) tile(id,...boxes[id],sb.layout.tiles[id],0,id+":");
  }
};
