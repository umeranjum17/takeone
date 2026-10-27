// Type beat on the bare page: one display line (a hook, a proof number, a wordmark), an optional second line and
// an optional mono footnote, centred and sized from the frame's short side so every format keeps the hierarchy.
// Whole words rise and fade in on the type spring (riseIn); the second line follows, the footnote fades up last.
PATTERNS.statement = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), title = (s.title ?? "").split(/\s+/).filter(Boolean);
  const size = Math.min(u * (title.length > 2 ? 0.1 : 0.2), (W - u * 0.24) / (0.62 * Math.max(...title.map((w) => w.length)))); // the longest word fits the frame
  const group = h(`<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${u * 0.045}px;padding:0 ${Math.max(u * 0.08, W * 0.06)}px;text-align:center;color:var(--text)"></div>`);
  const line = h(`<div data-safe style="font:${size}px/1.08 var(--display);letter-spacing:-.02em;text-wrap:balance">${wordSpans(s.title, "statement-word")}</div>`);
  group.append(line);
  $$(".statement-word", line).forEach((w, i) => riseIn(w, i * 60));
  if (s.subtitle) {
    const sub = h(`<div data-safe style="font:${u * 0.045}px/1.25 var(--display)">${esc(s.subtitle)}</div>`);
    group.append(sub); riseIn(sub, 200);
  }
  if (s.note) {
    const note = h(`<div data-safe style="font:${u * 0.034}px/1.4 var(--mono);letter-spacing:.08em;text-transform:uppercase;text-wrap:balance;color:var(--muted)">${esc(s.note)}</div>`);
    group.append(note);
    const o = track(0, [[500, 1]], TYPE_SPRING);
    tick((ms) => (note.style.opacity = o(ms).toFixed(4)));
  }
  layer.append(group);
};
