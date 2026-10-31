// Story beat (`--recipe story`): copy on one side and the product drawn on the other from the brief's own words, so a film needs
// no screenshot. `kind` picks the surface (chips, phone, cards, stats); `tree` holds its rows. Dark and light beats alternate
// through `invert`. Entrances are K keys, the drift and the counters are ticks: every frame is a pure function of the clock.
// Layout: a landscape frame sets copy left and product right. A portrait or square frame (W <= H) stacks them instead. One rule places
// every block: the headline is balanced and fitted to the top 27% (10% side margins, room for the push-in between beats); the product
// gets the region `R` that is left between the headline's measured bottom and the 93% line, less a 4% breath at each end; each surface fills R and is
// centred in it, so the space above and below it is the same and no beat hangs from a hand-set offset.
(() => {
const EXPO = "cubic-bezier(.16,1,.3,1)", mix = (a, p, b) => `color-mix(in srgb, ${a} ${p}%, ${b})`, accentInk = mix("var(--accent)", 62, "var(--text)");
const rise = (el, at, from) => K(el, [[at, { opacity: 0, transform: from }, EXPO], [at + 650, { opacity: 1, transform: "none" }]]);

// Spreadsheet surfaces (sheet, fill, grid): `tree` is a CSV's header and its first rows (cells joined by " | "), `note` its file name, `text` its row count.
// A hex cell is the row's accent; the other cells are, in order, the name, the company and the plan. Only a #rrggbb cell reaches a style attribute.
const HEX = /^#[0-9a-f]{6}$/i, padTo = (n, total) => String(n).padStart(String(total).length, "0");
const sheetOf = (s) => {
  const [head, ...body] = s.tree.map((r) => r.split(" | ")), hx = head.findIndex((_, c) => body.every((r) => HEX.test(r[c] ?? "")));
  const rows = body.map((r) => { const [name = "", company = "", plan = ""] = r.filter((_, c) => c !== hx); return { cells: r, name, company, plan, color: hx >= 0 ? r[hx] : "var(--accent)" }; });
  return { head, hx, rows, total: Number(s.text) || rows.length };
};
const onColor = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255 || 0).map((c) => (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)); return .2126 * r + .7152 * g + .0722 * b > .45 ? "#0b0b0b" : "#ffffff"; };
const initial = (t) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(t)][0]?.segment.toUpperCase() ?? "";
// The terminal line every spreadsheet beat ends on: `say(command, counter)` rewrites it; P is the region left above it.
// Beside the headline on a landscape frame, under it on a stacked one. The surface is 7% narrower than R: the scene's push-in scales it up at the cut and the bar must still clear the 5% inset.
const prompt = (layer, { U, R: full, stack, W, H }) => {
  const wide = stack ? full : { x: W * .5, y: H * .1, w: W * .43, h: H * .8 }, R = { ...wide, x: wide.x + wide.w * .035, w: wide.w * .93 }, bh = U * .06, bar = h(`<div data-safe style="position:absolute;left:${R.x}px;top:${R.y + R.h - bh}px;width:${R.w}px;height:${bh}px;box-sizing:border-box;padding:0 ${U * .024}px;border-radius:${U * .014}px;background:var(--ink);color:var(--card);display:flex;align-items:center;justify-content:space-between;gap:${U * .02}px;font:${U * .022}px var(--mono);white-space:nowrap"><span style="overflow:hidden"><b style="color:var(--accent)">$</b> <i style="font-style:normal"></i></span><span style="opacity:.7"></span></div>`);
  layer.append(bar); rise(bar, 200, `translateY(${U * .02}px)`);
  const [line, count] = [bar.firstElementChild.lastElementChild, bar.lastElementChild];
  return { say: (a, b) => { line.textContent = a; count.textContent = b; }, P: { ...R, h: R.h - bh - U * .025 } };
};
const SURFACE = {
  chips: (layer, s, { W, H, U, R, stack }) => (s.tree ?? []).forEach((t, i, all) => {
    const [x, y] = [[.05, .12], [.52, .07], [.74, .17], [.03, .72], [.3, .87], [.58, .82], [.76, .68], [.28, .2]][i];
    // stacked: one chip per row of R, each at its own x, sized from its text so it stays inside the margin
    const bh = Math.min(R.h, all.length * U * .17), f = stack ? Math.min(1, bh / all.length * .78 / (U * .0988)) : 1, fs = stack ? U * .034 * f : H * .024, pad = stack ? U * .026 * f : H * .014, padX = stack ? U * .047 * f : H * .026, w = Math.min(R.w, [...t].length * fs * .62 + 2 * padX);
    const at = stack ? `left:${R.x + [.05, .62, .2, .7, .1, .5, .3, .66][i] * (R.w - w)}px;top:${R.y + (R.h - bh) / 2 + (i + .5) * bh / all.length - (fs * 1.2 + 2 * pad) / 2}px` : `left:${x * 100}%;top:${y * 100}%`;
    const chip = h(`<div style="position:absolute;${at};padding:${pad}px ${padX}px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--ink);font:${fs}px var(--body);white-space:nowrap">${esc(t)}</div>`);
    layer.append(chip); rise(chip, 300 + i * 140, `translateY(${U * .03}px)`);
    tick((ms) => { const a = ms / 2600 + i; chip.style.translate = `${(Math.sin(a * 2) * W * .004).toFixed(2)}px ${(Math.cos(a * 1.7) * U * .008).toFixed(2)}px`; });
  }),
  phone: (layer, s, { H, R, stack }) => {
    // P is the unit the phone is drawn in: H on a landscape frame, and pw / .42 when stacked, so the drawing keeps its proportions at any width
    const [ask, ...answer] = s.tree, pw = stack ? Math.min(R.w * .72, R.h * .65) : H * .42, ph = stack ? Math.min(R.h * .97, pw * 1.55) : H * .8, P = pw / .42, sz = P * .026, typed = 700 + 35 * ask.length;
    const bubble = (bg, x) => `max-width:82%;align-self:${x};padding:${P * .016}px ${P * .02}px;border-radius:${P * .026}px;background:${bg};color:var(--ink);font:${sz}px/1.3 var(--body)`;
    const phone = h(`<div style="position:absolute;${stack ? `left:${R.x + (R.w - pw) / 2}px;top:${R.y + (R.h - ph) / 2}px` : `right:9%;top:${(H - ph) / 2}px`};width:${pw}px;height:${ph}px;box-sizing:border-box;border-radius:${P * .05}px;border:2px solid var(--line);background:var(--card);overflow:hidden;display:flex;flex-direction:column;gap:${P * .018}px;padding:${P * .03}px ${P * .022}px;box-shadow:0 ${P * .04}px ${P * .1}px rgba(0,0,0,.35)">
      <div style="display:flex;align-items:center;gap:${P * .014}px;color:var(--ink);font:${sz}px var(--display)"><i style="width:${P * .04}px;height:${P * .04}px;border-radius:50%;background:var(--accent)"></i>${esc(s.text ?? "")}</div>
      <div id="ask" style="${bubble(mix("var(--accent)", 35, "var(--card)"), "flex-end")};opacity:0"><span></span><span style="visibility:hidden"></span></div>
      <div id="answer" style="${bubble(mix("var(--ink)", 9, "var(--card)"), "flex-start")};display:flex;flex-direction:column;gap:${P * .008}px">${answer.map((t) => `<div style="opacity:0">${esc(t)}</div>`).join("")}</div>
      <div style="margin-top:auto;height:${P * .05}px;border-radius:999px;border:1px solid var(--line)"></div></div>`);
    layer.append(phone); rise(phone, 100, `translateY(${P * .06}px) scale(.96)`);
    const [bubbleAsk, answerBox] = [$("#ask", phone), $("#answer", phone)], [seen, rest] = $$("span", bubbleAsk);
    answerBox.style.opacity = "0"; K(answerBox, [[typed + 450, { opacity: 0 }], [typed + 750, { opacity: 1 }]]);
    $$("#answer > div", phone).forEach((line, i) => K(line, [[typed + 500 + 450 * i, { opacity: 0 }, SMOOTH], [typed + 900 + 450 * i, { opacity: 1 }]]));
    tick((ms) => { const n = Math.max(0, Math.min(ask.length, Math.floor((ms - 700) / 35))); bubbleAsk.style.opacity = ms >= 700 - 35 ? "1" : "0"; seen.textContent = ask.slice(0, n); rest.textContent = ask.slice(n); });
  },
  cards: (layer, s, { H, R, cx, stack }) => {
    // Q is the unit the cards are drawn in: H on a landscape frame, cw / .3 when stacked, where the cards cascade (each title in its own band, so it reads whole)
    const rows = s.tree, cw = stack ? Math.min(R.w * .6, R.h * .97 / (1.3 + .35 * (rows.length - 1))) : H * .3, ch = cw * 1.3, Q = cw / .3;
    rows.forEach((t, i) => {
      const f = i - (rows.length - 1) / 2, to = stack ? `translate(${f * cw * .14}px,${f * cw * .35}px) rotate(${f * 3.5}deg)` : `translate(${f * cw * .56}px,${Math.abs(f) * Q * .02}px) rotate(${f * 7}deg)`;
      const card = h(`<div style="position:absolute;left:${cx - cw / 2}px;top:${(stack ? R.y + R.h / 2 : H / 2) - ch / 2}px;width:${cw}px;height:${ch}px;box-sizing:border-box;padding:${Q * .026}px;border-radius:${Q * .014}px;background:var(--text);color:var(--bg);box-shadow:0 ${Q * .02}px ${Q * .05}px rgba(0,0,0,.3);display:flex;flex-direction:column;gap:${Q * .018}px">
        <div style="font:${Q * .024}px/1.1 var(--display)">${esc(t)}</div>${[100, 86, 92, 58].map((w) => `<i style="height:${Q * .011}px;width:${w}%;border-radius:9px;background:${mix("var(--bg)", 16, "transparent")}"></i>`).join("")}
        <i style="margin-top:auto;height:${Q * .045}px;border-radius:${Q * .01}px;background:var(--accent)"></i></div>`);
      layer.append(card);
      K(card, [[300 + i * 160, { opacity: 0, transform: `translateY(${Q * .2}px)` }, EXPO], [1000 + i * 160, { opacity: 1, transform: to }]]);
    });
  },
  // Layout rule every surface follows: the product group is centred on the frame's own midline by its real extent (rows x height),
  // never hung from a fixed slot, and the figures in one group share a size, so a short row and a long one balance.
  stats: (layer, s, { W, H, R, cx, stack }) => {
    // S is the unit the tiles are drawn in: H on a landscape frame, th / .27 when stacked (two tiles per row across R's width)
    const rows = s.tree, n = Math.ceil(rows.length / 2), gap = (stack ? R.w : H) * (stack ? .035 : .03), tw = stack ? (R.w - gap) / 2 : W * .19, th = stack ? Math.min(tw * (n > 1 ? 1.05 : 1.4), (R.h - gap * (n - 1)) / n) : H * .27, S = th / .27;
    const top0 = (stack ? R.y + R.h / 2 : H / 2) - (n * th + (n - 1) * gap) / 2;
    const parsed = rows.map((t) => {
      const m = /^(\D*?)(\d[\d,]*)(\+?)\s+(.*)$/.exec(t) ?? [, "", "0", "", t], value = Number(m[2].replace(/,/g, ""));
      return { pre: m[1], value, post: m[3], label: m[4], em: [...m[1] + value.toLocaleString("en-US") + m[3]].reduce((n, c) => n + (/\d/.test(c) ? .68 : c === "+" ? .6 : .34), 0) };
    });
    const fit = Math.min(1, ...parsed.map((p) => (tw - S * .06) / (p.em * S * .11))); // the longest figure sets the size, so none runs under the next tile
    parsed.forEach((p, i) => {
      const last = i === rows.length - 1;
      const tile = h(`<div style="position:absolute;left:${cx - tw - gap / 2 + (i % 2) * (tw + gap)}px;top:${top0 + Math.floor(i / 2) * (th + gap)}px;width:${tw}px;height:${th}px;box-sizing:border-box;padding:${S * .03}px;border-radius:${S * .022}px;border:${last ? 3 : 1}px solid ${last ? "var(--accent)" : "var(--line)"};background:var(--card);color:var(--ink);display:flex;flex-direction:column;justify-content:center;gap:${S * .012}px;${last ? `box-shadow:0 0 ${S * .06}px ${mix("var(--accent)", 35, "transparent")}` : ""}">
        <div style="font:${S * .11 * fit}px/1 var(--display);letter-spacing:-.03em;white-space:nowrap"></div><div style="font:${S * .026}px var(--body);color:${mix("var(--ink)", 70, "var(--card)")}">${esc(p.label)}</div></div>`);
      layer.append(tile); rise(tile, 300 + i * 220, `translateY(${S * .04}px)`);
      const num = tile.firstElementChild, t0 = 400 + i * 220;
      tick((ms) => { num.textContent = p.pre + Math.round(p.value * smootherstep((ms - t0) / 1300)).toLocaleString("en-US") + p.post; });
    });
  },
  // sheet: the CSV as a table, its rows rising a step apart, the first row ringed.
  sheet: (layer, s, ctx) => {
    const { U } = ctx, { say, P } = prompt(layer, ctx), { head, hx, rows, total } = sheetOf(s), fs = U * .024, pillCol = head.map((_, c) => c).filter((c) => c !== hx)[2];
    const cols = ["1.3fr", "1.2fr", ".8fr", "1fr"].slice(0, head.length).join(" "), line = `display:grid;grid-template-columns:${cols};align-items:center;column-gap:${U * .012}px;padding:0 ${U * .026}px`;
    const cell = (v, c) => c === hx ? `<span style="display:flex;align-items:center;gap:.5em;font:${fs * .8}px var(--mono)"><i style="flex:none;width:.9em;height:.9em;border-radius:50%;background:${HEX.test(v) ? v : "var(--accent)"}"></i>${esc(v)}</span>`
      : c === pillCol ? `<span style="justify-self:start;padding:.08em .65em;border:1px solid var(--line);border-radius:999px;font:${fs * .72}px var(--mono)">${esc(v)}</span>` : `<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;${c ? `color:${mix("var(--ink)", 75, "var(--card)")}` : ""}">${esc(v)}</span>`;
    const card = h(`<div style="position:absolute;left:${P.x}px;top:${P.y}px;width:${P.w}px;height:${P.h}px;box-sizing:border-box;border-radius:${U * .016}px;border:1px solid var(--line);background:var(--card);color:var(--ink);box-shadow:0 ${U * .02}px ${U * .06}px rgba(0,0,0,.22);display:flex;flex-direction:column;overflow:hidden;font:${fs}px var(--body)">
      <div style="display:flex;justify-content:space-between;padding:${U * .022}px ${U * .026}px;border-bottom:1px solid var(--line);font:${U * .02}px var(--mono)"><span>${esc(s.note ?? "")}</span><span style="color:var(--muted)">${total} ROWS · ${head.length} COLUMNS</span></div>
      <div style="${line};padding-top:${U * .016}px;padding-bottom:${U * .008}px;font:${U * .016}px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">${head.map((t) => `<span>${esc(t)}</span>`).join("")}</div>
      ${rows.map((r) => `<div class="sheet-row" style="${line};flex:1;border-top:1px solid var(--line)">${r.cells.map(cell).join("")}</div>`).join("")}
      <div style="padding:${U * .014}px ${U * .026}px;border-top:1px solid var(--line);font:${U * .016}px var(--mono);letter-spacing:.1em;color:var(--muted)">+ ${Math.max(0, total - rows.length)} MORE ROWS</div></div>`);
    layer.append(card); rise(card, 100, `translateY(${U * .05}px)`);
    const els = $$(".sheet-row", card), first = els[0];
    els.forEach((el, i) => rise(el, 250 + i * 100, `translateY(${U * .02}px)`));
    const ring = h(`<div style="position:absolute;left:${U * .014}px;right:${U * .014}px;top:${first.offsetTop}px;height:${first.offsetHeight}px;box-sizing:border-box;border:2.5px solid var(--accent);border-radius:${U * .012}px"></div>`);
    card.append(ring); K(ring, [[0, { opacity: 0, transform: "scale(1.03)" }], [1100, { opacity: 0, transform: "scale(1.03)" }, EXPO], [1600, { opacity: 1, transform: "none" }]]);
    say(`row ${padTo(1, total)} · ${rows[0]?.name ?? ""}`, `${padTo(1, total)} / ${total}`);
  },
  // fill: one row at a time fills the template's fields; each connector runs from a field to the part of the card it sets.
  fill: (layer, s, ctx) => {
    const { W, H, U } = ctx, { say, P } = prompt(layer, ctx), { head, hx, rows, total } = sheetOf(s), STEP = 900, cp = P.h * .42, cy = P.y + cp + P.h * .12, chh = P.y + P.h - cy, panelW = P.w * .84;
    const keys = head.filter((_, c) => c !== hx).slice(0, 3).concat(hx >= 0 ? [head[hx]] : []), mono = `${U * .025}px/1.2 var(--mono)`;
    const code = h(`<div style="position:absolute;left:${P.x}px;top:${P.y}px;width:${panelW}px;height:${cp}px;box-sizing:border-box;padding:${U * .022}px ${U * .028}px;border-radius:${U * .016}px;background:var(--ink);color:var(--card);font:${mono};display:flex;flex-direction:column;justify-content:space-between;box-shadow:0 ${U * .02}px ${U * .05}px rgba(0,0,0,.25)">
      <div style="opacity:.55;font-size:${U * .02}px">// ${esc(s.note ?? "")} · row <span></span> of ${total}</div>${keys.map((k) => `<div class="code-line"><span style="opacity:.6">${esc(k)}:</span> <span class="code-v"></span></div>`).join("")}</div>`);
    const card = h(`<div style="position:absolute;left:${P.x}px;top:${cy}px;width:${P.w}px;height:${chh}px;box-sizing:border-box;border-radius:${U * .016}px;border:1px solid var(--line);background:var(--card);color:var(--ink);overflow:hidden;box-shadow:0 ${U * .02}px ${U * .06}px rgba(0,0,0,.22)">
      <div class="fill-panel" style="position:absolute;left:0;top:0;width:27%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${U * .006}px"><div style="font:${U * .1}px/1 var(--display)"></div><div style="font:${U * .017}px var(--mono);letter-spacing:.16em;text-transform:uppercase;text-align:center"></div></div>
      <div style="position:absolute;left:31%;top:${chh * .22}px;max-width:48%;transform:translateY(-50%);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:${U * .048}px/1 var(--display)"></div>
      <div style="position:absolute;left:31%;top:${chh * .46}px;max-width:50%;transform:translateY(-50%);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:${U * .025}px/1 var(--body);color:var(--muted)"></div>
      <div style="position:absolute;left:31%;top:${chh * .68}px;transform:translateY(-50%);white-space:nowrap;padding:.5em 1em;border:2px solid;border-radius:999px;font:600 ${U * .018}px/1 var(--body);letter-spacing:.12em;text-transform:uppercase"></div>
      <div class="fill-bar" style="position:absolute;left:0;bottom:0;width:100%;height:${chh * .05}px"></div></div>`);
    layer.append(code, card); rise(code, 100, `translateY(${U * .04}px)`); rise(card, 300, `translateY(${U * .05}px)`);
    const [panel, name, sub, pill, bar] = card.children, [mark, label] = panel.children, [count, ...vals] = [$("span", code.firstElementChild), ...$$(".code-v", code)], lines = $$(".code-line", code);
    // connectors: the lines leave the panel's right edge and drop down the gutter to the card, the lowest field in the outermost lane, so none cross
    const ys = lines.map((l) => P.y + l.offsetTop + l.offsetHeight / 2), ty = [.22, .46, .68, .97].map((f) => cy + chh * f), dx = P.x + P.w - U * .02;
    const path = ys.map((y, i) => `<path d="M${P.x + panelW} ${y} H${P.x + panelW + (P.w - panelW) * (lines.length - i) / (lines.length + 1)} V${ty[i]} H${dx}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/><circle cx="${dx}" cy="${ty[i]}" r="${U * .007}" fill="var(--accent)" opacity="0"/>`);
    const svg = h(`<svg viewBox="0 0 ${W} ${H}" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;overflow:visible">${path.join("")}</svg>`);
    layer.append(svg);
    $$("path", svg).forEach((p, i) => K(p, [[0, { strokeDashoffset: 1 }], [700 + i * 150, { strokeDashoffset: 1 }, EXPO], [1200 + i * 150, { strokeDashoffset: 0 }]]));
    $$("circle", svg).forEach((c, i) => K(c, [[0, { opacity: 0 }], [1100 + i * 150, { opacity: 0 }], [1250 + i * 150, { opacity: 1 }]]));
    let shown = -1;
    tick((ms) => {
      const k = Math.max(0, ms - 500), r = Math.min(rows.length - 1, Math.floor(k / STEP)), row = rows[r], f = smootherstep(((k % STEP) / STEP) * 4), a = .2 + .8 * f, ink = HEX.test(row.color) ? onColor(row.color) : "var(--bg)";
      if (r !== shown) {
        shown = r; count.textContent = padTo(r + 1, total);
        const vs = [row.name, row.company, row.plan].slice(0, keys.length - (hx >= 0 ? 1 : 0)); vals.forEach((v, i) => { v.textContent = i < vs.length ? `'${vs[i]}'` : row.color; });
        panel.style.background = bar.style.background = row.color; panel.style.color = ink; pill.style.color = pill.style.borderColor = HEX.test(row.color) ? row.color : "var(--accent)";
        mark.textContent = initial(row.company || row.name); label.textContent = row.company; name.textContent = row.name; sub.textContent = row.plan ? `Your ${row.plan} workspace is ready.` : row.company; pill.textContent = row.plan ? `${row.plan} plan` : row.company;
        say(`row ${padTo(r + 1, total)} · ${row.name}`, `${padTo(r + 1, total)} / ${total}`);
      }
      vals.forEach((v) => { v.style.opacity = a; }); name.style.opacity = sub.style.opacity = pill.style.opacity = a;
    });
  },
  // grid: the card repeated over a tilted plane, lit from the centre outward while the counter runs to the sheet's row count.
  grid: (layer, s, ctx) => {
    const { U } = ctx, { say, P } = prompt(layer, ctx), { rows, total } = sheetOf(s), cols = 13, nrows = 14, cw = U * .13, chh = cw * .62, gap = cw * .12;
    const view = h(`<div style="position:absolute;left:${P.x}px;top:${P.y}px;width:${P.w}px;height:${P.h}px;overflow:hidden;border-radius:${U * .016}px"></div>`);
    const plane = h(`<div style="position:absolute;left:${(P.w - cols * (cw + gap)) / 2}px;top:${(P.h - nrows * (chh + gap)) / 2}px;width:${cols * (cw + gap)}px;display:grid;grid-template-columns:repeat(${cols},${cw}px);grid-auto-rows:${chh}px;gap:${gap}px"></div>`);
    const tiles = Array.from({ length: cols * nrows }, (_, i) => {
      const r = rows[(i * 5 + Math.floor(i / cols) * 3) % rows.length], t = h(`<div style="display:flex;box-sizing:border-box;border:1px solid var(--line);border-radius:${U * .004}px;background:var(--card);overflow:hidden"><i style="flex:none;width:32%;background:${HEX.test(r.color) ? r.color : "var(--accent)"}"></i><span style="flex:1;padding:${chh * .2}px ${chh * .12}px;display:flex;flex-direction:column;gap:${chh * .12}px"><b style="height:${chh * .13}px;width:80%;background:var(--ink)"></b><b style="height:${chh * .08}px;width:60%;background:var(--muted)"></b></span></div>`);
      return t;
    });
    plane.append(...tiles); view.append(plane); layer.append(view); rise(view, 100, `translateY(${U * .05}px)`);
    const rank = tiles.map((_, i) => Math.hypot(i % cols - (cols - 1) / 2, Math.floor(i / cols) - (nrows - 1) / 2)), far = Math.max(...rank);
    tick((ms) => {
      const p = smootherstep((ms - 300) / 2600), n = Math.floor(p * total), r = rows[n % rows.length];
      plane.style.transform = `perspective(${P.w * 1.1}px) rotateX(56deg) rotateZ(${-22 + ms * .0016}deg) scale(${(1.05 + ms * .00004).toFixed(4)})`;
      tiles.forEach((t, i) => { t.style.opacity = (.16 + .84 * Math.min(1, Math.max(0, (p - rank[i] / far * .9) / .08))).toFixed(3); });
      say(p >= 1 ? `done · ${total} films, one template` : `row ${padTo(n, total)} · ${r.name}`, `${padTo(n, total)} / ${total}`);
    });
  },
};
PATTERNS.story = (layer, s, ctx) => {
  const { W, H } = ctx, stack = W <= H, U = Math.min(W, H), centre = s.kind === "chips" && !stack, lines = [s.title, s.subtitle].filter(Boolean), cx = stack ? W / 2 : W * .7;
  let size = Math.min(centre ? H * .12 : H * .1, (centre ? W * .8 : W * .4) / (.58 * Math.max(...lines.flatMap((l) => l.split(/\s+/)).map((w) => [...w].length), centre ? Math.max(...lines.map((l) => [...l].length)) * .62 : 0)));
  const box = h(`<div style="position:absolute;${centre ? "inset:0;align-items:center;text-align:center;" : stack ? "left:10%;right:10%;top:7%;align-items:flex-start;" : "left:7%;width:42%;top:0;bottom:0;align-items:flex-start;"}display:flex;flex-direction:column;justify-content:${stack ? "flex-start" : "center"};gap:${U * .03}px"></div>`);
  if (s.label) box.append(h(`<div data-safe style="font:${U * .021}px var(--mono);letter-spacing:.12em;text-transform:uppercase;padding:${U * .011}px ${U * .02}px;border-radius:999px;border:1.5px solid ${accentInk};color:${accentInk}">${esc(s.label)}</div>`));
  const part = (t, style = "") => `<div style="${style}">${wordSpans(t, "story-word")}</div>`;
  const head = h(`<div data-safe style="font:400 ${size}px/1.04 var(--display);letter-spacing:-.03em;color:var(--text);text-wrap:balance">${stack ? part(s.title) + (s.subtitle ? part(s.subtitle, `color:${accentInk}`) : "") : wordSpans(s.title, "story-word") + (s.subtitle ? `<br><span style="color:${accentInk}">${wordSpans(s.subtitle, "story-word")}</span>` : "")}</div>`);
  const stage = h(`<div style="position:absolute;inset:0"></div>`); // the held shot never stands still: copy and product share one slow circle (drift, runtime.js)
  box.append(head); layer.append(box, stage);
  // Stacked: each headline part is its own block, so `text-wrap: balance` evens its lines (one inline run with a <br> was left with a
  // lone "by"). The size is fitted by measuring (fonts are loaded); R is then whatever lies between the headline's bottom and the 93% line.
  let R = { x: 0, y: 0, w: W, h: H };
  if (stack) {
    for (size = U * .1; ; size *= .95) { head.style.fontSize = `${size}px`; if (box.offsetHeight <= H * .27 || size < U * .04) break; }
    const y = H * .07 + box.offsetHeight + H * .04;
    R = { x: W * .07, y, w: W * .86, h: H * .89 - y }; // a 4% breath under the headline and the same above the 93% line
  }
  $$(".story-word", head).forEach((w, i) => riseIn(w, i * 70));
  K(box, [[0, { transform: "scale(1)" }], [s.d * 1000, { transform: "scale(1.03)" }]]);
  SURFACE[s.kind](stage, s, { ...ctx, U, R, cx, stack });
  tick((ms) => { const o = drift(ms, W), t = `${o.x.toFixed(2)}px ${o.y.toFixed(2)}px`; box.style.translate = stage.style.translate = t; });
};
})();
