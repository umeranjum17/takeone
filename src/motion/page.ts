// Builds the self-contained motion page: theme variables, bundled fonts, the runtime, every pattern module and
// the storyboard. Everything is a local file:// URL; the renderer runs with the network off.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lintCss } from "./lint.ts";
import { themeCss, type MotionTokens } from "./theme.ts";

export const MOTION_DIR = fileURLToPath(new URL("../../resources/motion/", import.meta.url));

/** runtime.js first, film.js (the compositor) last, everything else in between in path order. */
export function motionScripts(): string[] {
  const all: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith(".js")) all.push(join(dir, e.name));
    }
  };
  walk(MOTION_DIR);
  const first = join(MOTION_DIR, "runtime.js"), last = join(MOTION_DIR, "film.js");
  return [first, ...all.filter((f) => f !== first && f !== last), last];
}

/** `data` is serialised into window.STORYBOARD (resolved storyboard plus ctx such as screen URLs and camera paths). */
export function motionPage(data: unknown, tokens: MotionTokens, width: number, height: number): string {
  for (const script of motionScripts()) lintCss(readFileSync(script, "utf8"));
  const { css, faces } = themeCss(tokens);
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
${css}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #000; color: var(--text);
  -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; font-kerning: normal; font-variant-ligatures: none;
  font-family: var(--body); }
#stage { position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: var(--bg); }
.layer { position: absolute; inset: 0; overflow: hidden; }
</style>
<script>window.FONT_FACES = ${JSON.stringify(faces)}; window.STORYBOARD = ${json};</script>
${motionScripts().map((f) => `<script src="${pathToFileURL(f).href}"></script>`).join("\n")}
</head><body><div id="stage"></div></body></html>
`;
}
