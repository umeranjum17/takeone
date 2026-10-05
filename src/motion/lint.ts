import { readFileSync } from "node:fs";
import { sceneTexts } from "./storyboard.ts";
import { allTimelines } from "./layout.ts";
import { fontFile, motionTokens, SYMBOL_FONT, RULE_FONT } from "./theme.ts";
import type { Storyboard, Tempo } from "./types.ts";

export function lintCss(css: string): void {
  if (/(?:linear|radial)-gradient\s*\(/i.test(css)) throw new Error("pattern CSS: CSS gradients are nondeterministic; use SVG or canvas");
}

/** Read Unicode cmap 4/12 directly from bundled sfnt fonts, without a runtime dependency. */
export function fontCovers(file: string, text: string): boolean {
  const b = readFileSync(file);
  let cmap = 0;
  for (let i = 0; i < b.readUInt16BE(4); i++) {
    const p = 12 + 16 * i;
    if (b.toString("ascii", p, p + 4) === "cmap") cmap = b.readUInt32BE(p + 8);
  }
  if (!cmap) throw new Error(`font has no cmap: ${file}`);
  const maps: number[] = [];
  for (let i = 0; i < b.readUInt16BE(cmap + 2); i++) {
    const p = cmap + 4 + i * 8, platform = b.readUInt16BE(p), encoding = b.readUInt16BE(p + 2);
    if (platform === 0 || (platform === 3 && [1, 10].includes(encoding))) maps.push(cmap + b.readUInt32BE(p + 4));
  }
  const glyph = (cp: number, p: number): number => {
    const format = b.readUInt16BE(p);
    if (format === 12) {
      for (let i = 0; i < b.readUInt32BE(p + 12); i++) {
        const q = p + 16 + i * 12, lo = b.readUInt32BE(q), hi = b.readUInt32BE(q + 4);
        if (cp >= lo && cp <= hi) return b.readUInt32BE(q + 8) + cp - lo;
      }
    } else if (format === 4 && cp <= 65535) {
      const n = b.readUInt16BE(p + 6) / 2;
      for (let i = 0; i < n; i++) {
        const end = b.readUInt16BE(p + 14 + i * 2), start = b.readUInt16BE(p + 16 + n * 2 + i * 2);
        if (cp < start || cp > end) continue;
        const delta = b.readInt16BE(p + 16 + n * 4 + i * 2), q = p + 16 + n * 6 + i * 2, offset = b.readUInt16BE(q);
        if (!offset) return (cp + delta) & 65535;
        const g = b.readUInt16BE(q + offset + 2 * (cp - start));
        return g ? (g + delta) & 65535 : 0;
      }
    }
    return 0;
  };
  return [...text].every(ch => ch === "\n" || maps.some(p => glyph(ch.codePointAt(0)!, p) !== 0));
}
export function lintFonts(sb: Storyboard): void {
  const tokens = motionTokens(sb.theme.name, sb.theme.overrides);
  for (const scenes of allTimelines(sb.layout, sb.scenes)) for (const [i, s] of scenes.entries()) {
    const fragmentTexts = s.pattern === "fragment" ? sceneTexts(s) : [];
    const monoFragment = s.kind === "counter" || s.kind === "phone-chrome";
    const feedRow = s.pattern === "fragment" && s.kind === "feed-row";
    const device = s.pattern === "fragment" ? s.kind === "browser-chrome" ? "browser" : s.kind === "phone-chrome" ? "phone" : "none" : s.pattern === "kinetic-type" ? s.device ?? "none" : ["hero-reveal", "zoom-tour"].includes(s.pattern) ? s.device ?? "browser" : "none";
    const display = [s.title, s.logo, ...((s.tiles ?? []).map(t => t.title))];
    const body = [s.subtitle, s.cta, s.text, ...(!monoFragment ? feedRow ? fragmentTexts.slice(0, 2) : fragmentTexts : []), ...(s.stops ?? []).map(t => t.caption), ...(device === "browser" ? ["Design preview"] : [])];
    const mono = [s.url, ...(monoFragment ? fragmentTexts : []), ...(s.kind === "counter" ? ["0123456789"] : []), ...(feedRow ? ["Just now"] : []), ...(device === "phone" ? ["9:41"] : [])];
    const symbols = [...(s.kind === "toast" ? ["✓"] : []), ...(device === "browser" ? ["● ● ●"] : [])];
    for (const [family, strings] of [[tokens.display_font, display], [tokens.caption_font, body], [tokens.mono_font, mono], [SYMBOL_FONT, symbols], [RULE_FONT, device === "phone" ? ["━"] : []]] as const) {
      for (const text of strings) if (text && !fontCovers(fontFile(family)!, text)) throw new Error(`scenes[${i}]: missing glyph in ${family} for ${JSON.stringify(text)}; select a bundled font with coverage`);
    }
  }
}
export function beatTime(t: number, tempo: Tempo, fps: number, path: string): number {
  const step = 60 / tempo.bpm / (tempo.snap === "half" ? 2 : 1);
  const snapped = tempo.phase_s + Math.round((t - tempo.phase_s) / step) * step;
  if (Math.abs(snapped - t) > 1 / fps + 1e-8) throw new Error(`${path}: ${t} s is off the beat grid`);
  return snapped;
}
