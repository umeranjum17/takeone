// Real-footage beat: frames of a real take (its raw capture, or TakeOne's own render of it) in a window fitted
// below a label band, with a typed mono label riding on the window's top-left corner, on the bare page. `cuts` retarget the window mid-beat (one UI spring per size axis) or
// swap the footage (a hard cut to a new shot) and the label. The page shows each clip's file nearest the output aspect.
const fitIn = (ar, w, h) => (w / h > ar ? [h * ar, h] : [w, w / ar]);
PATTERNS.clip = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), R = u * 0.018, clip = (id) => ctx.clip(id), m = u * 0.06, top = u * 0.12, cy = (top + H - m) / 2;
  const stages = [{ at: 0, clip: s.clip, scale: s.scale ?? 1, start: 0 }];
  for (const c of s.cuts ?? []) {
    const prev = stages.at(-1);
    stages.push({ at: c.at, clip: c.clip ?? prev.clip, scale: c.scale ?? prev.scale, start: c.clip ? c.at : prev.start });
  }
  const sizeOf = (st) => { // scale above 1 grows into the side margins only, up to full width
    const ar = clip(st.clip).width / clip(st.clip).height, max = fitIn(ar, W, H - top - m);
    return fitIn(ar, W - 2 * m, H - top - m).map((v, k) => Math.min(v * st.scale, max[k]));
  };
  // A footage swap is a hard cut to a new shot that springs in from 94%; within a shot, each cut adds a spring.
  const shots = stages.filter((st) => st.start === st.at).map((shot, n) => {
    const from = n ? 0.94 : (s.from ?? shot.scale * 0.94) / shot.scale, own = stages.filter((st) => st.start === shot.start);
    return { at: shot.at, size: [0, 1].map((k) => track(sizeOf(shot)[k] * from, own.map((st) => [st.at * 1000, sizeOf(st)[k]]))) };
  });
  const win = h(`<div data-moves style="position:absolute;overflow:hidden;background:var(--page);box-shadow:0 0 0 1px #4a4a4a"><img style="width:100%;height:100%;object-fit:contain;display:block"></div>`);
  const img = $("img", win);
  layer.append(win);
  const frame = (ms) => { // footage plays on from where its clip started, across label-only cuts
    const st = stages.filter((x) => x.at * 1000 <= Math.max(0, ms)).at(-1), c = clip(st.clip);
    const i = Math.max(0, Math.min(c.count - 1, Math.floor(((ms - st.start * 1000) * c.fps) / 1000 + 1e-6)));
    return `${c.url}${String(i + 1).padStart(4, "0")}.jpg`;
  };
  let shown = (img.src = frame(0)), corner = [0, 0];
  tick((ms) => {
    const { size } = shots.filter((x) => x.at * 1000 <= Math.max(0, ms)).at(-1), w = size[0](ms), hh = size[1](ms);
    corner = [(W - w) / 2, cy - hh / 2];
    Object.assign(win.style, { left: `${corner[0]}px`, top: `${corner[1]}px`, width: `${w}px`, height: `${hh}px`, borderRadius: `${R}px` });
    const src = frame(ms);
    if (src !== shown) { img.src = shown = src; PENDING.push(img.decode()); }
  });
  const labels = [{ at: 0, label: s.label }, ...(s.cuts ?? []).filter((c) => c.label).map((c) => ({ at: c.at, label: c.label }))].filter((l) => l.label);
  if (!labels.length) return;
  const pill = h(`<div style="position:absolute;transform:translateY(-100%);padding-bottom:${u * 0.018}px;color:var(--text);font:${u * 0.028}px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;white-space:pre;display:flex;align-items:center;gap:${u * 0.008}px"><span></span><i style="display:inline-block;width:.6em;height:1.05em;background:var(--text)"></i></div>`);
  layer.append(pill);
  const [text, caret] = [$("span", pill), $("i", pill)];
  tick((ms) => {
    const l = labels.filter((x) => x.at * 1000 <= Math.max(0, ms)).at(-1), local = ms - l.at * 1000;
    const typed = Math.min(l.label.length, Math.floor(Math.max(0, local) / 30) + 1); // types from the cut frame; the caret never shows alone
    text.textContent = l.label.slice(0, typed);
    Object.assign(pill.style, { left: `${Math.max(corner[0], m)}px`, top: `${corner[1]}px` }); // a full-width window keeps its label in the margin
    caret.style.opacity = local < 30 * l.label.length + 600 ? "1" : "0"; // never visibility: it would outlive the hidden layer
  });
};
