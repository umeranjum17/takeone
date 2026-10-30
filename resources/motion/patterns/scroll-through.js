// The screen in its device frame, seen through a window of the frame's own shape that scrolls along the screen's long axis
// (down a tall page, across a wide board) at full size: hold 0.8 s, ease in-out to the far edge, hold to the scene end.
// An optional title sits in a pill under the frame.
PATTERNS["scroll-through"] = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), gap = u * 0.05, scr = ctx.screen(s.screen), reserve = s.title ? u * 0.1 + gap : 0;
  let requestedW = W * 0.88;
  const requestedH = Math.min(H * 0.7, H * 0.8 - reserve);
  if (scr.width > scr.height && requestedW / requestedH >= scr.width / scr.height) requestedW = requestedH * scr.width / scr.height * 0.9;
  const st = deviceFrame(scr, s.device ?? "browser", requestedW, requestedH), { frame, viewport, img } = st;
  layer.append(frame);
  const vw = viewport.offsetWidth, vh = viewport.offsetHeight, fh = frame.offsetHeight;
  const top = Math.max(H * 0.08, (H - fh - reserve) / 2);
  frame.style.cssText += `;position:absolute;left:${(W - frame.offsetWidth) / 2}px;top:${top}px`;
  // Scale so the window shows the whole short side; the slack on the long side is what scrolls.
  const k = Math.max(vw / scr.width, vh / scr.height), slackX = scr.width * k - vw, slackY = scr.height * k - vh;
  img.style.cssText = `position:absolute;left:0;top:0;width:${scr.width * k}px;height:${scr.height * k}px;max-width:none;object-fit:fill;display:block`;
  if (s.title) {
    const cap = h(`<div data-safe style="position:absolute;left:50%;top:${top + fh + gap}px;transform:translateX(-50%);max-width:${W * 0.86}px;text-align:center;padding:${u * 0.016}px ${u * 0.028}px;border-radius:var(--radius);background:var(--card);color:var(--ink);font:${Math.min(W * 0.045, H * 0.04)}px/1.2 var(--body)">${esc(s.title)}</div>`);
    layer.append(cap);
    K(cap, [[0, { opacity: 0 }], [600, { opacity: 1 }, SMOOTH]]);
  }
  tick((ms) => {
    const p = smootherstep((ms - 800) / Math.max(1, s.d * 1000 - 1600));
    img.style.transform = `translate(${(-slackX * p).toFixed(3)}px,${(-slackY * p).toFixed(3)}px)`;
    const o = drift(ms, W);
    frame.style.transform = `translate(${o.x}px,${o.y}px)`;
  });
};
