// Spotlight stops with a numbered callout card under the frame, an accent connector from the lit region to the card, and a
// closing numbered summary of every label over the dimmed screen.
PATTERNS["feature-callouts"] = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), gap = u * 0.06, fs = Math.min(W * 0.045, H * 0.04);
  const st = spotStage(layer, s, ctx, u * 0.14 + gap, true), cardTop = st.bottom + gap;
  const badge = (n) => `<b style="flex:none;width:1.8em;height:1.8em;border-radius:50%;background:var(--accent);color:var(--bg);display:grid;place-items:center;font:inherit">${n}</b>`;
  const box = `border-radius:var(--radius);background:var(--card);color:var(--ink);font:${fs}px/1.3 var(--body)`;
  const card = h(`<div data-safe style="position:absolute;left:50%;top:${cardTop}px;transform:translateX(-50%);display:flex;align-items:center;gap:${fs * 0.6}px;max-width:${W * 0.86}px;padding:${u * 0.016}px ${u * 0.028}px;${box}"></div>`);
  const line = h(`<svg style="position:absolute;inset:0;width:100%;height:100%"><line style="stroke:var(--accent);stroke-width:${u * 0.004}px;stroke-linecap:round"/></svg>`);
  const rows = st.stops.map((x, i) => `<div style="display:flex;align-items:center;gap:${fs * 0.6}px">${badge(i + 1)}<span>${esc(x.caption)}</span></div>`).join("");
  const sum = h(`<div data-safe style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:${W * 0.86}px;display:flex;flex-direction:column;gap:${fs * 0.5}px;padding:${u * 0.04}px ${u * 0.06}px;${box}">${rows}</div>`);
  layer.append(line, card, sum);
  const ox = st.frame.offsetLeft + st.frame.clientLeft + st.viewport.offsetLeft, oy = st.frame.offsetTop + st.frame.clientTop + st.viewport.offsetTop, seg = $("line", line);
  tick((ms) => {
    const i = st.index(ms), on = i >= 0, [x, y, w, hh] = st.at(ms), fade = on ? Math.min(1, (ms - st.starts[i] * 1000) / 250) : 0;
    if (on && card.dataset.stop !== String(i)) { card.dataset.stop = String(i); card.innerHTML = `${badge(i + 1)}<span>${esc(st.stops[i].caption)}</span>`; }
    card.style.display = on ? "flex" : "none"; card.style.opacity = fade.toFixed(3);
    line.style.display = on ? "block" : "none"; line.style.opacity = fade.toFixed(3);
    seg.setAttribute("x1", ox + x + w / 2); seg.setAttribute("y1", oy + y + hh); seg.setAttribute("x2", W / 2); seg.setAttribute("y2", cardTop);
    const shown = ms > st.end * 1000 + 100;
    sum.style.display = shown ? "flex" : "none"; sum.style.opacity = Math.min(1, (ms - st.end * 1000 - 100) / 400).toFixed(3);
  });
};
