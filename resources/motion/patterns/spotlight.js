// The screen whole in its frame, dimmed to 40% except a rounded hole that glides from region to region; each stop's label
// sits in a pill under the frame. Stops last their reading floor plus 0.9 s (stopTimes), never under 2.4 s.
PATTERNS.spotlight = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), gap = u * 0.05, st = spotStage(layer, s, ctx, u * 0.12 + gap, false);
  const cap = h(`<div data-safe style="position:absolute;left:50%;top:${st.bottom + gap}px;transform:translateX(-50%);max-width:${W * 0.86}px;text-align:center;padding:${u * 0.016}px ${u * 0.028}px;border-radius:var(--radius);background:var(--card);color:var(--ink);font:${Math.min(W * 0.045, H * 0.04)}px/1.2 var(--body)"></div>`);
  layer.append(cap);
  tick((ms) => {
    const i = st.index(ms), text = i < 0 ? "" : st.stops[i].caption ?? "";
    cap.textContent = text; cap.style.display = text ? "block" : "none";
    cap.style.opacity = i < 0 ? "0" : Math.min(1, (ms - st.starts[i] * 1000) / 250).toFixed(3);
  });
};
