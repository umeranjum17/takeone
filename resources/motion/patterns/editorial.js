// Editorial launch-film beats (the `--recipe editorial` grammar): a serif hook whose last word is struck and
// swapped, the real screen large on a phone with a tap and a toast, a stack of the screen's own UI lines, and a
// canon that replays those beats in four tiles on shifted clocks. Expo-out for entrances, cubic in-out for pans,
// one accent (the colour sampled from the screen). Timings mirror sceneHolds in storyboard.ts.
const EXPO = "cubic-bezier(.16,1,.3,1)", INOUT = "cubic-bezier(.65,0,.35,1)", BACK = "cubic-bezier(.34,1.45,.64,1)";
const ACCENT = "var(--design-accent, var(--text))";
window.SWAP_MS = 900;
const riseWords = (text) => text.split(/\s+/).filter(Boolean).map((w) => `<span style="display:inline-block;overflow:hidden;vertical-align:bottom;padding-bottom:.08em"><span class="ed-word" style="display:inline-block">${esc(w)}</span></span>`).join(" ");
const rise = (root, at = 0) => $$(".ed-word", root).forEach((w, i) => K(w, [[at + i * 70, { transform: "translateY(110%)" }, EXPO], [at + 420 + i * 70, { transform: "none" }]]));
// The serif line set beside a device or stack: left column, sized so its longest word fits.
const sideCopy = (layer, text, ctx) => {
  const { W, H } = ctx, longest = Math.max(...text.split(/\s+/).map((w) => w.length));
  const size = Math.min(H * 0.1, (W * 0.38) / (0.48 * longest));
  const el = h(`<div data-safe style="position:absolute;left:${W * 0.08}px;width:${W * 0.4}px;top:50%;transform:translateY(-50%);font:${size}px/1.06 var(--display);letter-spacing:-.015em;color:var(--text);text-wrap:balance">${riseWords(text)}</div>`);
  layer.append(el); rise(el);
};
const cursorSvg = (size) => h(`<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="position:absolute;left:0;top:0;overflow:visible"><path d="M3 2 L3 19 L8 14.5 L11.5 22 L14.5 20.6 L11 13.4 L17.5 13.4 Z" fill="#0b0b0b" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/></svg>`);

PATTERNS["word-swap"] = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), swaps = s.swaps ?? [], lead = s.title ?? "";
  const chars = Math.max(lead.length, ...swaps.map((w) => w.length));
  const size = Math.min(u * 0.15, (W * 0.84) / (0.46 * chars));
  const group = h(`<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font:${size}px/1.08 var(--display);letter-spacing:-.02em;color:var(--text);text-align:center"></div>`);
  const line1 = h(`<div data-safe>${riseWords(lead)}</div>`);
  const slot = h(`<div style="display:grid;justify-items:center;margin-top:.04em"></div>`);
  group.append(line1, slot); layer.append(group); rise(line1);
  swaps.forEach((word, k) => {
    const at = 600 + k * SWAP_MS, last = k === swaps.length - 1;
    const w = h(`<span data-safe style="grid-area:1/1;position:relative;padding:0 .1em;color:${last ? "var(--text)" : "var(--muted)"}">${esc(word)}</span>`);
    slot.append(w);
    const shown = { opacity: 1, transform: "none" };
    K(w, [[0, { opacity: 0, transform: "translateY(45%)" }], [at, { opacity: 0, transform: "translateY(45%)" }, EXPO], [at + 380, shown],
      ...(last ? [] : [[at + 800, shown, "ease-in"], [at + 950, { opacity: 0, transform: "translateY(-35%)" }]])]);
    if (!last) {
      const strike = h(`<div style="position:absolute;left:.05em;right:.05em;top:56%;height:.055em;background:var(--text);transform-origin:left center"></div>`);
      w.append(strike);
      K(strike, [[0, { transform: "scaleX(0)" }], [at + 420, { transform: "scaleX(0)" }, INOUT], [at + 640, { transform: "scaleX(1)" }]]);
      return;
    }
    // The settled word is selected: an accent box with corner handles pops, and a cursor flies onto its corner.
    const box = h(`<div style="position:absolute;inset:-.02em -.04em;border:${Math.max(2, u * 0.003)}px solid ${ACCENT}"></div>`);
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) box.append(h(`<div style="position:absolute;left:${x * 100}%;top:${y * 100}%;width:${u * 0.012}px;height:${u * 0.012}px;transform:translate(-50%,-50%);background:var(--bg);border:${Math.max(2, u * 0.003)}px solid ${ACCENT}"></div>`));
    w.append(box);
    K(box, [[0, { opacity: 0, transform: "scale(.3)" }], [at + 380, { opacity: 0, transform: "scale(.3)" }, EXPO], [at + 560, { opacity: 1, transform: "none" }]]);
    const cur = cursorSvg(u * 0.06);
    const pin = h(`<div data-moves style="position:absolute;right:-.02em;bottom:-.02em;width:0;height:0"></div>`);
    pin.append(cur); w.append(pin);
    K(pin, [[0, { opacity: 0, transform: `translate(${W * 0.25}px,${H * 0.3}px)` }], [at + 400, { opacity: 0, transform: `translate(${W * 0.25}px,${H * 0.3}px)` }, EXPO],
      [at + 900, { opacity: 1, transform: "none" }]]);
  });
  K(group, [[0, { transform: "scale(1)" }], [s.d * 1000, { transform: "scale(1.04)" }]]);
};

PATTERNS["phone-story"] = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), scr = ctx.screen(s.screen), crop = STORYBOARD.storyboard.crops?.[s.screen];
  if (!crop) throw new Error(`phone-story: ${s.screen} is not a crop`);
  if (s.title) sideCopy(layer, s.title, ctx);
  const pw = H * 0.52, bez = pw * 0.04, iw = pw - 2 * bez, k = iw / scr.width, ih = scr.height * k, top = H * 0.1, cx = W * 0.68;
  const phone = h(`<div data-moves style="position:absolute;left:${cx - pw / 2}px;top:${top}px;width:${pw}px;height:${H * 1.3}px;border-radius:${pw * 0.15}px;background:var(--text)"></div>`);
  const view = h(`<div style="position:absolute;left:${bez}px;top:${bez}px;right:${bez}px;bottom:${bez}px;border-radius:${pw * 0.12}px;overflow:hidden;background:#ffffff"></div>`);
  const img = h(`<img src="${scr.url}" style="position:absolute;left:0;top:0;width:${iw}px;height:${ih}px;display:block">`);
  view.append(img); phone.append(view);
  phone.append(h(`<div style="position:absolute;left:50%;top:${bez + pw * 0.03}px;width:${pw * 0.28}px;height:${pw * 0.075}px;transform:translateX(-50%);border-radius:999px;background:#0b0b0b"></div>`));
  layer.append(phone);
  // Pan so the tapped control settles at 58% of the frame, never past the end of the screen.
  const [tx, ty, tw, th] = s.tap, [cx0, cy0] = crop.rect;
  const tapX = (tx + tw / 2 - cx0) * k, tapY = (ty + th / 2 - cy0) * k;
  const pan = Math.max(0, Math.min(ih - (H - top - bez), top + bez + tapY - H * 0.58));
  K(phone, [[0, { transform: `translateY(${H}px)` }, EXPO], [600, { transform: "none" }]]);
  K(img, [[0, { transform: "none" }], [900, { transform: "none" }, INOUT], [2100, { transform: `translateY(${-pan}px)` }]]);
  // The tap: an accent outline on the real control, a press ring, and the cursor dipping.
  const tapBox = h(`<div style="position:absolute;left:${(tx - cx0) * k - u * 0.008}px;top:${(ty - cy0) * k - pan - u * 0.008}px;width:${tw * k + u * 0.016}px;height:${th * k + u * 0.016}px;border:${Math.max(2, u * 0.004)}px solid ${ACCENT};border-radius:${u * 0.012}px"></div>`);
  const ring = h(`<div style="position:absolute;left:${tapX}px;top:${tapY - pan}px;width:${u * 0.12}px;height:${u * 0.12}px;margin:${-u * 0.06}px;border-radius:50%;border:${Math.max(2, u * 0.004)}px solid ${ACCENT}"></div>`);
  view.append(tapBox, ring);
  K(tapBox, [[0, { opacity: 0 }], ...SW(2650, { opacity: 0 }, { opacity: 1 })]);
  K(ring, [[0, { opacity: 0, transform: "scale(.2)" }], ...SW(2650, { opacity: 0, transform: "scale(.2)" }, { opacity: 1, transform: "scale(.2)" }), [2650, { opacity: 1, transform: "scale(.2)" }, EXPO], [3050, { opacity: 0, transform: "scale(1)" }]]);
  // The cursor tip lands on the control's lower right, so its label stays readable under the press.
  const cur = cursorSvg(u * 0.05), pin = h(`<div data-moves style="position:absolute;left:${bez + (tx - cx0 + tw * 0.85) * k}px;top:${bez + (ty - cy0 + th * 0.8) * k - pan}px;width:0;height:0"></div>`);
  pin.append(cur); phone.append(pin);
  K(pin, [[0, { opacity: 0, transform: `translate(${pw * 0.9}px,${H * 0.35}px)` }], [2100, { opacity: 0, transform: `translate(${pw * 0.9}px,${H * 0.35}px)` }, EXPO],
    [2600, { opacity: 1, transform: "none" }], [2650, { opacity: 1, transform: "scale(.88)" }], [2800, { opacity: 1, transform: "none" }]]);
  // The confirmation springs down from the top of the screen and stays.
  if (s.text) {
    const toast = h(`<div style="position:absolute;left:50%;top:${bez + pw * 0.14}px;display:flex;align-items:center;gap:${u * 0.012}px;white-space:nowrap;padding:${u * 0.016}px ${u * 0.026}px;border-radius:999px;background:#0b0b0b;color:#ffffff;font:500 ${u * 0.028}px/1 var(--body);box-shadow:0 ${u * 0.01}px ${u * 0.03}px #0006"><span style="width:${u * 0.016}px;height:${u * 0.016}px;border-radius:50%;background:${ACCENT}"></span>${esc(s.text)}</div>`);
    phone.append(toast);
    K(toast, [[0, { opacity: 0, transform: "translate(-50%,-160%) scale(.9)" }], [2900, { opacity: 0, transform: "translate(-50%,-160%) scale(.9)" }, BACK], [3320, { opacity: 1, transform: "translate(-50%,0) scale(1)" }]]);
  }
};

PATTERNS["chip-stack"] = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), ids = s.chips ?? [], cx = W * (s.title ? 0.68 : 0.5), pitch = H * 0.118, ch = H * 0.085;
  if (s.title) sideCopy(layer, s.title, ctx);
  // Radial field lines behind the stack, SVG only (no CSS gradients on motion pages).
  const rays = Array.from({ length: 36 }, (_, i) => { const a = (i / 36) * Math.PI * 2; return `<line x1="${cx}" y1="${H / 2}" x2="${cx + Math.cos(a) * W}" y2="${H / 2 + Math.sin(a) * W}"/>`; }).join("");
  const field = h(`<svg width="${W}" height="${H}" style="position:absolute;left:0;top:0" stroke="var(--line)" stroke-width="${Math.max(1, u * 0.0014)}">${rays}</svg>`);
  const col = h(`<div data-moves style="position:absolute;left:${cx}px;top:0;width:0;height:0"></div>`);
  layer.append(field, col);
  const at = (i) => 250 + i * 500, y = (i) => H / 2 - (i * pitch) / 2; // the stack stays centred as it grows
  ids.forEach((id, i) => {
    const scr = ctx.screen(id), k = Math.min(ch / scr.height, (2 * H) / 1080, (W * (s.title ? 0.34 : 0.6)) / scr.width), w = scr.width * k, hh = scr.height * k;
    const chip = h(`<div style="position:absolute;left:${-w / 2}px;top:${i * pitch - hh / 2}px;width:${w}px;height:${hh}px;border-radius:${Math.min(hh / 2, u * 0.008)}px;box-shadow:0 0 0 ${Math.max(1.5, u * 0.0016)}px var(--text),0 ${u * 0.008}px ${u * 0.02}px #0002"><img src="${scr.url}" style="width:100%;height:100%;display:block;border-radius:inherit"></div>`);
    const ring = h(`<div style="position:absolute;inset:${-u * 0.009}px;border:${Math.max(2, u * 0.004)}px solid ${ACCENT};border-radius:${Math.min(hh / 2, u * 0.008) + u * 0.009}px"></div>`);
    chip.append(ring); col.append(chip);
    const last = i === ids.length - 1, hidden = { opacity: 0, transform: "translateY(45%) scale(.9)" }, active = { opacity: 1, transform: "scale(1.05)" };
    K(chip, [[0, hidden], [at(i), hidden, EXPO], [at(i) + 420, active], ...(last ? [] : [[at(i + 1), active, EXPO], [at(i + 1) + 300, { opacity: 1, transform: "none" }]])]);
    WINDOW(ring, at(i) + 120, last ? s.d * 1000 : at(i + 1));
  });
  // Each new row lifts the stack half a row, so the whole stack stays centred and inside the frame.
  K(col, [[0, { transform: `translateY(${y(0)}px)` }], ...ids.slice(1).flatMap((_, j) => [[at(j + 1), { transform: `translateY(${y(j)}px)` }, EXPO], [at(j + 1) + 420, { transform: `translateY(${y(j + 1)}px)` }]])]);
};

PATTERNS.canon = (layer, s, ctx) => {
  const { W, H } = ctx, t = ctx.tokens, sx = W / 1920, sy = H / 1080, mx = t.margin_x * sx, my = t.margin_y * sy, gx = t.gutter_x * sx, gy = t.gutter_y * sy;
  const w = (W - 2 * mx - gx) / 2, hh = (H - 2 * my - gy) / 2, base = BASE;
  layer.style.background = "var(--page)";
  // The tile layers' own visibility windows override this layer's hidden state, so the canon also holds
  // opacity 0 outside its window on the page clock: nothing in a tile paints outside the canon beat.
  BASE = 0;
  K(layer, [[0, { opacity: 0 }], ...SW(base, { opacity: 0 }, { opacity: 1 }), ...SW(base + s.d * 1000, { opacity: 1 }, { opacity: 0 })]);
  BASE = base;
  const master = STORYBOARD.storyboard.scenes.filter((x) => x.pattern !== "canon" && x.pattern !== "clip" && x.at + x.d <= s.at + 1e-6);
  [[mx, my], [mx + w + gx, my], [mx, my + hh + gy], [mx + w + gx, my + hh + gy]].forEach(([x, y], i) => {
    const tile = h(`<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${hh}px;overflow:hidden;border-radius:var(--radius);background:var(--bg)"></div>`);
    const root = h(`<div style="position:absolute;width:${w}px;height:${hh}px;overflow:hidden"></div>`);
    tile.append(root); layer.append(tile);
    // Tile i reads master time offsets[i] at the canon's first frame: its scenes sit on the page clock at at - offset.
    mountScenes(root, master, w, hh, (s.at - s.offsets[i]) * 1000, `canon${i}:`);
    BASE = base;
    // Tile layers keep their own WAAPI windows; drop the film-time clip marks a timeline engine would read.
    // Tile copy sits inside the tile's own margin, not the frame's 5% inset the safe-area gate measures.
    for (const l of $$("[data-start]", root)) { l.removeAttribute("data-start"); l.removeAttribute("data-duration"); l.removeAttribute("data-track-index"); }
    for (const l of $$("[data-safe]", root)) l.removeAttribute("data-safe");
    K(tile, [[0, { transform: "scale(.94)", opacity: 0 }], [i * 70, { transform: "scale(.94)", opacity: 0 }, EXPO], [i * 70 + 380, { transform: "none", opacity: 1 }]]);
  });
};
