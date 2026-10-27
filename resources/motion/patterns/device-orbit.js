// The screen in its device frame starts tilted 16 degrees, turns flat while rising over 1.4 s, then floats +-4 px. True CSS 3D. It opens on picture (a cut point), so no fade.
PATTERNS["device-orbit"] = (layer, s, ctx) => {
  const { W, H } = ctx, st = stageFrame(layer, s, ctx, 0), f = st.frame;
  layer.style.perspective = `${Math.max(W, H) * 1.4}px`;
  tick((ms) => {
    const t = Math.max(0, ms / 1000), e = smootherstep(t / 1.4), float = e * 4 * Math.sin(2 * Math.PI * t / 3.2);
    f.style.transform = `translateY(${(40 * (1 - e) + float).toFixed(3)}px) rotateX(${(6 * (1 - e)).toFixed(3)}deg) rotateY(${(16 * (1 - e)).toFixed(3)}deg) scale(${(0.94 + 0.06 * e).toFixed(4)})`;
  });
};
