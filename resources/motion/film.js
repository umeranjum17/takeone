// Compositor: mounts the storyboard's scenes onto the stage. Loaded last, after every pattern module.
// window.STORYBOARD = { storyboard, screens: {id: {url, width, height}}, cameras: {key: frames}, tokens }.
"use strict";

// ctx handed to every pattern builder. `camera` is the precomputed per-frame path for that scene (zoom-tour).
window.sceneCtx = (W, H, scene, key) => {
  const S = STORYBOARD, sb = S.storyboard;
  const regions = Object.fromEntries(sb.regions.map((r) => [r.id, r]));
  return {
    W, H, fps: sb.output.fps, tokens: S.tokens, screens: S.screens, regions,
    region: (id) => { const r = regions[id]; if (!r) throw new Error(`unknown region ${id}`); return r; },
    screen: (id) => { const s = S.screens[id ?? Object.keys(S.screens)[0]]; if (!s) throw new Error(`unknown screen ${id}`); return s; },
    camera: S.cameras?.[key] ?? null,
    scene,
  };
};

// Mount scenes into root. Scene times are film seconds; shiftMs moves the whole film on the page clock
// (a tile whose clock reads page time + offset passes shiftMs = -offset). keyPrefix names camera paths.
window.mountScenes = (root, scenes, W, H, shiftMs = 0, keyPrefix = "") => {
  scenes.forEach((s, i) => {
    const layer = h(`<div class="layer" data-scene="${i}" data-pattern="${esc(s.pattern)}"></div>`);
    layer.style.zIndex = String(i + 1);
    root.append(layer);
    window.BASE = s.at * 1000 + shiftMs;
    const dMs = s.d * 1000;
    WINDOW(layer, 0, dMs);
    const build = PATTERNS[s.pattern];
    if (!build) throw new Error(`no pattern ${s.pattern}`);
    build(layer, s, sceneCtx(W, H, s, keyPrefix + i));
    window.BASE = 0;
  });
};

if (STORYBOARD.palette) { document.documentElement.style.setProperty("--design-accent", STORYBOARD.palette.accent); document.documentElement.style.setProperty("--design-on-accent", STORYBOARD.palette.accent_text); }

window.setup = async () => {
  const sb = STORYBOARD.storyboard, stage = $("#stage"), { out_w: W, out_h: H } = sb.output;
  if (sb.layout.kind === "single") mountScenes(stage, sb.scenes, W, H);
  else if (sb.layout.kind === "bento" && window.mountBento) await mountBento(stage, sb);
  else throw new Error(`layout ${sb.layout.kind} is not available`);
  for (const f of window.AFTER_MOUNT ?? []) await f(); // e.g. kerned glyph layout once fonts and layout are final
};
