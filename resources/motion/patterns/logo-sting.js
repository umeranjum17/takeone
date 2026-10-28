// The wordmark scales 0.85 to 1 on a slightly bouncy spring (zeta 0.8) while fading in and its tracking closes from 0.2 em to 0.
PATTERNS["logo-sting"] = (layer, s, ctx) => {
  const { W, H } = ctx, n = [...s.logo].length, size = Math.min(W * 0.16, H * 0.2, W * 0.8 / (n * 0.82));
  const mark = h(`<span data-safe style="display:inline-block;white-space:nowrap;font:400 ${size}px/1.1 var(--display);color:var(--text)">${esc(s.logo)}</span>`);
  const box = h(`<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center"></div>`);
  box.append(mark); layer.append(box);
  const grow = track(0.85, [[0, 1]], { omega: 14, zeta: 0.8 });
  tick((ms) => {
    const tr = 0.2 * (1 - smootherstep(ms / 900));
    mark.style.transform = `scale(${grow(ms).toFixed(4)})`;
    mark.style.opacity = Math.max(0, Math.min(1, (ms + 225) / 450)).toFixed(4);
    mark.style.letterSpacing = `${tr.toFixed(4)}em`; mark.style.paddingLeft = `${tr.toFixed(4)}em`; // balances the trailing space so the word stays centred
  });
};
