// Two screens in one frame: the after fills it, the before wipes in behind a line sweeping left to right (0.9 s, ease in-out)
// and the line settles back to a 50% split, chips under the frame's corners naming each half. An optional delta line (title) fades up under it.
PATTERNS["before-after"] = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), gap = u * 0.05, after = ctx.screen(s.after);
  const st = stageFrame(layer, { ...s, screen: s.after }, ctx, s.title ? u * 0.1 + gap : 0), vp = st.viewport;
  const before = h(`<div style="position:absolute;inset:0;overflow:hidden"><img src="${ctx.screen(s.screen).url}" style="width:100%;height:100%;object-fit:cover;display:block"></div>`);
  const line = h(`<div style="position:absolute;top:0;bottom:0;width:${u * 0.004}px;margin-left:-${u * 0.002}px;background:var(--accent)"></div>`);
  const fl = st.frame.offsetLeft, fr = fl + st.frame.offsetWidth;
  const chip = (text, x, tx) => h(`<div data-safe style="position:absolute;top:${st.bottom + u * 0.01}px;left:${x}px;transform:translateX(${tx});padding:${u * 0.01}px ${u * 0.02}px;border-radius:999px;background:var(--card);color:var(--ink);font:${u * 0.026}px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase">${esc(text)}</div>`);
  const left = chip(s.label ?? "Before", fl, "0"), right = chip(s.note ?? "After", fr, "-100%");
  vp.append(before, line);
  layer.append(left, right);
  const ease = "cubic-bezier(.65,0,.35,1)", clip = (p) => `inset(0 ${100 - p}% 0 0)`;
  K(before, [[0, { clipPath: clip(0) }], [400, { clipPath: clip(0) }, ease], [1300, { clipPath: clip(100) }, ease], [1500, { clipPath: clip(100) }, ease], [2200, { clipPath: clip(50) }]]);
  K(line, [[0, { left: "0%" }], [400, { left: "0%" }, ease], [1300, { left: "100%" }, ease], [1500, { left: "100%" }, ease], [2200, { left: "50%" }]]);
  for (const c of [left, right]) K(c, [[0, { opacity: 0 }], [1500, { opacity: 0 }, SMOOTH], [2200, { opacity: 1 }]]);
  if (s.title) {
    const delta = h(`<div data-safe style="position:absolute;left:50%;top:${st.bottom + u * 0.066 + gap}px;transform:translateX(-50%);max-width:${W * 0.86}px;text-align:center;padding:${u * 0.016}px ${u * 0.028}px;border-radius:var(--radius);background:var(--card);color:var(--ink);font:${Math.min(W * 0.045, H * 0.04)}px/1.2 var(--body)">${esc(s.title)}</div>`);
    layer.append(delta);
    K(delta, [[0, { opacity: 0 }], [2200, { opacity: 0 }, SMOOTH], [2600, { opacity: 1 }]]);
  }
};
