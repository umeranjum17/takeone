// Glow-reel beats (the `--recipe glow` grammar): a near-black navy stage lit by an electric-blue glow that jumps
// between cuts, a typed prompt box, kinetic words cut every third of a second, one bold gradient ribbon with a
// headline and a pressed button, a file tree, a deck of real-screen cards, and the real screen with a glowing click.
// Deterministic: SVG gradients and a fixed-seed SVG noise dither (no CSS gradients), every move a pure function of the
// scene clock.
// Shares EXPO, riseWords and rise with editorial.js (one page scope, loaded before this file).
// Every colour below is the legacy electric-blue grammar. `glC` maps one to the theme's accent family: the identity when the
// accent is the default blue (so an unbranded promo is unchanged), else the same colour with its hue turned to the accent's
// hue and its saturation scaled to the accent's; lightness and alpha stay, so the glow keeps its depth in any brand colour.
const GL_DEFAULT = "#2f7bff";
const glHsl = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, c = max - min;
  const hue = !c ? 0 : (max === r ? ((g - b) / c + 6) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4) * 60;
  return [hue, !c ? 0 : c / (1 - Math.abs(2 * l - 1)), l];
};
const glHex = (hue, s, l) => {
  const a = s * Math.min(l, 1 - l), f = (n) => { const k = (n + hue / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return "#" + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
};
const glAccent = STORYBOARD.tokens.accent.toLowerCase();
const [glH0] = glHsl(GL_DEFAULT), [glH1, glS1] = glHsl(glAccent);
const glC = (hex) => {
  if (glAccent === GL_DEFAULT) return hex;
  const [h0, s0, l0] = glHsl(hex);
  return glHex((h0 + glH1 - glH0 + 360) % 360, Math.min(1, s0 * glS1), l0) + hex.slice(7);
};
const GL_BLUE = glAccent, GL_TEXT = STORYBOARD.tokens.text, GL_BG = STORYBOARD.tokens.background, GL_CARD = STORYBOARD.tokens.card;
const GL_EDGE = STORYBOARD.tokens.border_color, GL_LINE = STORYBOARD.tokens.line, GL_MUTED = STORYBOARD.tokens.muted;
const glCursor = (size) => h(`<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="position:absolute;left:0;top:0;overflow:visible"><path d="M3 2 L3 19 L8 14.5 L11.5 22 L14.5 20.6 L11 13.4 L17.5 13.4 Z" fill="#ffffff" stroke="#0b0b0b" stroke-width="1.4" stroke-linejoin="round"/></svg>`);
// A cursor that arrives on a point and presses it: it flies in from `from` (px offset), dips at `press` ms, rises 150 ms later.
const glPress = (pin, from, arrive, press) => K(pin, [[0, { opacity: 0, transform: `translate(${from[0]}px,${from[1]}px)` }], [Math.max(1, arrive - 450), { opacity: 0, transform: `translate(${from[0]}px,${from[1]}px)` }, EXPO],
  [arrive, { opacity: 1, transform: "none" }], [press, { opacity: 1, transform: "none" }], [press + 60, { opacity: 1, transform: "scale(.86)" }], [press + 210, { opacity: 1, transform: "none" }]]);
// The press glow on a control: dark until `at`, then lit and held.
const glLit = (el, at) => K(el, [[0, { opacity: 0, transform: "scale(.96)" }], ...SW(at, { opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "scale(1)" }), [at + 150, { opacity: 1, transform: "scale(1.04)" }, EXPO], [at + 420, { opacity: 1, transform: "scale(1)" }]]);

// The stage: near-black navy, a blue glow centred at `at` (fractions of the frame), a fixed-seed noise dither over it.
// Returns the glow group so a beat can move the glow (the rect is oversized so it never shows an edge).
window.glowBg = (layer, W, H, at = [0.8, 0.9]) => {
  const id = `gl${layer.dataset.scene ?? 0}`;
  const svg = h(`<svg width="${W}" height="${H}" style="position:absolute;left:0;top:0"><defs>
    <radialGradient id="${id}a" gradientUnits="userSpaceOnUse" cx="${W * at[0]}" cy="${H * at[1]}" r="${W * 0.72}"><stop offset="0" stop-color="${glC("#1f6bff")}" stop-opacity=".95"/><stop offset=".28" stop-color="${glC("#0d3fc4")}" stop-opacity=".6"/><stop offset=".62" stop-color="${glC("#071a6b")}" stop-opacity=".24"/><stop offset="1" stop-color="${GL_BG}" stop-opacity="0"/></radialGradient>
    <filter id="${id}n" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="1" seed="7"/><feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 .1 0 0 0 0"/></filter></defs>
    <rect width="${W}" height="${H}" fill="${GL_BG}"/><g><rect x="${-W / 2}" y="${-H / 2}" width="${W * 2}" height="${H * 2}" fill="url(#${id}a)"/></g>
    <rect width="${W}" height="${H}" filter="url(#${id}n)" opacity=".5"/></svg>`);
  layer.append(svg);
  return svg.querySelector("g");
};

PATTERNS["glow-prompt"] = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), d = s.d * 1000, text = s.text ?? "", pad = u * 0.03;
  glowBg(layer, W, H, [0.8, 1.05]);
  const size = Math.min(u * 0.052, (W * 0.5) / (0.56 * Math.max(10, text.length))), bw = W * 0.62, sendAt = d * 0.8;
  const card = h(`<div data-safe style="position:absolute;left:${(W - bw) / 2}px;top:${H * 0.32}px;width:${bw}px;padding:${pad}px;border-radius:${u * 0.035}px;background:${GL_CARD};border:${Math.max(1, u * 0.002)}px solid ${GL_EDGE};box-shadow:0 ${u * 0.02}px ${u * 0.08}px #000a,0 0 ${u * 0.12}px ${glC("#1f6bff55")}"></div>`);
  const line = h(`<div style="position:relative;font:500 ${size}px/1.3 var(--body);color:${GL_TEXT};white-space:nowrap"><span style="visibility:hidden">${esc(text)}</span><span style="position:absolute;left:0;top:0"><span class="gl-typed"></span><i style="display:inline-block;width:.08em;height:1.05em;margin-left:.06em;vertical-align:-.16em;background:${GL_BLUE}"></i></span></div>`);
  const send = h(`<div style="margin-left:auto;width:${u * 0.062}px;height:${u * 0.062}px;border-radius:50%;background:${GL_BLUE};display:grid;place-items:center"><svg width="55%" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`);
  const foot = h(`<div style="display:flex;margin-top:${pad * 1.6}px"></div>`);
  foot.append(send); card.append(line, foot); layer.append(card);
  // Typing fills 62% of the beat, a character at a time; the send button presses at 80% and glows.
  const typed = $(".gl-typed", line), per = (d * 0.62) / Math.max(1, text.length);
  tick((ms) => { typed.textContent = text.slice(0, Math.min(text.length, Math.max(1, Math.floor(ms / per) + 1))); });
  K(card, [[0, { transform: "scale(.96)" }, EXPO], [450, { transform: "none" }], [d, { transform: "scale(1.03)" }]]);
  K(send, [[0, { transform: "scale(1)", boxShadow: `0 0 0 0 ${GL_BLUE}00` }], [sendAt - 20, { transform: "scale(1)", boxShadow: `0 0 0 0 ${GL_BLUE}00` }, EXPO], [sendAt + 80, { transform: "scale(.86)", boxShadow: `0 0 ${u * 0.07}px ${u * 0.02}px ${glC("#6aaaffdd")}` }], [sendAt + 260, { transform: "scale(1)", boxShadow: `0 0 ${u * 0.05}px ${u * 0.012}px ${glC("#6aaaff99")}` }]]);
};

// Kinetic words: each title word hard-cuts in for an equal share of the beat, the glow jumping with it.
PATTERNS["glow-words"] = (layer, s, ctx) => {
  const { W, H } = ctx, words = (s.title ?? "").split(/\s+/).filter(Boolean), step = (s.d * 1000) / words.length;
  const size = Math.min(H * 0.34, (W * 0.8) / (0.62 * Math.max(...words.map((w) => w.length))));
  const g = glowBg(layer, W, H, [0.5, 0.5]);
  const spots = [[-0.28, 0.2], [0.3, -0.18], [-0.1, 0.32], [0.26, 0.12]].map(([x, y]) => `translate(${W * x}px,${H * y}px)`);
  K(g, [[0, { transform: spots[0] }], ...words.slice(1).flatMap((_, i) => SW((i + 1) * step, { transform: spots[i % 4] }, { transform: spots[(i + 1) % 4] }))]);
  words.forEach((w, i) => {
    const el = h(`<div style="position:absolute;inset:0;display:grid;place-items:center;font:700 ${size}px/1 var(--display);letter-spacing:-.03em;color:${i === words.length - 1 ? glC("#8fc0ff") : GL_TEXT}"><span data-safe>${esc(w)}</span></div>`);
    layer.append(el);
    WINDOW(el, i * step, (i + 1) * step);
    K(el, [[i * step, { transform: "scale(1.14)" }, EXPO], [i * step + 220, { transform: "none" }]]);
  });
};

// The 3D ribbon: one thick S-curve, an under-shadow, a gradient body, a blurred specular and an outer glow, drawn in.
const GL_RIBBON = "M 90 800 C 330 900 380 560 520 520 C 690 470 640 170 910 110";
PATTERNS["glow-hero"] = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), d = s.d * 1000, sz = H * 1.1, words = (s.title ?? "").split(/\s+/).filter(Boolean);
  glowBg(layer, W, H, [0.78, 0.55]);
  const stroke = (extra) => `<path d="${GL_RIBBON}" fill="none" stroke-linecap="round" ${extra}/>`;
  const rib = h(`<svg viewBox="0 0 1000 1000" width="${sz}" height="${sz}" style="position:absolute;right:${-W * 0.03}px;top:${(H - sz) / 2}px;overflow:visible"><defs>
    <linearGradient id="glr" gradientUnits="userSpaceOnUse" x1="90" y1="900" x2="910" y2="110"><stop offset="0" stop-color="${glC("#0a2fd6")}"/><stop offset=".5" stop-color="${glC("#1c8bff")}"/><stop offset="1" stop-color="${glC("#6bf4ff")}"/></linearGradient>
    <linearGradient id="glh" gradientUnits="userSpaceOnUse" x1="90" y1="900" x2="910" y2="110"><stop offset="0" stop-color="${glC("#7fd0ff")}"/><stop offset="1" stop-color="#ffffff"/></linearGradient>
    <filter id="glb1" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="16"/></filter>
    <filter id="glb2" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="46"/></filter></defs>
    <g class="rg">${stroke(`stroke="${glC("#3c8dff")}" stroke-width="300" opacity=".55" filter="url(#glb2)"`)}${stroke(`stroke="${glC("#010a35")}" stroke-width="250" opacity=".85" transform="translate(30 46)" filter="url(#glb1)"`)}${stroke('stroke="url(#glr)" stroke-width="240"')}${stroke('stroke="url(#glh)" stroke-width="70" opacity=".8" transform="translate(-40 -52)" filter="url(#glb1)"')}</g></svg>`);
  layer.append(rib);
  // The ribbon swings in from the lower right, then drifts.
  K($(".rg", rib), [[0, { transform: `translate(${W * 0.12}px,${H * 0.2}px) rotate(-10deg) scale(.85)` }, EXPO], [900, { transform: "rotate(-3deg) scale(1)" }], [d, { transform: "rotate(2deg) scale(1.07)" }]]);
  const col = h(`<div style="position:absolute;left:${W * 0.08}px;top:50%;width:${W * 0.46}px;transform:translateY(-50%)"></div>`);
  const head = h(`<div data-safe style="font:700 ${Math.min(u * 0.19, (W * 0.44) / (0.58 * Math.max(...words.map((w) => w.length))))}px/1.02 var(--display);letter-spacing:-.03em;color:${GL_TEXT};text-wrap:balance">${riseWords(s.title ?? "")}</div>`);
  const btn = h(`<div data-safe style="position:relative;display:inline-block;margin-top:${u * 0.05}px;padding:${u * 0.02}px ${u * 0.04}px;border-radius:999px;background:${GL_TEXT}1a;border:${Math.max(1.5, u * 0.003)}px solid ${GL_TEXT}66;color:${GL_TEXT};font:600 ${u * 0.038}px/1 var(--body)">${esc(s.text ?? "")}</div>`);
  const lit = h(`<div style="position:absolute;inset:${-u * 0.006}px;border-radius:999px;border:${Math.max(2, u * 0.004)}px solid ${glC("#cfe3ff")};box-shadow:0 0 ${u * 0.05}px ${u * 0.012}px ${glC("#4f9aff")},inset 0 0 ${u * 0.02}px ${glC("#8fc0ff88")}"></div>`);
  const pin = h(`<div data-moves style="position:absolute;right:12%;bottom:6%;width:0;height:0"></div>`);
  pin.append(glCursor(u * 0.055)); btn.append(lit, pin); col.append(head, btn); layer.append(col); rise(head, 0);
  glLit(lit, d * 0.6);
  glPress(pin, [W * 0.28, H * 0.3], d * 0.56, d * 0.6);
  K(col, [[0, { transform: "translateY(-50%) scale(1)" }], [d, { transform: "translateY(-50%) scale(1.03)" }]]);
};

// A file tree: rows (two spaces of indent per level) reveal fast, connectors drawn, the last row selected.
PATTERNS["glow-tree"] = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), rows = (s.tree ?? []).map((t) => ({ depth: /^ */.exec(t)[0].length >> 1, t: t.trim() }));
  glowBg(layer, W, H, [0.18, 0.9]);
  const size = Math.min(u * 0.062, (H * 0.72) / (rows.length * 1.6)), pitch = size * 1.6, step = size * 1.5;
  const col = h(`<div data-safe style="position:absolute;left:${W * 0.32}px;top:${(H - rows.length * pitch) / 2}px;width:${W * 0.4}px"></div>`);
  layer.append(col);
  rows.forEach((r, i) => {
    const last = i === rows.length - 1, ic = size * 0.8;
    const row = h(`<div style="position:relative;height:${pitch}px;margin-left:${r.depth * step}px;display:flex;align-items:center;gap:${size * 0.4}px;padding:0 ${size * 0.5}px;border-radius:${size * 0.4}px;font:500 ${size}px/1 var(--body);color:${last ? GL_TEXT : GL_MUTED};white-space:nowrap;${last ? `background:${GL_BLUE}40;box-shadow:0 0 0 ${Math.max(1.5, u * 0.003)}px ${glC("#5aa0ff")},0 0 ${u * 0.04}px ${GL_BLUE}99;` : ""}"></div>`);
    row.append(h(`<svg width="${ic}" height="${ic}" viewBox="0 0 24 24" fill="none" stroke="${last ? GL_TEXT : glC("#7f93c8")}" stroke-width="2" stroke-linejoin="round">${r.depth ? '<path d="M6 3h8l4 4v14H6z"/>' : '<path d="M3 7h7l2 2h9v10H3z"/>'}</svg>`), document.createTextNode(r.t));
    if (r.depth) row.append(h(`<span style="position:absolute;left:${-step * 0.55}px;top:${-pitch / 2}px;width:${step * 0.45}px;height:${pitch}px;border-left:2px solid ${GL_LINE};border-bottom:2px solid ${GL_LINE};border-bottom-left-radius:${size * 0.3}px"></span>`));
    col.append(row);
    const at = i * 70, hidden = { opacity: i ? 0 : 0.7, transform: `translateX(${-u * 0.02}px)` };
    K(row, [[0, hidden], [at, hidden, EXPO], [at + 300, { opacity: 1, transform: "none" }]]);
  });
};

// The deck (a stack cascade): real-screen cards fanned in depth, the front one lit. Every step the next card comes to the
// front, the ones before it fall back to the left, the headline cuts to that card's line and the index ticks on.
PATTERNS["glow-deck"] = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), cards = s.cards ?? [], n = cards.length, step = Math.min(550, (s.d * 1000) / n), move = Math.min(420, step * 0.75);
  const g = glowBg(layer, W, H, [0.5, 0.8]);
  const spots = [[-0.24, 0.1], [0.22, -0.08], [-0.06, 0.18], [0.26, 0.14], [-0.18, -0.06]].map(([x, y]) => `translate(${W * x}px,${H * y}px)`);
  K(g, [[0, { transform: spots[0] }], ...cards.slice(1).flatMap((_, i) => SW((i + 1) * step, { transform: spots[i] }, { transform: spots[i + 1] }))]);
  // Headline and index, top left and top right, cut with the front card.
  const top = H * 0.09, size = Math.min(u * 0.085, (W * 0.56) / (0.55 * Math.max(...cards.map((c) => c.caption.length)))), mono = u * 0.032;
  cards.forEach((c, i) => {
    const head = h(`<div data-safe style="position:absolute;left:${W * 0.08}px;top:${top}px;font:700 ${size}px/1.05 var(--display);letter-spacing:-.03em;color:#fff;white-space:nowrap">${esc(c.caption)}</div>`);
    const num = h(`<div data-safe style="position:absolute;right:${W * 0.08}px;top:${top + (size - mono) / 2}px;font:500 ${mono}px/1 var(--mono);letter-spacing:.08em;color:#fff;white-space:pre">${String(i + 1).padStart(2, "0")}<span style="color:#7f93c8"> / ${String(n).padStart(2, "0")}</span></div>`);
    layer.append(head, num);
    const t0 = i * step, t1 = i === n - 1 ? s.d * 1000 + 1 : (i + 1) * step;
    WINDOW(head, t0, t1); WINDOW(num, t0, t1);
    K(head, [[t0, { transform: `translateY(${size * 0.18}px)` }, EXPO], [t0 + 300, { transform: "none" }]]);
  });
  // Card k places back from the front sits 0.36 card widths further out, scaled 0.84^k and turned toward the middle.
  const reach = 0.36 * (n - 1) + 0.5, cw = Math.min((W * 0.84) / (2 * reach), (H * 0.62) / 1.18), panel = cw, foot = cw * 0.18, ch = panel + foot;
  const cx = W / 2 - cw / 2, cy = H * 0.6 - ch / 2, deck = h(`<div style="position:absolute;inset:0;transform-origin:${W / 2}px ${H * 0.6}px"></div>`);
  // The whole deck pans left, the way it advances, and pushes in a little for the whole beat, so no step settles still;
  // the pan is what the 5% inset leaves beside the widest fan.
  const pan = Math.min(cw * 0.15, Math.max(0, W * 0.45 - reach * cw * 1.03) * 0.8);
  layer.append(deck);
  K(deck, [[0, { transform: `translateX(${pan}px) scale(1)` }], [s.d * 1000, { transform: `translateX(${-pan}px) scale(1.03)` }]]);
  const pose = (p, dy = 0) => {
    const k = Math.abs(p), lit = k === 0;
    return { transform: `perspective(${u * 1.8}px) translateY(${dy}px) translateX(${Math.sign(p) * cw * 0.36 * k}px) rotateY(${-Math.sign(p) * 18}deg) scale(${0.84 ** k})`,
      opacity: [1, 0.62, 0.34][k] ?? 0.18,
      boxShadow: `0 0 0 ${lit ? Math.max(2, u * 0.003) : Math.max(1, u * 0.0015)}px ${lit ? "#5aa0ff" : "#ffffff2e"},0 ${u * 0.03}px ${u * 0.1}px #000c,0 0 ${lit ? u * 0.12 : 0}px ${lit ? "#2f7bff99" : "#2f7bff00"}` };
  };
  cards.forEach((c, i) => {
    const scr = ctx.screen(c.screen), cap = Math.min(cw * 0.055, (cw * 0.72) / (0.55 * c.caption.length));
    const card = h(`<div data-safe="card ${i + 1}" style="position:absolute;left:${cx}px;top:${cy}px;width:${cw}px;height:${ch}px;border-radius:${u * 0.018}px;overflow:hidden;background:#0e111b"></div>`);
    card.append(h(`<div style="height:${panel}px;background:#ffffff;display:grid;place-items:center"><img src="${scr.url}" style="max-width:100%;max-height:100%;display:block"></div>`),
      h(`<div style="height:${foot}px;display:flex;align-items:center;justify-content:space-between;padding:0 ${cw * 0.06}px;color:#fff;font:600 ${cap}px/1 var(--body);white-space:nowrap"><span>${esc(c.caption)}</span><span style="font:500 ${cw * 0.04}px/1 var(--mono);color:#7f93c8">${String(i + 1).padStart(2, "0")}</span></div>`));
    deck.append(card);
    // Opens settling up into place, then moves one place left on each step; stacking switches as the step starts.
    K(card, [[0, pose(i, u * 0.03), EXPO], [Math.min(400, step * 0.7), pose(i)], ...cards.slice(1).flatMap((_, j) => [[(j + 1) * step, pose(i - j), EXPO], [(j + 1) * step + move, pose(i - j - 1)]])]);
    K(card, [[0, { zIndex: n - i }], ...cards.slice(1).flatMap((_, j) => SW((j + 1) * step, { zIndex: n - Math.abs(i - j) }, { zIndex: n - Math.abs(i - j - 1) }))]);
  });
};

// The real screen (or a tight crop of it, `zoom`) in a glowing window; the cursor arrives on the tapped control,
// presses, and the control lights up. `phone` floats a second real screen beside the window.
PATTERNS["glow-screen"] = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), d = s.d * 1000, scr = ctx.screen(s.screen), crop = STORYBOARD.storyboard.crops?.[s.screen];
  if (!crop) throw new Error(`glow-screen: ${s.screen} is not a crop`);
  glowBg(layer, W, H, s.zoom ? [0.5, 1.05] : [0.12, 0.15]);
  const phone = !s.zoom && s.phone ? ctx.screen(s.phone) : null, k = Math.min((W * (s.zoom ? 0.86 : 0.64)) / scr.width, (H * (s.zoom ? 0.8 : 0.72)) / scr.height);
  const w = scr.width * k, hh = scr.height * k, left = (W - w) / 2 - (phone ? W * 0.09 : 0), top = (H - hh) / 2;
  const win = h(`<div data-safe="window" style="position:absolute;left:${left}px;top:${top}px;width:${w}px;height:${hh}px;border-radius:${u * 0.018}px;overflow:hidden;box-shadow:0 0 0 ${Math.max(1, u * 0.002)}px #ffffff2e,0 ${u * 0.03}px ${u * 0.1}px #000c,0 0 ${u * 0.14}px ${glC("#1f6bff66")}"><img src="${scr.url}" style="width:100%;height:100%;display:block"></div>`);
  layer.append(win);
  K(win, [[0, { transform: s.zoom ? "scale(.95)" : "perspective(1800px) rotateX(9deg) rotateY(-11deg) scale(.92)" }, EXPO], [Math.min(650, d * 0.7), { transform: "none" }], [d, { transform: "scale(1.02)" }]]);
  if (phone) {
    const ph = H * 0.62, pw = ph * (phone.width / phone.height);
    const card = h(`<div data-safe="phone" style="position:absolute;left:${left + w - pw * 0.25}px;top:${(H - ph) / 2 + H * 0.05}px;width:${pw}px;height:${ph}px;border-radius:${u * 0.03}px;overflow:hidden;box-shadow:0 0 0 ${Math.max(1, u * 0.002)}px #ffffff38,0 ${u * 0.03}px ${u * 0.09}px #000c,0 0 ${u * 0.1}px ${glC("#1f6bff66")}"><img src="${phone.url}" style="width:100%;height:100%;display:block"></div>`);
    layer.append(card);
    K(card, [[0, { opacity: 0, transform: `translateY(${H * 0.08}px)` }, EXPO], [350, { opacity: 1, transform: "none" }]]);
  }
  // The tapped control, in the window's coordinates.
  const [tx, ty, tw, th] = s.tap, [cx0, cy0] = crop.rect, bx = (tx - cx0) * k, by = (ty - cy0) * k, bw = tw * k, bh = th * k, r = Math.min(bh * 0.4, u * 0.02);
  const lit = h(`<div style="position:absolute;left:${bx - u * 0.004}px;top:${by - u * 0.004}px;width:${bw + u * 0.008}px;height:${bh + u * 0.008}px;border-radius:${r}px;border:${Math.max(2, u * 0.004)}px solid ${glC("#cfe3ff")};box-shadow:0 0 ${u * 0.04}px ${u * 0.012}px ${glC("#4f9aff")},inset 0 0 ${u * 0.02}px ${glC("#8fc0ff88")}"></div>`);
  win.append(lit);
  const arrive = s.zoom ? d * 0.45 : d * 0.9, press = s.zoom ? d * 0.5 : d * 2;
  if (s.zoom) glLit(lit, press); else K(lit, [[0, { opacity: 0 }], [1, { opacity: 0 }]]);
  const pin = h(`<div data-moves style="position:absolute;left:${left + bx + bw * 0.8}px;top:${top + by + bh * 0.75}px;width:0;height:0"></div>`);
  pin.append(glCursor(u * (s.zoom ? 0.06 : 0.045))); layer.append(pin);
  glPress(pin, [W * 0.2, H * 0.28], arrive, press);
};
