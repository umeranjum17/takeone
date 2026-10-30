// Story beat (`--recipe story`): copy on one side and the product drawn on the other from the brief's own words, so a film needs
// no screenshot. `kind` picks the surface (chips, phone, cards, stats); `tree` holds its rows. Dark and light beats alternate
// through `invert`. Entrances are K keys, the drift and the counters are ticks: every frame is a pure function of the clock.
(() => {
const EXPO = "cubic-bezier(.16,1,.3,1)", mix = (a, p, b) => `color-mix(in srgb, ${a} ${p}%, ${b})`, accentInk = mix("var(--accent)", 62, "var(--text)");
const rise = (el, at, from) => K(el, [[at, { opacity: 0, transform: from }, EXPO], [at + 650, { opacity: 1, transform: "none" }]]);
const SURFACE = {
  chips: (layer, s, { W, H }) => (s.tree ?? []).forEach((t, i) => {
    const [x, y] = [[.05, .12], [.52, .07], [.74, .17], [.03, .72], [.3, .87], [.58, .82], [.76, .68], [.28, .2]][i];
    const chip = h(`<div style="position:absolute;left:${x * 100}%;top:${y * 100}%;padding:${H * .014}px ${H * .026}px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--ink);font:${H * .024}px var(--body);white-space:nowrap">${esc(t)}</div>`);
    layer.append(chip); rise(chip, 300 + i * 140, `translateY(${H * .03}px)`);
    tick((ms) => { const a = ms / 2600 + i; chip.style.translate = `${(Math.sin(a * 2) * W * .004).toFixed(2)}px ${(Math.cos(a * 1.7) * H * .008).toFixed(2)}px`; });
  }),
  phone: (layer, s, { W, H }) => {
    const [ask, ...answer] = s.tree, pw = H * .42, ph = H * .8, sz = H * .026, typed = 700 + 35 * ask.length;
    const bubble = (bg, x) => `max-width:82%;align-self:${x};padding:${H * .016}px ${H * .02}px;border-radius:${H * .026}px;background:${bg};color:var(--ink);font:${sz}px/1.3 var(--body)`;
    const phone = h(`<div style="position:absolute;right:9%;top:${(H - ph) / 2}px;width:${pw}px;height:${ph}px;box-sizing:border-box;border-radius:${H * .05}px;border:2px solid var(--line);background:var(--card);overflow:hidden;display:flex;flex-direction:column;gap:${H * .018}px;padding:${H * .03}px ${H * .022}px;box-shadow:0 ${H * .04}px ${H * .1}px rgba(0,0,0,.35)">
      <div style="display:flex;align-items:center;gap:${H * .014}px;color:var(--ink);font:${sz}px var(--display)"><i style="width:${H * .04}px;height:${H * .04}px;border-radius:50%;background:var(--accent)"></i>${esc(s.text ?? "")}</div>
      <div id="ask" style="${bubble(mix("var(--accent)", 35, "var(--card)"), "flex-end")};opacity:0"><span></span><span style="visibility:hidden"></span></div>
      <div id="answer" style="${bubble(mix("var(--ink)", 9, "var(--card)"), "flex-start")};display:flex;flex-direction:column;gap:${H * .008}px">${answer.map((t) => `<div style="opacity:0">${esc(t)}</div>`).join("")}</div>
      <div style="margin-top:auto;height:${H * .05}px;border-radius:999px;border:1px solid var(--line)"></div></div>`);
    layer.append(phone); rise(phone, 100, `translateY(${H * .06}px) scale(.96)`);
    const [bubbleAsk, answerBox] = [$("#ask", phone), $("#answer", phone)], [seen, rest] = $$("span", bubbleAsk);
    answerBox.style.opacity = "0"; K(answerBox, [[typed + 450, { opacity: 0 }], [typed + 750, { opacity: 1 }]]);
    $$("#answer > div", phone).forEach((line, i) => K(line, [[typed + 500 + 450 * i, { opacity: 0 }, SMOOTH], [typed + 900 + 450 * i, { opacity: 1 }]]));
    tick((ms) => { const n = Math.max(0, Math.min(ask.length, Math.floor((ms - 700) / 35))); bubbleAsk.style.opacity = ms >= 700 - 35 ? "1" : "0"; seen.textContent = ask.slice(0, n); rest.textContent = ask.slice(n); });
  },
  cards: (layer, s, { W, H }) => {
    const rows = s.tree, cw = H * .3, ch = cw * 1.3;
    rows.forEach((t, i) => {
      const f = i - (rows.length - 1) / 2, to = `translate(${f * cw * .5}px,${Math.abs(f) * H * .02}px) rotate(${f * 7}deg)`;
      const card = h(`<div style="position:absolute;left:${W * .7 - cw / 2}px;top:${H / 2 - ch / 2}px;width:${cw}px;height:${ch}px;box-sizing:border-box;padding:${H * .026}px;border-radius:${H * .014}px;background:var(--text);color:var(--bg);box-shadow:0 ${H * .02}px ${H * .05}px rgba(0,0,0,.3);display:flex;flex-direction:column;gap:${H * .018}px">
        <div style="font:${H * .027}px/1.1 var(--display)">${esc(t)}</div>${[100, 86, 92, 58].map((w) => `<i style="height:${H * .011}px;width:${w}%;border-radius:9px;background:${mix("var(--bg)", 16, "transparent")}"></i>`).join("")}
        <i style="margin-top:auto;height:${H * .045}px;border-radius:${H * .01}px;background:var(--accent)"></i></div>`);
      layer.append(card);
      K(card, [[300 + i * 160, { opacity: 0, transform: `translateY(${H * .2}px)` }, EXPO], [1000 + i * 160, { opacity: 1, transform: to }]]);
    });
  },
  stats: (layer, s, { W, H }) => {
    const tw = W * .19, th = H * .27, gap = H * .03, rows = s.tree;
    rows.forEach((t, i) => {
      const m = /^(\D*?)(\d[\d,]*)\s+(.*)$/.exec(t) ?? [, "", "0", t], value = Number(m[2].replace(/,/g, "")), last = i === rows.length - 1;
      const tile = h(`<div style="position:absolute;left:${W * .7 - tw - gap / 2 + (i % 2) * (tw + gap)}px;top:${H / 2 - th - gap / 2 + Math.floor(i / 2) * (th + gap)}px;width:${tw}px;height:${th}px;box-sizing:border-box;padding:${H * .03}px;border-radius:${H * .022}px;border:${last ? 3 : 1}px solid ${last ? "var(--accent)" : "var(--line)"};background:var(--card);color:var(--ink);display:flex;flex-direction:column;justify-content:space-between;${last ? `box-shadow:0 0 ${H * .06}px ${mix("var(--accent)", 35, "transparent")}` : ""}">
        <div style="font:${H * .11}px/1 var(--display);letter-spacing:-.03em"></div><div style="font:${H * .026}px var(--body);color:${mix("var(--ink)", 70, "var(--card)")}">${esc(m[3])}</div></div>`);
      layer.append(tile); rise(tile, 300 + i * 220, `translateY(${H * .04}px)`);
      const num = tile.firstElementChild, t0 = 400 + i * 220;
      tick((ms) => { num.textContent = m[1] + Math.round(value * smootherstep((ms - t0) / 1300)).toLocaleString("en-US"); });
    });
  },
};
PATTERNS.story = (layer, s, ctx) => {
  const { W, H } = ctx, centre = s.kind === "chips", lines = [s.title, s.subtitle].filter(Boolean);
  const size = Math.min(centre ? H * .12 : H * .1, (centre ? W * .8 : W * .4) / (.58 * Math.max(...lines.flatMap((l) => l.split(/\s+/)).map((w) => [...w].length), centre ? Math.max(...lines.map((l) => [...l].length)) * .62 : 0)));
  const box = h(`<div style="position:absolute;${centre ? "inset:0;align-items:center;text-align:center;" : "left:7%;width:42%;top:0;bottom:0;align-items:flex-start;"}display:flex;flex-direction:column;justify-content:center;gap:${H * .03}px"></div>`);
  if (s.label) box.append(h(`<div data-safe style="font:${H * .021}px var(--mono);letter-spacing:.12em;text-transform:uppercase;padding:${H * .011}px ${H * .02}px;border-radius:999px;border:1.5px solid ${accentInk};color:${accentInk}">${esc(s.label)}</div>`));
  const head = h(`<div data-safe style="font:400 ${size}px/1.04 var(--display);letter-spacing:-.03em;color:var(--text);text-wrap:balance">${wordSpans(s.title, "story-word")}${s.subtitle ? `<br><span style="color:${accentInk}">${wordSpans(s.subtitle, "story-word")}</span>` : ""}</div>`);
  const stage = h(`<div style="position:absolute;inset:0"></div>`); // the held shot never stands still: copy and product share one slow circle (drift, runtime.js)
  box.append(head); layer.append(box, stage);
  $$(".story-word", head).forEach((w, i) => riseIn(w, i * 70));
  K(box, [[0, { transform: "scale(1)" }], [s.d * 1000, { transform: "scale(1.03)" }]]);
  SURFACE[s.kind](stage, s, ctx);
  tick((ms) => { const o = drift(ms, W), t = `${o.x.toFixed(2)}px ${o.y.toFixed(2)}px`; box.style.translate = stage.style.translate = t; });
};
})();
