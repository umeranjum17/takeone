// TakeOne motion runtime: loaded first into every motion page. Everything on screen is a pure function of the
// page clock: WAAPI animations (fill: both) are paused and seeked, and per-frame ticks are pure functions of t.
// Patterns register builders in PATTERNS; fragments in FRAGMENTS; device chrome in CHROME.
"use strict";
window.PATTERNS = {};
window.FRAGMENTS = {};
window.CHROME = {};
window.TICKS = []; // (ms) => void, run on every seek after animations are baked
window.BASE = 0; // ms added to every animation created while set: scene-local keys, page-global clock

// K(el, [[ms, props, easing?], ...]): one animation; easing applies to the segment starting at that key.
window.K = (el, keys) => {
  if (keys[0][0] > 0) keys = [[0, keys[0][1]], ...keys];
  if (keys.length === 1) keys = [keys[0], [1, keys[0][1]]];
  const dur = Math.max(1, keys.at(-1)[0]);
  keys.forEach((k, i) => { if (i && k[0] < keys[i - 1][0]) throw new Error(`K: key ${i} at ${k[0]} before ${keys[i - 1][0]}`); });
  const animation = el.animate(keys.map(([ms, p, e]) => ({ ...p, offset: ms / dur, easing: e || "linear" })),
    { duration: dur, fill: "both", delay: window.BASE });
  animation.pause(); animation.currentTime = 0;
  return animation;
};
// Hard switch: value a before ms, b from ms.
window.SW = (ms, a, b) => [[Math.max(0, ms - 0.5), a], [ms, b]];
// Visible only in [t0, t1) ms (scene-local).
window.WINDOW = (el, t0, t1) => {
  const on = { visibility: "visible" }, off = { visibility: "hidden" };
  const base = BASE, start = base + t0, end = base + t1;
  const keys = end <= 0 ? [[0, off], [1, off]] : [
    ...(start > 0 ? [[0, off], ...SW(start, off, on)] : [[0, on]]),
    ...SW(end, on, off),
  ];
  // Visibility belongs to the page clock. A fill:both animation delayed to a future scene would
  // otherwise show its first (visible) key before the delay and cover the current scene.
  BASE = 0;
  const animation = K(el, keys);
  BASE = base;
  return animation;
};

window.smootherstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10));
window.SMOOTH = `linear(${Array.from({ length: 33 }, (_, i) => smootherstep(i / 32).toFixed(4)).join(",")})`;
window.$ = (s, r = document) => r.querySelector(s);
window.$$ = (s, r = document) => [...r.querySelectorAll(s)];
window.h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
window.esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Per-frame tick helper: f(localMs) runs only while the scene clock is inside [0, d] (clamped outside).
window.tick = (fn) => { const base = window.BASE; TICKS.push((ms) => fn(ms - base)); };

// Kerned glyph layout (L8-e). Never per-letter inline-block spans: set the run as one kerned text node, measure
// every glyph's x with Range rects, then place absolutely positioned glyph spans at those x offsets.
// Returns { el, glyphs: [{span, x, w, ch}] }; el keeps the run's exact width and baseline.
window.kernedLetters = (text, className = "") => {
  const el = h(`<span class="kern ${className}" style="position:relative;display:inline-block;white-space:pre"></span>`);
  const ghost = h(`<span style="visibility:hidden;white-space:pre"></span>`);
  ghost.textContent = text;
  el.append(ghost);
  el.layoutGlyphs = () => {
    const measure = ghost.cloneNode(true), cs = getComputedStyle(el);
    measure.style.cssText = `position:fixed;left:0;top:0;visibility:hidden;white-space:pre;font:${cs.font};font-kerning:${cs.fontKerning};letter-spacing:${cs.letterSpacing};font-variant-ligatures:none`;
    document.body.append(measure);
    const node = measure.firstChild, r = document.createRange(), x0 = measure.getBoundingClientRect().left, out = [];
    for (const { segment: ch, index: i } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
      r.setStart(node, i); r.setEnd(node, i + ch.length);
      const b = r.getBoundingClientRect();
      if (ch.trim()) {
        const span = h(`<span style="position:absolute;left:0;top:0;white-space:pre"></span>`);
        span.textContent = ch;
        span.style.transform = `translateX(${(b.left - x0).toFixed(3)}px)`;
        span.dataset.x = String(b.left - x0);
        el.append(span);
        out.push({ span, x: b.left - x0, w: b.width, ch });
      }
    }
    measure.remove();
    return out;
  };
  return el;
};

// Fonts are bundled local files; the page fails loudly instead of falling back.
const parsed = new Promise((r) => (document.readyState === "loading" ? addEventListener("DOMContentLoaded", r) : r()));
window.ready = parsed.then(async () => {
  await document.fonts.ready;
  for (const f of window.FONT_FACES ?? []) {
    const got = await document.fonts.load(f);
    if (!got.length) throw new Error("font did not load: " + f);
  }
  if (!window.setup) throw new Error("page defines no window.setup");
  await window.setup();
  await Promise.all([...document.images].map((i) => i.decode()));
  await document.fonts.ready;
  const bad = [...document.fonts].filter((f) => f.status === "error").map((f) => f.family);
  if (bad.length) throw new Error("font failed: " + bad.join(","));
});

// Determinism (L8-a): pause every animation, then on each seek attach each animation to its element just long
// enough to read the computed values at t, detach it, and write those values inline. No live animation is left
// to promote a composited layer whose raster depends on frame history. The root background flips #000/#010101
// (covered by the stage) so every tile re-rasters from scratch, then 2 rAF settle.
window.installSeek = (settle = 2) => {
  const anims = document.getAnimations().map((a) => ({
    a, el: a.effect.target,
    props: [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k))
      .filter((p) => !["offset", "computedOffset", "easing", "composite"].includes(p)))],
  }));
  for (const x of anims) { x.a.pause(); x.inline = x.props.map((p) => x.el.style[p]); }
  let flip = false;
  const apply = (ms) => {
    for (const x of anims) x.props.forEach((p, i) => (x.el.style[p] = x.inline[i]));
    for (const x of anims) { x.a.effect.target = x.el; x.a.currentTime = ms; }
    const vals = anims.map((x) => { const cs = getComputedStyle(x.el); return x.props.map((p) => cs[p]); });
    for (const x of anims) x.a.effect.target = null;
    anims.forEach((x, j) => x.props.forEach((p, i) => (x.el.style[p] = vals[j][i])));
    for (const t of TICKS) t(ms);
  };
  window.__apply = apply;
  window.__seek = (ms) => {
    apply(ms);
    document.documentElement.style.backgroundColor = (flip = !flip) ? "#010101" : "#000";
    let n = settle;
    return new Promise((r) => { const f = () => (n-- > 0 ? requestAnimationFrame(f) : r()); f(); });
  };
  // Motion-blur planning (L8-i): max on-screen displacement in px between two page times, over every element an
  // animation or tick moves. Measured from layout boxes, so it covers camera pushes and pattern moves alike.
  const tracked = () => [...new Set([...anims.map((x) => x.el), ...$$("[data-moves]")])];
  window.__speed = (ms0, ms1) => {
    const els = tracked(), boxes = [];
    apply(ms0); for (const el of els) boxes.push(el.getBoundingClientRect());
    apply(ms1);
    let max = 0;
    els.forEach((el, i) => {
      const a = boxes[i], b = el.getBoundingClientRect();
      if (!a.width && !b.width) return;
      if (getComputedStyle(el).visibility === "hidden") return;
      max = Math.max(max, Math.hypot(a.left - b.left, a.top - b.top), Math.hypot(a.right - b.right, a.bottom - b.bottom));
    });
    return max;
  };
  return anims.length;
};
