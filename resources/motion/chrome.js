// Shared device frame: local UI chrome, all colours from theme tokens.
window.deviceFrame = (scr, device, width, height) => {
  ({width,height}=bitmapSize(scr,width,height));
  const phone=device==="phone", browser=device==="browser", laptop=device==="laptop";
  const bar=browser ? height*.075 : phone ? height*.045 : 0;
  const frame=h(`<div class="device" data-moves style="position:relative;box-sizing:content-box;width:${width}px;height:${height+bar}px;background:var(--card);border:2px solid var(--line);border-radius:${phone ? '36px' : 'var(--radius)'};overflow:hidden;box-shadow:var(--shadow-x) var(--shadow-y) var(--shadow-blur) color-mix(in srgb,var(--shadow-color) calc(var(--shadow)*100%),transparent)"></div>`);
  if(browser) frame.append(h(`<div style="height:${bar}px;display:flex;align-items:center;gap:8px;padding:0 18px;border-bottom:1px solid var(--line);color:var(--ink)"><span style="font-family:var(--symbols)">● ● ●</span><div style="margin:auto;border:1px solid var(--line);border-radius:8px;padding:3px 50px;font:14px var(--body)">Design preview</div></div>`));
  if(phone) frame.append(h(`<div style="height:${bar}px;text-align:center;font:14px var(--mono);color:var(--ink)">9:41 &nbsp; <span style="font-family:var(--rules)">━</span></div>`));
  const viewport=h(`<div class="viewport" style="position:relative;width:100%;height:${height}px;overflow:hidden;background:var(--card)"><img src="${scr.url}" style="width:100%;height:100%;object-fit:${phone ? 'cover' : 'fill'};display:block"></div>`);
  frame.append(viewport);
  if(laptop) { frame.style.borderWidth="12px"; frame.style.borderColor="var(--line)"; }
  return {frame,viewport,img:$("img",viewport)};
};
CHROME.browser=(ctx)=>{const screen=ctx.screen(ctx.scene.screen),width=Math.min(ctx.W*.8,ctx.H*.7*screen.width/screen.height);return deviceFrame(screen,"browser",width,width*screen.height/screen.width).frame;};
CHROME.phone=(ctx)=>deviceFrame(ctx.screen(ctx.scene.screen),"phone",ctx.H*.34,ctx.H*.7).frame;
