// Bento launch reel (the `--recipe bento` grammar): five tiles on a 12x6 grid that reflow between three grids on
// the beat (FLIP: each tile springs from its old rect to its new one, 30 ms stagger, content re-lays out in
// container units and never stretches). Tiles: serif headline with an inverted highlight wipe, procedural op-art
// (stripes, zigzag, checks), a rolling counter with a line chart drawing, a live feed whose inserts push older
// rows down, and real crops of the user's own screen. Every frame is a pure function of the page clock.
{ // block scope: pattern files share one script scope
const EXPO = "cubic-bezier(.16,1,.3,1)";
// Grid cells [col, row, cols, rows] per tile, one grid per third of the reel; each grid tiles the 12x6 area exactly.
const GRIDS = [
  { H: [0, 0, 8, 3], P: [8, 0, 4, 4], U: [0, 3, 4, 3], K: [4, 3, 4, 3], F: [8, 4, 4, 2] },
  { K: [0, 0, 7, 4], P: [7, 0, 5, 2], F: [7, 2, 5, 4], H: [0, 4, 4, 2], U: [4, 4, 3, 2] },
  { U: [0, 0, 5, 6], H: [5, 0, 7, 2], F: [5, 2, 4, 4], K: [9, 2, 3, 2], P: [9, 4, 3, 2] },
];
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const expoOut = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp01(x)));
const OPART = [
  (id) => `<pattern id="${id}" width="44" height="44" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="22" height="44" style="fill:var(--text)"/></pattern>`,
  (id) => `<pattern id="${id}" width="52" height="36" patternUnits="userSpaceOnUse"><path d="M-6 28 L13 8 L39 28 L58 8" fill="none" style="stroke:var(--text)" stroke-width="10"/></pattern>`,
  (id) => `<pattern id="${id}" width="64" height="64" patternUnits="userSpaceOnUse"><rect width="32" height="32" style="fill:var(--text)"/><rect x="32" y="32" width="32" height="32" style="fill:var(--text)"/></pattern>`,
];

PATTERNS["bento-reel"] = (layer, s, ctx) => {
  const { W, H } = ctx, t = ctx.tokens, sx = W / 1920, sy = H / 1080, mx = t.margin_x * sx, my = t.margin_y * sy, gx = t.gutter_x * sx, gy = t.gutter_y * sy;
  const cw = (W - 2 * mx - 11 * gx) / 12, ch = (H - 2 * my - 5 * gy) / 6, d = s.d * 1000, r = s.reel, third = d / 3;
  const rect = ([c, rw, w, hh]) => [mx + c * (cw + gx), my + rw * (ch + gy), w * cw + (w - 1) * gx, hh * ch + (hh - 1) * gy];
  const px = (v) => v.map((n) => `${n.toFixed(2)}px`);
  layer.style.background = "var(--page)";
  const tile = (id, bg, inner) => {
    const el = h(`<div data-moves style="position:absolute;overflow:hidden;container-type:size;border-radius:var(--radius);background:${bg};color:var(--text)"></div>`);
    el.append(...inner); layer.append(el);
    // One spring per reflow, from the old rect to the new one; the stagger follows the tile's order on the page.
    const at = (k) => k * third + 30 * ["H", "P", "U", "K", "F"].indexOf(id);
    const box = (k) => { const [l, tp, w, hh] = px(rect(GRIDS[k][id])); return { left: l, top: tp, width: w, height: hh }; };
    K(el, [[0, box(0)], ...[1, 2].flatMap((k) => [[at(k), box(k - 1), EXPO], [at(k) + 400, box(k)]])]);
  };
  const fill = (extra) => `position:absolute;inset:0;${extra}`;

  // H: the headline rises word by word; the last words take an inverted highlight wipe.
  const head = h(`<div style="${fill("padding:7cqmin;display:flex;align-items:center;font:min(11cqw,21cqh)/1.06 var(--display);letter-spacing:-.015em")}"><div>${wordSpans(s.title, "rw")} <span style="position:relative;display:inline-block;padding:0 .14em"><span>${esc(s.subtitle)}</span><span class="wipe" style="position:absolute;inset:0;padding:0 .14em;background:var(--text);color:var(--bg);clip-path:inset(0 100% 0 0)">${esc(s.subtitle)}</span></span></div></div>`);
  tile("H", "var(--bg)", [head]);
  $$(".rw", head).forEach((w, i) => riseIn(w, 150 + i * 70));
  K($(".wipe", head), [[0, { clipPath: "inset(0 100% 0 0)" }], [1000, { clipPath: "inset(0 100% 0 0)" }, EXPO], [1600, { clipPath: "inset(0 0% 0 0)" }]]);

  // P: op-art, a hard swap every four beats; each pattern drifts on the page clock.
  const kinds = [0, 1, 2, 0], swaps = [0, 2000, 6000, 10000, d];
  const art = kinds.map((k, i) => h(`<svg style="${fill("width:100%;height:100%")}" width="100%" height="100%"><defs>${OPART[k](`op${i}`)}</defs><rect width="100%" height="100%" fill="url(#op${i})"/></svg>`));
  tile("P", "var(--bg)", art);
  art.forEach((el, i) => WINDOW(el, swaps[i], swaps[i + 1]));
  tick((ms) => art.forEach((el, i) => $("pattern", el).setAttribute("patternTransform", kinds[i] === 0 ? `rotate(45) translate(${(ms * 0.02) % 44} 0)` : `translate(${(ms * 0.03) % 52} 0)`)));

  // K: the counter rolls to the demo figure while the line draws and the tip ring rides its end.
  const N = 24, pts = Array.from({ length: N + 1 }, (_, i) => { const u = i / N; return 36 - 30 * (0.12 + 0.88 * Math.pow(u, 1.4)) - 2.4 * Math.sin(i * 1.7) * (1 - u); });
  const line = pts.map((y, i) => `${i ? "L" : "M"}${(i / N * 100).toFixed(2)} ${y.toFixed(2)}`).join(" ");
  const kpi = h(`<div style="${fill("padding:7cqmin;color:var(--bg)")}"><div style="font:min(4.2cqw,7cqh) var(--mono);color:var(--muted);white-space:nowrap">${esc(s.label)}</div><div class="num" style="font:600 min(15cqw,24cqh)/1.1 var(--body);letter-spacing:-.02em;margin-top:2cqh">$0</div><div style="position:absolute;left:7cqmin;right:7cqmin;bottom:8cqmin;height:36cqh"><svg class="draw" viewBox="0 0 100 40" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;overflow:visible"><path d="${line}" fill="none" style="stroke:var(--bg)" stroke-width="3" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg><div class="tip" style="position:absolute;width:5cqmin;height:5cqmin;margin:-2.5cqmin;border-radius:50%;border:.6cqmin solid var(--bg)"></div></div></div>`);
  tile("K", "var(--ink)", [kpi]);
  tick((ms) => {
    const v = expoOut((ms - 300) / (0.6 * d)), p = clamp01((ms - 300) / (0.7 * d)), f = p * N, i = Math.min(N - 1, Math.floor(f));
    $(".num", kpi).textContent = `$${Math.round(r.value * v).toLocaleString("en-US")}`;
    $(".draw", kpi).style.clipPath = `inset(-10% ${(100 - p * 100).toFixed(3)}% -10% 0)`;
    const tip = $(".tip", kpi), y = pts[i] + (pts[i + 1] - pts[i]) * (f - i);
    tip.style.left = `${(p * 100).toFixed(3)}%`; tip.style.top = `${(y / 40 * 100).toFixed(3)}%`; tip.style.opacity = p > 0 ? 1 : 0;
  });

  // F: a LIVE feed. A row lands every second on an overshooting spring and pushes older rows down; rows fade before the tile's end.
  const PITCH = 17.5, rows = r.feed.map((text) => h(`<div style="position:absolute;left:6cqw;right:6cqw;top:20cqh;height:15cqh;display:flex;align-items:center;padding:0 4cqw;border-radius:3cqh;background:var(--card);border:1px solid var(--line);font:min(6.5cqh,4.4cqw) var(--body);color:var(--ink);white-space:nowrap;opacity:0">${esc(text)}</div>`));
  const feed = h(`<div style="${fill("")}"><div style="position:absolute;left:6cqw;top:6cqh;display:flex;align-items:center;gap:2cqw;font:min(6cqh,4cqw) var(--mono);color:var(--muted)"><span class="dot" style="width:2.4cqmin;height:2.4cqmin;border-radius:50%;background:var(--text)"></span>LIVE</div></div>`);
  feed.append(...rows);
  tile("F", "var(--bg)", [feed]);
  const rowAt = (i) => 600 + i * 1000, depth = rows.map((_, i) => track(0, rows.slice(i + 1).map((__, j) => [rowAt(i + 1 + j), j + 1]), { omega: 16, zeta: 0.55 }));
  tick((ms) => {
    $(".dot", feed).style.opacity = Math.floor(ms / 500) % 2 ? 0.25 : 1;
    rows.forEach((row, i) => {
      const k = depth[i](ms), s1 = springStep((ms - rowAt(i)) / 1000, 16, 0.55);
      row.style.transform = `translateY(${(k * PITCH).toFixed(3)}cqh) scale(${(0.9 + 0.1 * s1).toFixed(4)})`;
      row.style.opacity = ms < rowAt(i) - 1 ? 0 : (clamp01(s1 * 4) * (k < 3 ? 1 : Math.max(0, 1 - (k - 3) * 4))).toFixed(4);
    });
  });

  // U: real crops of the screen, a hard swap between them, each on a slow push.
  const bounds = r.shots.map((_, i) => (i ? Math.round((d * i / r.shots.length + 1000) / 500) * 500 : 0)).concat(d);
  const shots = r.shots.map((id) => h(`<div style="${fill("padding:5cqmin")}"><img src="${ctx.screen(id).url}" style="width:100%;height:100%;object-fit:contain;display:block;border-radius:calc(var(--radius) / 2);box-shadow:0 0 0 1px var(--line)"></div>`));
  tile("U", "var(--bg)", shots);
  shots.forEach((el, i) => { WINDOW(el, bounds[i], bounds[i + 1]); K($("img", el), [[bounds[i], { transform: "scale(1)" }], [bounds[i + 1], { transform: "scale(1.04)" }]]); });
};
}
