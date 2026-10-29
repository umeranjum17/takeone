// Personalized welcome card (the `--data` batch's template beat): one card per spreadsheet row, so every field is a
// row's value. An accent panel carrying the company's initial (`logo`) beside a mono eyebrow (`label`), the person's
// name in the display face (`title`), a line (`subtitle`), a plan pill (`cta`) and a checklist (`tree`) whose boxes
// tick one after another. The accent is the theme's, so a row's brand colour is `theme.overrides.accent`. Text is
// fitted to its column by measuring the bundled face, so the longest name in a batch still sits on one line.
// Timings mirror sceneHolds in storyboard.ts. Shares EXPO and BACK with editorial.js (one page scope, loaded before this file).
window.WELCOME_ROW_MS = 700;
PATTERNS.welcome = (layer, s, ctx) => {
  const { W, H } = ctx, u = Math.min(W, H), wide = W >= H * 1.2, accent = ctx.tokens.accent;
  const cw = wide ? Math.min(W * 0.72, H * 1.32) : W * 0.8, ch = wide ? cw * 0.54 : Math.min(H * 0.86, cw * 1.45);
  const pw = wide ? cw * 0.3 : cw, ph = wide ? ch : ch * 0.34, pad = u * 0.045, colW = (wide ? cw - pw : cw) - 2 * pad;
  // Readable ink on the panel: dark on a light brand colour, white on a dark one.
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const onAccent = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? "#0b0b0b" : "#ffffff";
  const root = getComputedStyle(document.documentElement), face = (v) => root.getPropertyValue(v).trim();
  // The largest size up to max at which text (tracked by ls em a character) fits width, measured in the bundled face.
  const fit = (text, family, weight, max, width, ls = 0) => {
    const c = (fit.c ??= document.createElement("canvas").getContext("2d"));
    c.font = `${weight} ${max}px ${family}`;
    return Math.min(max, (max * width) / Math.max(1, c.measureText(text).width + ls * max * [...text].length));
  };
  const rows = s.tree ?? [], initial = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s.logo ?? "")][0]?.segment.toUpperCase() ?? "";
  const card = h(`<div style="position:absolute;left:${(W - cw) / 2}px;top:${(H - ch) / 2}px;width:${cw}px;height:${ch}px;border-radius:${u * 0.02}px;background:var(--card);border:1px solid var(--line);box-shadow:0 ${u * 0.02}px ${u * 0.06}px #0000001f"></div>`);
  const radius = wide ? `${u * 0.02}px 0 0 ${u * 0.02}px` : `${u * 0.02}px ${u * 0.02}px 0 0`;
  const fill = h(`<div style="position:absolute;left:0;top:0;width:${pw}px;height:${ph}px;border-radius:${radius};background:${accent}"></div>`);
  const big = fit(initial, face("--display"), 400, ph * 0.55, pw * 0.6);
  const mark = h(`<div style="position:absolute;left:0;top:0;width:${pw}px;height:${ph}px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${u * 0.012 + big * 0.12}px;color:${onAccent}">
    <div data-safe style="font:400 ${big}px/1 var(--display)">${esc(initial)}</div>
    <div data-safe style="max-width:${pw * 0.8}px;font:${Math.max(u * 0.015, fit((s.logo ?? "").toUpperCase(), face("--mono"), 400, u * 0.022, pw * 0.7, 0.18))}px/1.4 var(--mono);letter-spacing:.18em;text-transform:uppercase;text-align:center;text-wrap:balance;opacity:.9">${esc(s.logo ?? "")}</div></div>`);
  const col = h(`<div style="position:absolute;left:${wide ? pw + pad : pad}px;top:${wide ? 0 : ph}px;width:${colW}px;height:${wide ? ch : ch - ph}px;display:flex;flex-direction:column;justify-content:center"></div>`);
  const stack = h(`<div style="display:flex;flex-direction:column;gap:${u * 0.018}px;transform-origin:left center"></div>`);
  const eyebrow = s.label ? h(`<div data-safe style="display:flex;align-items:center;gap:.7em;font:${fit((s.label ?? "").toUpperCase(), face("--mono"), 400, u * 0.022, colW - u * 0.03, 0.14)}px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)"><i style="width:.6em;height:.6em;border-radius:50%;background:${accent}"></i>${esc(s.label)}</div>`) : null;
  const name = h(`<div data-safe style="font:400 ${fit(s.title ?? "", face("--display"), 400, u * 0.12, colW)}px/1.05 var(--display);letter-spacing:-.015em;color:var(--ink);white-space:nowrap">${wordSpans(s.title, "welcome-word")}</div>`);
  const line = s.subtitle ? h(`<div data-safe style="font:${u * 0.032}px/1.35 var(--body);color:var(--muted);text-wrap:balance">${esc(s.subtitle)}</div>`) : null;
  const pill = s.cta ? h(`<div data-safe style="align-self:flex-start;margin-top:${u * 0.004}px;padding:.55em 1.1em;border:2px solid ${accent};border-radius:999px;font:600 ${u * 0.02}px/1 var(--body);letter-spacing:.12em;text-transform:uppercase;color:${onAccent === "#ffffff" ? accent : "var(--ink)"}">${esc(s.cta)}</div>`) : null;
  const rowSize = Math.min(u * 0.029, ...rows.map((t) => fit(t, face("--body"), 400, u * 0.029, colW - u * 0.06)));
  const list = rows.length ? h(`<div style="display:flex;flex-direction:column;gap:${u * 0.012}px;margin-top:${u * 0.012}px"></div>`) : null;
  const items = rows.map((t) => {
    const box = h(`<div style="position:relative;flex:none;width:${rowSize * 1.15}px;height:${rowSize * 1.15}px;border-radius:${rowSize * 0.28}px;border:2px solid var(--line)"></div>`);
    const tickFill = h(`<div style="position:absolute;inset:-2px;border-radius:inherit;background:${accent}"></div>`);
    const tickMark = h(`<svg viewBox="0 0 24 24" style="position:absolute;inset:0;width:100%;height:100%"><path d="M6 12.5 L10.2 16.5 L18 8" fill="none" stroke="${onAccent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/></svg>`);
    box.append(tickFill, tickMark);
    const row = h(`<div style="display:flex;align-items:center;gap:${rowSize * 0.7}px"></div>`);
    const text = h(`<div data-safe style="font:${rowSize}px/1.2 var(--body);color:var(--ink);white-space:nowrap">${esc(t)}</div>`);
    row.append(box, text); list.append(row);
    return { row, tickFill, path: tickMark.querySelector("path") };
  });
  stack.append(...[eyebrow, name, line, pill, list].filter(Boolean));
  col.append(stack); card.append(fill, mark, col); layer.append(card);
  // A long line or a squarer frame can make the copy taller than its side of the card: scale it down to fit, never past it.
  const room = col.clientHeight - 2 * pad;
  if (stack.offsetHeight > room) stack.style.transform = `scale(${(room / stack.offsetHeight).toFixed(4)})`;
  // The card and its panel are whole from the first frame (a cut point), the initial already rising, and the card settles.
  K(card, [[0, { transform: "scale(.97)" }, EXPO], [600, { transform: "none" }], [s.d * 1000, { transform: "scale(1.025)" }]]);
  riseIn(mark.children[0], 0); riseIn(mark.children[1], 150);
  if (eyebrow) riseIn(eyebrow, 150);
  $$(".welcome-word", name).forEach((w, i) => riseIn(w, 250 + i * 60));
  if (line) riseIn(line, 600);
  if (pill) K(pill, [[0, { opacity: 0, transform: "scale(.8)" }], [850, { opacity: 0, transform: "scale(.8)" }, BACK], [1250, { opacity: 1, transform: "none" }]]);
  // Checklist: a row every WELCOME_ROW_MS from 1.3 s, its box filling and its tick drawing 350 ms after it lands.
  items.forEach(({ row, tickFill, path }, i) => {
    const at = 1300 + i * WELCOME_ROW_MS;
    K(row, [[0, { opacity: 0, transform: "translateY(40%)" }], [at, { opacity: 0, transform: "translateY(40%)" }, EXPO], [at + 300, { opacity: 1, transform: "none" }]]);
    K(tickFill, [[0, { opacity: 0, transform: "scale(.4)" }], [at + 350, { opacity: 0, transform: "scale(.4)" }, BACK], [at + 550, { opacity: 1, transform: "none" }]]);
    K(path, [[0, { strokeDashoffset: 1 }], [at + 400, { strokeDashoffset: 1 }, EXPO], [at + 550, { strokeDashoffset: 0 }]]);
  });
};
