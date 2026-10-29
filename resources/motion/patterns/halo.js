// Glow-reel beats (the `--recipe halo` grammar): a near-black stage with a soft glow of the brand's accent,
// the logo opening in its own halo and growing into a pill with a tagline, the product's real UI pieces floating
// in with depth, kinetic lines, and a wordmark that types on. Expo-out entrances, whole words, no CSS gradients:
// the glow is drawn in a canvas with a per-channel dither held over 2x2 pixels, so no frame bands.
(() => {
const EXPO = "cubic-bezier(.16,1,.3,1)", INOUT = "cubic-bezier(.65,0,.35,1)";
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const accentRgb = () => rgb(STORYBOARD.palette?.accent ?? "#3b82f6");
// Triangular dither of +-2 levels per channel from independent integer hashes, one value per 2x2 block.
const hash = (x, y, c) => { let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(c + 1, 2147483647); n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
// A canvas of an elliptical glow: `base` rgb under it (alpha 255), or transparent (halo) when base is null.
const glowCanvas = (w, hgt, { cx, cy, rx, ry, peak, base, color }) => {
  const c = document.createElement("canvas"); c.width = w; c.height = hgt;
  const g = c.getContext("2d"), img = g.createImageData(w, hgt), d = img.data;
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
    const f = Math.exp(-3 * (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2)) * peak, p = (y * w + x) * 4, bx = x >> 1, by = y >> 1;
    for (let i = 0; i < 3; i++) {
      const dz = 2 * (hash(bx, by, 2 * i) + hash(bx, by, 2 * i + 1) - 1);
      d[p + i] = Math.min(255, Math.max(0, Math.round(base ? base[i] + (color[i] - base[i]) * f + dz : color[i] + (dz > 1.4 ? 1 : 0))));
    }
    const dz = 2 * (hash(bx, by, 7) + hash(bx, by, 8) - 1);
    d[p + 3] = base ? 255 : Math.min(255, Math.max(0, Math.round(255 * f + dz)));
  }
  g.putImageData(img, 0, 0);
  return c;
};
const stages = {};
let beat = 0;
const BEATS = [[0.5, 0], [0.3, 0.35], [0.7, 0.6], [0.45, 0.2], [0.62, 0.5], [0.5, 0.15], [0.5, 0]]; // glow x, and how far its hue leans to violet
// The film's stage: ink with the accent glowing up from below, the same on every beat so cuts do not jump.
const glowStage = (layer, W, H, d) => {
  const [r, g, b] = accentRgb(), ink = [7 + r * 0.02, 8 + g * 0.02, 10 + b * 0.025].map(Math.round);
  const [gx, lean] = BEATS[beat++ % BEATS.length], tint = [r + (150 - r) * lean * 0.6, g + (70 - g) * lean * 0.6, b + (230 - b) * lean * 0.3].map(Math.round);
  const key = `${W}x${H}:${gx}:${lean}`;
  stages[key] ??= glowCanvas(W, H, { cx: W * gx, cy: H * 1.08, rx: W * 0.68, ry: H * 0.8, peak: 0.3, base: ink, color: tint });
  const stageCanvas = stages[key];
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  c.getContext("2d").drawImage(stageCanvas, 0, 0);
  c.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%";
  layer.append(c);
  // The glow slowly rises and widens, so a held beat is never a still picture.
  c.style.transformOrigin = "50% 100%";
  K(c, [[0, { transform: "scale(1)" }], [d * 1000, { transform: "scale(1.12)" }]]);
};
const halo = (layer, W, H, cx, cy, size) => {
  const hw = Math.round(size * 2), c = glowCanvas(hw, hw, { cx: hw / 2, cy: hw / 2, rx: hw * 0.42, ry: hw * 0.42, peak: 0.55, color: accentRgb() });
  c.style.cssText = `position:absolute;left:${cx - hw / 2}px;top:${cy - hw / 2}px;width:${hw}px;height:${hw}px`;
  layer.append(c);
  return c;
};
// A real UI piece as a designed object, not a raw crop: its own rounded plate (a circle for a square avatar), a
// hairline rim with a lit top edge, and shadows that deepen with `z` (0 far, 1 near): a tight contact shadow, a long
// ambient one, and a separate blurred cast shadow thrown below and behind it so it floats off whatever lies under it.
const piece = (src, w, hh, radius, z, u) => {
  const lift = u * (0.012 + 0.045 * z);
  return h(`<div style="position:absolute;width:${w}px;height:${hh}px"><div style="position:absolute;left:${w * 0.07}px;right:${w * 0.07}px;top:${hh * 0.14 + lift}px;bottom:${-lift}px;border-radius:${radius}px;background:#000;opacity:${0.55 + 0.3 * z};filter:blur(${u * (0.012 + 0.03 * z)}px)"></div><div style="position:absolute;inset:0;border-radius:${radius}px;background:#10141b;box-shadow:0 ${u * 0.002}px ${u * 0.006}px #000000c0,0 ${u * (0.01 + 0.04 * z)}px ${u * (0.02 + 0.07 * z)}px #000000b0,0 0 ${u * 0.1 * z}px rgb(${accentRgb().join(",")} / .16)"><img src="${src}" style="width:100%;height:100%;display:block;border-radius:inherit"><div style="position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px #ffffff2e,inset 0 1px 0 #ffffff4d"></div></div></div>`);
};
const markEl = (src, size) => h(`<div style="position:absolute;width:${size}px;height:${size}px;border-radius:${size * 0.23}px;overflow:hidden;box-shadow:0 0 0 1px #ffffff26,0 0 ${size * 0.5}px rgb(${accentRgb().join(",")} / .5)"><img src="${src}" style="width:100%;height:100%;display:block"></div>`);
const fitText = (el, maxWidth, size) => {
  el.style.fontSize = `${size}px`;
  const width = el.getBoundingClientRect().width;
  const fitted = width > maxWidth ? size * maxWidth / width : size;
  el.style.fontSize = `${fitted}px`;
  return fitted;
};

PATTERNS["halo-open"] = (layer0, s, ctx) => {
  const layer = h(`<div style="position:absolute;inset:0"></div>`); layer0.append(layer);
  K(layer, [[0, { scale: "1", opacity: 1 }], [s.d * 1000 - 220, { scale: "1.045", opacity: 1 }, "ease-in"], [s.d * 1000, { scale: "1.05", opacity: 0 }]]);
  const { W, H } = ctx, u = Math.min(W, H), cx = W / 2, cy = H / 2, mark = ctx.screen(s.mark);
  glowStage(layer0, W, H, s.d); layer0.insertBefore(layer0.lastChild, layer);
  const big = u * 0.2, ph = u * 0.14, gap = ph * 0.3, fs = ph * 0.4;
  const ghost = h(`<span style="position:absolute;visibility:hidden;white-space:nowrap;font:${fs}px/1 var(--display)">${esc(s.title)}</span>`);
  layer.append(ghost);
  const rawTw = ghost.getBoundingClientRect().width, textMax = W * 0.86 - ph - gap * 0.6 - ph * 0.45;
  const textScale = Math.min(1, textMax / rawTw), tw = rawTw * textScale, titleSize = fs * textScale; ghost.remove();
  const pw = ph + gap * 0.6 + tw + ph * 0.45, inner = ph * 0.74;
  const hal = halo(layer, W, H, cx, cy, big * 3);
  K(hal, [[0, { opacity: 0, transform: "scale(.5)" }], [600, { opacity: 1, transform: "scale(1)" }, INOUT], [1500, { opacity: 0.55, transform: "scale(.8)" }], [s.d * 1000, { opacity: 0.8, transform: "scale(1.05)" }]]);
  const pill = h(`<div style="position:absolute;left:${cx}px;top:${cy}px;height:${ph}px;margin-top:${-ph / 2}px;border-radius:${ph}px;background:#0a0d12cc;box-shadow:0 0 0 ${Math.max(2, u * 0.003)}px rgb(${accentRgb().join(",")} / .75),0 0 ${u * 0.05}px rgb(${accentRgb().join(",")} / .45)"></div>`);
  layer.append(pill);
  K(pill, [[0, { opacity: 0, width: `${big}px`, transform: `translateX(${-big / 2}px)` }], [650, { opacity: 0, width: `${big}px`, transform: `translateX(${-big / 2}px)` }],
    [651, { opacity: 1, width: `${ph}px`, transform: `translateX(${-ph / 2}px)` }, EXPO], [1100, { opacity: 1, width: `${pw}px`, transform: `translateX(${-pw / 2}px)` }]]);
  const logo = markEl(mark.url, big);
  logo.dataset.moves = "";
  layer.append(logo);
  const lx = cx - pw / 2 + (ph - inner) / 2;
  logo.style.left = `${cx - big / 2}px`; logo.style.top = `${cy - big / 2}px`;
  K(logo, [[0, { opacity: 0, transform: "scale(.7)" }], [500, { opacity: 1, transform: "none" }, EXPO], [650, { opacity: 1, transform: "scale(1)" }, EXPO],
    [1100, { opacity: 1, transform: `translate(${lx + inner / 2 - cx}px,0) scale(${inner / big})` }]]);
  const text = h(`<div data-safe style="position:absolute;left:${cx - pw / 2 + ph + gap * 0.6}px;top:${cy}px;transform:translateY(-50%);white-space:nowrap;font:${titleSize}px/1 var(--display);color:var(--text)">${esc(s.title)}</div>`);
  layer.append(text);
  K(text, [[0, { opacity: 0, transform: "translateY(-30%)" }], [800, { opacity: 0, transform: "translateY(-30%)" }, EXPO], [1200, { opacity: 1, transform: "translateY(-50%)" }]]);
};

// Sizes of a beat's pieces relative to each other, by how many there are: the middle one stands nearest and biggest, the
// ends sit back and small, and every neighbour overlaps the next, so no two pieces share a scale and none sit apart.
const SCALES = [[1.2], [1.35, 0.8], [0.85, 1.45, 0.7], [0.75, 1.4, 0.85, 0.65], [0.75, 1, 1.45, 0.9, 0.68], [0.75, 0.95, 1.4, 1.1, 0.85, 0.68]];
const LIFT = [-0.04, 0.035, -0.02, 0.05, -0.035, 0.02]; // vertical stagger, in short sides
const SATELLITES = [[1, 1, 1], [0, 0, 0.8], [1.04, 0.3, 0.65], [0.55, 1.03, 0.9]]; // chips on a card: corner x, corner y, scale

// Lay the beat's pieces out: [{cx, cy, w, h, z, radius}], from the crops' sizes. `z` is depth, 0 far to 1 near.
const arrange = (kind, sizes, W, H, u) => {
  const n = sizes.length, S = SCALES[n - 1], aspect = sizes.map(([w, hh]) => w / hh), z = (s) => Math.min(1, Math.max(0, (s - 0.68) / 0.72));
  const radiusOf = (w, hh, a, k = kind) => a > 0.85 && a < 1.18 ? Math.min(w, hh) / 2 : k === "chips" ? hh / 2 : k === "stack" ? Math.min(w, hh) * 0.3 : Math.min(w, hh) * 0.09;
  if (kind === "card") {
    const sat = n > 1, hero = Math.min(((sat ? 0.6 : 0.62) * W) / aspect[0], (sat ? 0.6 : 0.68) * H) * aspect[0], hw = hero, hh = hero / aspect[0];
    const cx = sat ? W * 0.47 : W / 2, cy = H * 0.52, out = [{ cx, cy, w: hw, h: hh, z: 0.45, radius: radiusOf(hw, hh, aspect[0]) }];
    for (let j = 1; j < n; j++) {
      const [fx, fy, sc] = SATELLITES[(j - 1) % SATELLITES.length], h2 = hh * 0.26 * sc, w2 = h2 * aspect[j];
      out.push({ cx: cx - hw / 2 + fx * hw, cy: cy - hh / 2 + fy * hh, w: w2, h: h2, z: 0.9 + 0.1 * (j % 2), radius: radiusOf(w2, h2, aspect[j], "chips") });
    }
    return out;
  }
  const base = kind === "stack" ? W * 0.62 : kind === "chips" ? u * 0.15 : u * 0.33, items = sizes.map((_, i) => {
    const sc = S[i], w = kind === "stack" ? base * sc : base * sc * aspect[i], hh = w / aspect[i];
    return { w, h: hh, z: z(sc), radius: radiusOf(w, hh, aspect[i]) };
  });
  if (kind === "stack") {
    const fit = Math.min(1, H * 0.8 / (items.reduce((m, p) => m + p.h * 0.88, 0) + items.at(-1).h * 0.12));
    const fitted = items.map((p) => ({ ...p, w: p.w * fit, h: p.h * fit }));
    const step = fitted.map((p) => p.h * 0.88), total = step.reduce((m, x) => m + x, 0) + fitted.at(-1).h * 0.12;
    let y = (H - total) / 2;
    return fitted.map((p, i) => { const c = { ...p, cx: W / 2 + (i % 2 ? 1 : -1) * W * 0.05, cy: y + p.h / 2 }; y += step[i]; return c; });
  }
  const overlap = kind === "chips" ? 0.06 : 0.05, fit = Math.min(1, (W * 0.8) / (items.reduce((m, p) => m + p.w * (1 - overlap), 0) + items.at(-1).w * overlap));
  let x = 0;
  const placed = items.map((p, i) => { const w = p.w * fit, hh = p.h * fit, c = { ...p, w, h: hh, cx: x + w / 2, cy: H * 0.5 + LIFT[i % LIFT.length] * u * 1.4 }; x += w * (1 - overlap); return c; });
  const span = x + placed.at(-1).w * overlap, shift = (W - span) / 2;
  return placed.map((p) => ({ ...p, cx: p.cx + shift }));
};

PATTERNS["halo-float"] = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), items = s.items ?? [], scr = items.map((id) => ctx.screen(id)), end = s.d * 1000;
  glowStage(layer, W, H, s.d);
  if (s.title) {
    const t = h(`<div data-safe style="position:absolute;left:${W * 0.07}px;top:${H * 0.09}px;white-space:nowrap;font:${u * 0.05}px/1.1 var(--display);color:var(--text);letter-spacing:-.01em">${wordSpans(s.title, "glow-word")}</div>`);
    layer.append(t); fitText(t, W * 0.86, u * 0.05); $$(".glow-word", t).forEach((w, i) => riseIn(w, i * 70));
  }
  const group = h(`<div style="position:absolute;inset:0"></div>`);
  // A soft backlight of the accent behind the beat: the shadows need something lighter than the stage to fall on.
  const back = halo(layer, W, H, W / 2, H * 0.5, u * 0.7); back.style.opacity = "0.55";
  layer.append(group);
  // One camera for the beat: it yaws a few degrees and pushes in, so every piece shares one vanishing point.
  group.style.transform = `perspective(${u * 2.4}px)`;
  K(group, [[0, { transform: `perspective(${u * 2.4}px) rotateY(-3deg) scale(1)` }], [end, { transform: `perspective(${u * 2.4}px) rotateY(3deg) scale(1.04)` }]]);
  const spots = arrange(s.kind, scr.map((c) => [c.width, c.height]), W, H, u);
  // Draw far to near so a near piece's shadow falls on the one behind it.
  spots.map((p, i) => ({ ...p, i })).sort((a, b) => a.z - b.z).forEach(({ cx, cy, w, h: hh, z, radius, i }, order) => {
    const el = piece(scr[i].url, w, hh, radius, z, u);
    el.style.left = `${cx - w / 2}px`; el.style.top = `${cy - hh / 2}px`; el.style.zIndex = String(order + 1);
    group.append(el);
    // Entrance: a short tilt-up and rise, the near ones travelling further and arriving last.
    const at = 80 + order * 90, rise = u * (0.05 + 0.06 * z);
    const pose = (a, tilt, y, sc) => ({ opacity: a, transform: `perspective(${u * 1.6}px) rotateX(${tilt}deg) translateY(${y}px) scale(${sc})` });
    const from = pose(0, 16, rise, 0.88), rest = pose(1, 0, 0, 1);
    K(el, [[0, from], [at, from, EXPO], [at + 600, rest], [end - 160, rest, "ease-in"], [end, pose(0, -4, -u * 0.015, 0.98)]]);
    el.dataset.moves = "";
    // Parallax: the whole beat pans one way, the near pieces faster than the far, with a slow bob that never settles.
    const pan = u * 0.05 * (0.3 + 1.4 * z), bob = u * 0.006 * (0.5 + z);
    tick((ms) => {
      const t = Math.min(1, Math.max(0, ms / end)), x = (0.5 - t) * 2 * pan, y = Math.sin((ms / 2800) * Math.PI * 2 + i * 1.7) * bob;
      el.style.translate = `${x.toFixed(3)}px ${y.toFixed(3)}px`;
    });
  });
};

// Where the kinetic lines keep the product in view: earlier pieces, small and further back at the frame's corners,
// clear of the centred type, drifting on the same parallax as the beats they came from. [x, y, size, depth].
const BACKDROP = [[0.13, 0.76, 1, 0.4], [0.87, 0.24, 0.8, 0.15], [0.86, 0.78, 1.1, 0.55], [0.14, 0.24, 0.75, 0.1]];
PATTERNS["halo-lines"] = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), lines = s.lines ?? [], slot = (s.d * 1000) / lines.length, end = s.d * 1000;
  glowStage(layer, W, H, s.d);
  (s.items ?? []).slice(0, BACKDROP.length).forEach((id, i) => {
    const c = ctx.screen(id), [fx, fy, sc, z] = BACKDROP[i], a = c.width / c.height;
    const w = Math.min(a >= 1.18 ? W * 0.2 * sc : u * 0.24 * sc * a, W * 0.22), hh = w / a;
    const circle = a > 0.85 && a < 1.18, radius = circle || a > 2 ? Math.min(w, hh) / 2 : Math.min(w, hh) * 0.2;
    const el = piece(c.url, w, hh, radius, z, u);
    el.style.left = `${W * fx - w / 2}px`; el.style.top = `${H * fy - hh / 2}px`; el.style.zIndex = "0";
    layer.append(el); el.dataset.moves = "";
    K(el, [[0, { opacity: 0, transform: `translateY(${u * 0.05}px) scale(.9)` }], [120 + i * 90, { opacity: 0, transform: `translateY(${u * 0.05}px) scale(.9)` }, EXPO], [900 + i * 90, { opacity: 0.8, transform: "none" }], [end - 200, { opacity: 0.8, transform: "none" }, "ease-in"], [end, { opacity: 0, transform: "none" }]]);
    const pan = u * 0.05 * (0.3 + 1.4 * z), bob = u * 0.006 * (0.5 + z);
    tick((ms) => { const t = Math.min(1, Math.max(0, ms / end)); el.style.translate = `${((0.5 - t) * 2 * pan).toFixed(3)}px ${(Math.sin((ms / 2800) * Math.PI * 2 + i * 1.7) * bob).toFixed(3)}px`; });
  });
  lines.forEach((text, k) => {
    const last = k === lines.length - 1, size = u * 0.075;
    const el = h(`<div data-safe style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);white-space:nowrap;text-align:center;font:${size}px/1.1 var(--display);letter-spacing:-.015em;color:var(--text)">${wordSpans(text, "glow-word")}</div>`);
    layer.append(el); fitText(el, W * 0.84, size);
    const base = BASE; BASE = base + slot * k; $$(".glow-word", el).forEach((w, i) => riseIn(w, i * 70)); BASE = base;
    WINDOW(el, slot * k, last ? s.d * 1000 : slot * (k + 1));
    if (!last) { const sb = BASE; BASE = sb + slot * k; K(el, [[0, { opacity: 0.72 }], [slot - 200, { opacity: 0.72 }, "ease-in"], [slot - 1, { opacity: 0 }]]); BASE = sb; }
    // The line before the last is the grey lead-in; the last one is bright.
    const sb = BASE; BASE = sb + slot * k; K(el, [[0, { scale: "1" }], [slot, { scale: "1.06" }]]); BASE = sb;
  });
};

PATTERNS["halo-end"] = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), mark = ctx.screen(s.mark);
  glowStage(layer, W, H, s.d);
  const size = Math.min(W * 0.075, u * 0.14), d = size * 0.95;
  const group = h(`<div style="position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;gap:${size * 0.28}px"></div>`);
  const logo = markEl(mark.url, d); logo.style.position = "relative";
  const word = kernedLetters(s.logo);
  word.style.font = `${size}px/1.1 var(--display)`; word.style.color = "var(--text)";
  group.append(logo, word); layer.append(group);
  const wordSize = fitText(word, W * 0.82 - d - size * 0.28, size);
  K(logo, [[0, { opacity: 0, transform: "scale(.8)" }], [450, { opacity: 1, transform: "none" }]]);
  const base = BASE;
  AFTER_MOUNT.push(() => {
    BASE = base + 400;
    // Type-on: each glyph steps in, one every 70 ms, with a short rise.
    word.layoutGlyphs().forEach((g, i) => K(g.span, [[0, { opacity: 0, transform: `translate(${g.x}px,${wordSize * 0.12}px)` }], [i * 70, { opacity: 0, transform: `translate(${g.x}px,${wordSize * 0.12}px)` }, EXPO], [i * 70 + 300, { opacity: 1, transform: `translate(${g.x}px,0px)` }]]));
    BASE = 0;
  });
  if (s.credit) {
    const c = h(`<div data-safe style="position:absolute;left:50%;transform:translateX(-50%);white-space:nowrap;bottom:${H * 0.1}px;text-align:center;font:${u * 0.024}px/1.4 var(--body);color:var(--muted)">${esc(s.credit)}</div>`);
    layer.append(c); fitText(c, W * 0.84, u * 0.024);
    K(c, [[0, { opacity: 0 }], [900, { opacity: 0 }, SMOOTH], [1500, { opacity: 1 }]]);
  }
  K(group, [[0, { scale: "1" }], [s.d * 1000, { scale: "1.03" }]]);
};
})();
