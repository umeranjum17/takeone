// Shared by the screen-in-a-frame patterns (spotlight, feature-callouts, before-after, device-orbit): the whole screen fitted to 88%
// of the width and 62% of the height in its device frame, centred over `reserve` px kept free below it for a caption or card.
window.stageFrame = (layer, s, ctx, reserve = 0) => {
  const { W, H } = ctx, scr = ctx.screen(s.screen), requested = Math.min(W * 0.88, Math.min(H * 0.62, H * 0.66 - reserve) * scr.width / scr.height);
  const { width: cw, height: ch } = bitmapSize(scr, requested, requested * scr.height / scr.width);
  const { frame, viewport, img } = deviceFrame(scr, s.device ?? "browser", cw, ch);
  layer.append(frame);
  const fh = frame.offsetHeight, top = Math.max(H * 0.08, (H - fh - reserve) / 2);
  frame.style.cssText += `;position:absolute;left:${(W - frame.offsetWidth) / 2}px;top:${top}px`;
  return { scr, frame, viewport, img, top, bottom: top + fh };
};
// Dim-and-glide stage shared by spotlight and feature-callouts: a dim over everything but a rounded hole that glides
// (critically damped) to each stop's region and, at the end, opens back out (or, with `close`, shuts for a summary).
window.spotStage = (layer, s, ctx, reserve, close) => {
  const st = stageFrame(layer, s, ctx, reserve), { viewport, scr } = st, stops = s.stops;
  const vw = viewport.offsetWidth, vh = viewport.offsetHeight, k = vw / scr.width, pad = Math.min(vw, vh) * 0.012;
  const { starts, end } = stopTimes(stops.map((x) => x.caption ?? ""));
  const boxes = stops.map((x) => { const [bx, by, bw, bh] = ctx.region(x.region).rect.map((v) => v * k); return [bx - pad, by - pad, bw + 2 * pad, bh + 2 * pad]; });
  const last = boxes.at(-1), rest = close ? [last[0] + last[2] / 2, last[1] + last[3] / 2, 0, 0] : [0, 0, vw, vh];
  const targets = [...boxes.map((b, i) => [starts[i] * 1000 - 600, b]), [end * 1000, rest]];
  const tracks = [0, 1, 2, 3].map((c) => track([0, 0, vw, vh][c], targets.map(([t, b]) => [t, b[c]]), { omega: 9, zeta: 1 }));
  const hole = h(`<div style="position:absolute;border-radius:12px;box-shadow:0 0 0 3px var(--accent),0 0 0 9999px rgba(0,0,0,.6)"></div>`);
  viewport.append(hole);
  const at = (ms) => tracks.map((f) => f(ms));
  tick((ms) => { const [x, y, w, hh] = at(ms); Object.assign(hole.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px` }); });
  // The stop on show at ms, or -1 before the first and after the last has ended.
  const index = (ms) => (ms >= end * 1000 ? -1 : starts.findLastIndex((t) => ms >= t * 1000));
  return { ...st, stops, starts, end, at, index };
};
