// Story beat (`--recipe story`): copy on one side and the product drawn on the other from the brief's own words, so a film needs
// no screenshot. `kind` picks the surface (chips, phone, cards, stats); `tree` holds its rows. Dark and light beats alternate
// through `invert`. Entrances are K keys, the drift and the counters are ticks: every frame is a pure function of the clock.
// Layout: a landscape frame sets copy left and product right. A portrait or square frame (W <= H) stacks them instead: the headline
// block in the top 27% (10% side margins, room for the push-in between beats) and the product in a region `R` below it (40% to 93% of the height).
(() => {
const EXPO = "cubic-bezier(.16,1,.3,1)", mix = (a, p, b) => `color-mix(in srgb, ${a} ${p}%, ${b})`, accentInk = mix("var(--accent)", 62, "var(--text)");
const rise = (el, at, from) => K(el, [[at, { opacity: 0, transform: from }, EXPO], [at + 650, { opacity: 1, transform: "none" }]]);
const SURFACE = {
  chips: (layer, s, { W, H, U, R, stack }) => (s.tree ?? []).forEach((t, i, all) => {
    const [x, y] = [[.05, .12], [.52, .07], [.74, .17], [.03, .72], [.3, .87], [.58, .82], [.76, .68], [.28, .2]][i];
    // stacked: one chip per row of R, each at its own x, sized from its text so it stays inside the margin
    const fs = stack ? U * .034 : H * .024, pad = stack ? U * .026 : H * .014, padX = stack ? U * .047 : H * .026, w = Math.min(R.w, [...t].length * fs * .62 + 2 * padX);
    const at = stack ? `left:${R.x + [.05, .62, .2, .7, .1, .5, .3, .66][i] * (R.w - w)}px;top:${R.y + (i + .5) * R.h / all.length - (fs * 1.2 + 2 * pad) / 2}px` : `left:${x * 100}%;top:${y * 100}%`;
    const chip = h(`<div style="position:absolute;${at};padding:${pad}px ${padX}px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--ink);font:${fs}px var(--body);white-space:nowrap">${esc(t)}</div>`);
    layer.append(chip); rise(chip, 300 + i * 140, `translateY(${U * .03}px)`);
    tick((ms) => { const a = ms / 2600 + i; chip.style.translate = `${(Math.sin(a * 2) * W * .004).toFixed(2)}px ${(Math.cos(a * 1.7) * U * .008).toFixed(2)}px`; });
  }),
  phone: (layer, s, { H, R, stack }) => {
    // P is the unit the phone is drawn in: H on a landscape frame, and pw / .42 when stacked, so the drawing keeps its proportions at any width
    const [ask, ...answer] = s.tree, ph = stack ? R.h * .97 : H * .8, pw = stack ? Math.min(R.w * .72, ph * .67) : H * .42, P = pw / .42, sz = P * .026, typed = 700 + 35 * ask.length;
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
    // Q is the unit the cards are drawn in: H on a landscape frame, cw / .3 when stacked (cards fit R's width, fanned and tilted)
    const rows = s.tree, cw = stack ? Math.min(R.w * .42, R.w / (1.3 + (rows.length - 1) * .56)) : H * .3, ch = cw * 1.3, Q = cw / .3;
    rows.forEach((t, i) => {
      const f = i - (rows.length - 1) / 2, to = `translate(${f * cw * .56}px,${Math.abs(f) * Q * .02}px) rotate(${f * 7}deg)`;
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
    const rows = s.tree, n = Math.ceil(rows.length / 2), gap = (stack ? R.w : H) * (stack ? .035 : .03), tw = stack ? (R.w - gap) / 2 : W * .19, th = stack ? Math.min(tw * .8, (R.h - gap * (n - 1)) / n) : H * .27, S = th / .27;
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
};
PATTERNS.story = (layer, s, ctx) => {
  const { W, H } = ctx, stack = W <= H, U = Math.min(W, H), centre = s.kind === "chips" && !stack, lines = [s.title, s.subtitle].filter(Boolean);
    const R = stack ? { x: W * .07, y: H * .4, w: W * .86, h: H * .53 } : { x: 0, y: 0, w: W, h: H }, cx = stack ? W / 2 : W * .7;
  const rowsOf = (l, size) => { let rows = 1, run = 0; for (const w of l.split(/\s+/)) { const ww = [...w].length * size * .56; if (run && run + size * .28 + ww > W * .8) { rows++; run = ww; } else run += (run ? size * .28 : 0) + ww; } return rows; };
  const room = H * .27 - (s.label ? U * .09 : 0);
  let size = Math.min(centre ? H * .12 : H * .1, (centre ? W * .8 : W * .4) / (.58 * Math.max(...lines.flatMap((l) => l.split(/\s+/)).map((w) => [...w].length), centre ? Math.max(...lines.map((l) => [...l].length)) * .62 : 0)));
  if (stack) for (size = U * .1; size > U * .04 && lines.reduce((n, l) => n + rowsOf(l, size), 0) * size * 1.04 > room; size *= .95);
  const box = h(`<div style="position:absolute;${centre ? "inset:0;align-items:center;text-align:center;" : stack ? "left:10%;right:10%;top:7%;height:27%;align-items:flex-start;" : "left:7%;width:42%;top:0;bottom:0;align-items:flex-start;"}display:flex;flex-direction:column;justify-content:${stack ? "flex-start" : "center"};gap:${U * .03}px"></div>`);
  if (s.label) box.append(h(`<div data-safe style="font:${U * .021}px var(--mono);letter-spacing:.12em;text-transform:uppercase;padding:${U * .011}px ${U * .02}px;border-radius:999px;border:1.5px solid ${accentInk};color:${accentInk}">${esc(s.label)}</div>`));
  const head = h(`<div data-safe style="font:400 ${size}px/1.04 var(--display);letter-spacing:-.03em;color:var(--text);text-wrap:balance">${wordSpans(s.title, "story-word")}${s.subtitle ? `<br><span style="color:${accentInk}">${wordSpans(s.subtitle, "story-word")}</span>` : ""}</div>`);
  const stage = h(`<div style="position:absolute;inset:0"></div>`); // the held shot never stands still: copy and product share one slow circle (drift, runtime.js)
  box.append(head); layer.append(box, stage);
  $$(".story-word", head).forEach((w, i) => riseIn(w, i * 70));
  K(box, [[0, { transform: "scale(1)" }], [s.d * 1000, { transform: "scale(1.03)" }]]);
  SURFACE[s.kind](stage, s, { ...ctx, U, R, cx, stack });
  tick((ms) => { const o = drift(ms, W), t = `${o.x.toFixed(2)}px ${o.y.toFixed(2)}px`; box.style.translate = stage.style.translate = t; });
};
})();
