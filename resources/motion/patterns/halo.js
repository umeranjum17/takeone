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
const piece = (src, w, hh, radius) => h(`<div style="position:absolute;width:${w}px;height:${hh}px;border-radius:${radius}px;overflow:hidden;box-shadow:0 0 0 1px #ffffff1c,0 ${hh * 0.12}px ${hh * 0.3}px #000a"><img src="${src}" style="width:100%;height:100%;display:block"></div>`);
const markEl = (src, size) => h(`<div style="position:absolute;width:${size}px;height:${size}px;border-radius:${size * 0.23}px;overflow:hidden;box-shadow:0 0 0 1px #ffffff26,0 0 ${size * 0.5}px rgb(${accentRgb().join(",")} / .5)"><img src="${src}" style="width:100%;height:100%;display:block"></div>`);
// A gentle drift that never settles: a pure function of the page clock.
const drift = (el, base, amp, period, phase) => tick((ms) => { const y = Math.sin((ms / period) * Math.PI * 2 + phase) * amp; el.style.translate = `0 ${y.toFixed(3)}px`; });

PATTERNS["halo-open"] = (layer0, s, ctx) => {
  const layer = h(`<div style="position:absolute;inset:0"></div>`); layer0.append(layer);
  K(layer, [[0, { scale: "1", opacity: 1 }], [s.d * 1000 - 220, { scale: "1.045", opacity: 1 }, "ease-in"], [s.d * 1000, { scale: "1.05", opacity: 0 }]]);
  const { W, H } = ctx, u = Math.min(W, H), cx = W / 2, cy = H / 2, mark = ctx.screen(s.mark);
  glowStage(layer0, W, H, s.d); layer0.insertBefore(layer0.lastChild, layer);
  const big = u * 0.2, ph = u * 0.14, gap = ph * 0.3, fs = ph * 0.4;
  const ghost = h(`<span style="position:absolute;visibility:hidden;white-space:nowrap;font:${fs}px/1 var(--display)">${esc(s.title)}</span>`);
  layer.append(ghost);
  const tw = ghost.getBoundingClientRect().width; ghost.remove();
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
  const text = h(`<div data-safe style="position:absolute;left:${cx - pw / 2 + ph + gap * 0.6}px;top:${cy}px;transform:translateY(-50%);white-space:nowrap;font:${fs}px/1 var(--display);color:var(--text)">${esc(s.title)}</div>`);
  layer.append(text);
  K(text, [[0, { opacity: 0, transform: "translateY(-30%)" }], [800, { opacity: 0, transform: "translateY(-30%)" }, EXPO], [1200, { opacity: 1, transform: "translateY(-50%)" }]]);
};

PATTERNS["halo-float"] = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), items = s.items ?? [], scr = items.map((id) => ctx.screen(id));
  glowStage(layer, W, H, s.d);
  if (s.title) {
    const t = h(`<div data-safe style="position:absolute;left:${W * 0.07}px;top:${H * 0.09}px;font:${u * 0.05}px/1.1 var(--display);color:var(--text);letter-spacing:-.01em">${wordSpans(s.title, "glow-word")}</div>`);
    layer.append(t); $$(".glow-word", t).forEach((w, i) => riseIn(w, i * 70));
  }
  // Sizes: a row shares 84% of the width, a card stands up to 56% of the height, a stack shares 70% of the height
  // and half the width, chips are a tenth of the short side tall.
  const gap = s.kind === "chips" ? u * 0.03 : u * 0.04;
  const k = s.kind === "row" ? Math.min((W * 0.84 - gap * (items.length - 1)) / scr.reduce((n, c) => n + c.width, 0), (H * 0.34) / Math.max(...scr.map((c) => c.height)))
    : s.kind === "card" ? Math.min((W * 0.56) / scr[0].width, (H * 0.6) / scr[0].height)
    : s.kind === "stack" ? Math.min((W * 0.5) / Math.max(...scr.map((c) => c.width)), (H * 0.7 - gap * (items.length - 1)) / scr.reduce((n, c) => n + c.height, 0))
    : Math.min((u * 0.1) / Math.max(...scr.map((c) => c.height)), (W * 0.84 - gap * (items.length - 1)) / scr.reduce((n, c) => n + c.width, 0));
  const sizes = scr.map((c) => [c.width * k, c.height * k]);
  const stack = s.kind === "stack", total = stack ? sizes.reduce((n, [, hh]) => n + hh, 0) + gap * (items.length - 1) : sizes.reduce((n, [w]) => n + w, 0) + gap * (items.length - 1);
  let x = (W - total) / 2, yy = (H - total) / 2;
  const group = h(`<div style="position:absolute;inset:0"></div>`); layer.append(group);
  const back = h(`<div style="position:absolute;inset:0"></div>`); layer.insertBefore(back, group);
  K(group, [[0, { scale: "1" }], [s.d * 1000, { scale: "1.045" }]]);
  K(back, [[0, { scale: "1.06", opacity: 0 }], [500, { scale: "1.05", opacity: 1 }], [s.d * 1000, { scale: "0.98", opacity: 1 }]]);
  items.forEach((id, i) => {
    const [w, hh] = sizes[i], radius = s.kind === "chips" ? hh / 2 : s.kind === "stack" ? 36 * k : 32 * k; // the product's own corner radii, in its 2x pixels
    // Depth: pieces alternate a hair larger and a hair lower, the near ones throwing the longer shadow.
    const near = i % 2 === 0, el = piece(scr[i].url, w, hh, radius);
    const left = stack ? (W - w) / 2 + (near ? -1 : 1) * u * 0.03 : x, top = stack ? yy : s.kind === "card" ? H * 0.5 - hh / 2 : H * 0.5 - hh / 2 + (near ? 0 : u * 0.03);
    el.style.left = `${left}px`; el.style.top = `${top}px`; if (near) el.style.zIndex = "2";
    // Depth of field: a big, dim, blurred copy far behind, drifting the other way.
    const ghost = piece(scr[i].url, w * 1.55, hh * 1.55, radius * 1.55);
    ghost.style.left = `${left - w * 0.28 + (i % 2 ? 1 : -1) * W * 0.12}px`; ghost.style.top = `${top - hh * 0.3 - (i % 2 ? 1 : -1) * H * 0.1}px`; ghost.style.filter = "blur(18px)"; ghost.style.opacity = "0.16";
    back.append(ghost); drift(ghost, 0, u * 0.01, 3600, i * 2.3 + 1);
    group.append(el); if (stack) yy += hh + gap; else x += w + gap;
    const at = 120 + i * 130, tilt = (a, y, k) => ({ opacity: a, transform: `perspective(${u * 1.6}px) rotateX(${y}deg) translateY(${k}px) scale(${near ? 1.03 : 1})` });
    const from = { ...tilt(0, 22, u * 0.09), filter: "blur(12px)" }, rest = { ...tilt(1, 0, 0), filter: "blur(0px)" };
    const end = s.d * 1000;
    K(el, [[0, from], [at, from, EXPO], [at + 700, rest], [end - 160, rest, "ease-in"], [end, { ...tilt(0, -6, -u * 0.02), filter: "blur(0px)" }]]);
    el.dataset.moves = "";
    drift(el, 0, u * (near ? 0.009 : 0.012), 2600, i * 1.7);
  });
};

PATTERNS["halo-lines"] = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), lines = s.lines ?? [], slot = (s.d * 1000) / lines.length;
  glowStage(layer, W, H, s.d);
  lines.forEach((text, k) => {
    const last = k === lines.length - 1, size = Math.min(u * 0.075, (W * 0.84) / (0.52 * text.length));
    const el = h(`<div data-safe style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);white-space:nowrap;text-align:center;font:${size}px/1.1 var(--display);letter-spacing:-.015em;color:var(--text)">${wordSpans(text, "glow-word")}</div>`);
    layer.append(el);
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
  K(logo, [[0, { opacity: 0, transform: "scale(.8)" }], [450, { opacity: 1, transform: "none" }]]);
  const base = BASE;
  AFTER_MOUNT.push(() => {
    BASE = base + 400;
    // Type-on: each glyph steps in, one every 70 ms, with a short rise.
    word.layoutGlyphs().forEach((g, i) => K(g.span, [[0, { opacity: 0, transform: `translate(${g.x}px,${size * 0.12}px)` }], [i * 70, { opacity: 0, transform: `translate(${g.x}px,${size * 0.12}px)` }, EXPO], [i * 70 + 300, { opacity: 1, transform: `translate(${g.x}px,0px)` }]]));
    BASE = 0;
  });
  if (s.credit) {
    const c = h(`<div data-safe style="position:absolute;left:50%;transform:translateX(-50%);white-space:nowrap;bottom:${H * 0.1}px;text-align:center;font:${u * 0.024}px/1.4 var(--body);color:var(--muted)">${esc(s.credit)}</div>`);
    layer.append(c);
    K(c, [[0, { opacity: 0 }], [900, { opacity: 0 }, SMOOTH], [1500, { opacity: 1 }]]);
  }
  K(group, [[0, { scale: "1" }], [s.d * 1000, { scale: "1.03" }]]);
};
})();
