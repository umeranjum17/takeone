// `takeone brand <url> --out DIR`: read a public page into a DRAFT brand file a person confirms before any ad is made.
// Only what the page states mechanically is read (theme-color, computed colours and fonts, icon links, og tags, a
// header mark). The accent, the brand name, the copy and any figure are never decided here: the draft lists them under
// `draft.confirm` and the command prints each one. The draft's extra keys are ignored by readBrand.
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bundledFont, LOGO_EXTENSIONS, luminance, readBrand } from "./brand.ts";
import { launch, navigate } from "./cdp.ts";
import { ingest } from "./ingest.ts";
import { samplePalette } from "./palette.ts";
import { pinnedShell } from "./shell.ts";
import { fontFile } from "./theme.ts";
import type { Storyboard } from "./types.ts";

interface PageFacts {
  title: string; siteName: string; description: string; h1: string; ogImage: string; themeColors: { content: string; media: string }[];
  bg: string; fg: string; fonts: { display: string; body: string; mono: string };
  accentVars: string[]; icons: { href: string; rel: string }[]; headerImg: string; headerSvg: string;
}

/** Everything read off the loaded page: strings only, so the draft records exactly what the page said. */
const READ_PAGE = `(() => {
  const q = (s) => document.querySelector(s), meta = (s) => q(s)?.content?.trim() ?? "";
  const family = (el) => el ? getComputedStyle(el).fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "") : "";
  const colour = (el, p) => el ? getComputedStyle(el)[p] : "";
  const once = (t) => { const i = t.indexOf(t.slice(0, 12), 12); return i > 0 ? t.slice(0, i).trim() : t; };
  const vars = [];
  for (const sheet of document.styleSheets) { let rules; try { rules = sheet.cssRules; } catch { continue; }
    for (const r of rules) if (r.selectorText === ":root" || r.selectorText === "html") for (const n of r.style) if (/^--.*(accent|brand|primary)/i.test(n)) vars.push(r.style.getPropertyValue(n).trim()); }
  const mark = [...document.querySelectorAll('header svg, nav svg, a[href="/"] svg')].find(e => { const r = e.getBoundingClientRect(); return r.width >= 16 && r.width <= 400 && r.height >= 12; });
  let svg = "";
  if (mark) { const c = mark.cloneNode(true), r = mark.getBoundingClientRect(); c.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    if (!c.getAttribute("viewBox")) c.setAttribute("viewBox", "0 0 " + r.width + " " + r.height);
    svg = c.outerHTML.replace(/currentColor/g, getComputedStyle(mark).color); }
  const img = [...document.querySelectorAll('header img, nav img, a[href="/"] img')].find(e => e.currentSrc && e.naturalWidth >= 16);
  const bg = [document.body, document.documentElement].map(e => colour(e, "backgroundColor")).find(c => c && !/rgba\\(.*, 0\\)|transparent/.test(c)) ?? "";
  return { title: document.title.trim(), siteName: meta('meta[property="og:site_name"]'), description: meta('meta[property="og:description"]') || meta('meta[name=description]'),
    h1: once(q("h1")?.innerText.trim().replace(/\\s+/g, " ") ?? ""), ogImage: q('meta[property="og:image"]')?.content ?? "",
    themeColors: [...document.querySelectorAll('meta[name="theme-color"]')].map(m => ({ content: m.content, media: m.media })),
    bg, fg: colour(q("h1") ?? document.body, "color"), fonts: { display: family(q("h1")), body: family(document.body), mono: family(q("code, pre")) },
    accentVars: vars, icons: [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')].map(l => ({ href: l.href, rel: l.rel })),
    headerImg: img?.currentSrc ?? "", headerSvg: svg };
})()`;

/** #rrggbb from a hex or rgb()/rgba() string, else undefined (transparent and wide-gamut colours are skipped, not guessed). */
export function toHex(s: string): string | undefined {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (hex) return "#" + (hex[1]!.length === 3 ? [...hex[1]!].map(c => c + c).join("") : hex[1]!).toLowerCase();
  const rgb = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(s.trim());
  return rgb ? "#" + rgb.slice(1, 4).map(v => Number(v).toString(16).padStart(2, "0")).join("") : undefined;
}

export interface FontMatch { family: string; from: string; exact: boolean }
/** The bundled family for a page's font: exact when TakeOne bundles it, else the nearest by kind, and always said plainly. */
export function matchFont(from: string, role: "display" | "body" | "mono"): FontMatch | undefined {
  if (!from) return undefined;
  const name = from.replace(/\s+(Variable|Display|Text|Pro|VF)\b/gi, "").trim();
  try { return { family: bundledFont(name, role), from, exact: true }; } catch { /* not bundled: nearest by kind */ }
  const kind = /mono|code|courier|consolas/i.test(name) ? "mono" : /(?<!sans[- ])serif|georgia|times|garamond|playfair|lora|merriweather|baskerville|didot/i.test(name) ? "serif" : "sans";
  const near = kind === "mono" ? "JetBrains Mono" : kind === "serif" ? (role === "display" ? "Instrument Serif" : "Fraunces") : "Inter";
  return { family: bundledFont(near, role), from, exact: false };
}

/** A logo file for the draft: the header's inline SVG, else the first icon or header image that downloads as a bundled-type file. */
async function saveLogo(facts: PageFacts, out: string): Promise<{ file: string; from: string } | undefined> {
  if (facts.headerSvg && !/<script|<foreignObject|(?:href|src)\s*=\s*(?!["']?(?:#|data:))|url\(\s*(?!["']?(?:#|data:))/i.test(facts.headerSvg)) {
    writeFileSync(join(out, "logo.svg"), facts.headerSvg + "\n");
    return { file: "logo.svg", from: "the header's inline SVG" };
  }
  const found = [...facts.icons.filter(i => /\.svg(\?|$)/i.test(i.href)), { href: facts.headerImg, rel: "header image" }, ...facts.icons.filter(i => !/\.svg(\?|$)/i.test(i.href))];
  for (const { href, rel } of found) {
    const ext = extname(new URL(href || "x:", "https://x").pathname).toLowerCase();
    if (!/^https?:/.test(href) || !LOGO_EXTENSIONS.includes(ext)) continue;
    try {
      const res = await fetch(href, { signal: AbortSignal.timeout(15000) });
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!res.ok || !bytes.length || bytes.length > 2 * 1024 * 1024) continue;
      if (ext === ".svg" && /<script|<foreignObject|(?:href|src)\s*=\s*(?!["']?(?:#|data:))/i.test(bytes.toString("utf8"))) continue;
      writeFileSync(join(out, `logo${ext}`), bytes);
      return { file: `logo${ext}`, from: `${rel} ${href}` };
    } catch { /* try the next candidate */ }
  }
  return undefined;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The contact sheet: the capture, the colours in their roles, the logo on the stage and each font set in its bundled match. */
function contactHtml(o: { url: string; shot: string; bg: string; fg: string; accent?: string; logo?: string; fonts: Partial<Record<"display" | "body" | "mono", FontMatch>>; h1: string; confirm: string[] }): string {
  const faces = Object.values(o.fonts).map(f => `@font-face{font-family:"${f.family}";src:url("${pathToFileURL(fontFile(f.family)!).href}")}`).join("");
  const font = (r: "display" | "body" | "mono") => o.fonts[r]?.family ?? "Inter Bold";
  const chip = (c: string, label: string) => `<div class="c" style="background:${c};color:${luminance(c) > 0.179 ? "#000" : "#fff"}">${label}<br>${c}</div>`;
  return `<!doctype html><meta charset=utf-8><style>${faces}body{margin:0;width:1600px;height:900px;background:#111;color:#eee;font:16px "${font("body")}";display:grid;grid-template:auto 1fr/820px 1fr;align-items:start;gap:24px;padding:32px;box-sizing:border-box}
h2{grid-column:1/3;margin:0;font:600 18px "${font("body")}";color:#aaa}img.s{width:820px;border-radius:8px}.c{padding:14px;border-radius:8px;margin:0 0 10px;font:14px "${font("mono")}"}
.stage{background:${o.bg};color:${o.fg};padding:24px;border-radius:8px;margin-bottom:10px}.stage img{height:48px}.stage h3{font:700 38px "${font("display")}";margin:12px 0 0;color:${o.fg}}.stage p{font:20px "${font("body")}";margin:8px 0 0}.stage b{color:${o.accent ?? o.fg}}
ol{margin:14px 0 0;padding-left:22px;font:15px/1.4 "${font("body")}";color:#ddd}li{margin-bottom:6px}small{color:#999;font:13px "${font("mono")}"}</style><h2>${esc(o.url)} · DRAFT, nothing here is confirmed</h2><div><img class=s src="${pathToFileURL(o.shot).href}"><ol>${o.confirm.map(c => `<li>${esc(c)}</li>`).join("")}</ol></div><div>
${chip(o.bg, "background")}${chip(o.fg, "foreground")}${o.accent ? chip(o.accent, "accent (confirm)") : "<small>no accent found: a person supplies it</small>"}
<div class=stage>${o.logo ? `<img src="${pathToFileURL(o.logo).href}">` : "<small>no logo found</small>"}<h3>${esc(o.h1.slice(0, 70) || "(no h1)")}</h3><p>Body in ${esc(font("body"))}${o.accent ? ` with <b>the accent</b>` : ""}</p></div>
<small>display ${esc(o.fonts.display ? `${o.fonts.display.from} → ${o.fonts.display.family}` : "unset")}<br>body ${esc(o.fonts.body ? `${o.fonts.body.from} → ${o.fonts.body.family}` : "unset")}</small></div>`;
}

export interface BrandDraft { brandFile: string; contact: string; confirm: string[] }

export async function brandFromUrl(rawUrl: string, outDir: string): Promise<BrandDraft> {
  const url = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`);
  if (!/^https?:$/.test(url.protocol)) throw new Error(`brand: expected an http(s) link, got ${url.protocol}`);
  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });

  // The existing URL capture (network on, motion clock, animations stopped) gives the page image the palette is sampled from.
  const sb = { source: { kind: "url", url: url.href, viewport: [1440, 900], dsf: 2 }, screens: {}, regions: [] } as unknown as Storyboard;
  await ingest(out, sb);
  const shot = join(out, "page.png");
  copyFileSync(join(out, sb.screens["S1"]!.file), shot);
  rmSync(join(out, "sources"), { recursive: true, force: true });
  const sampled = samplePalette(shot);

  const b = await launch((await pinnedShell()).path, { width: 1600, height: 900, network: true });
  let facts: PageFacts, contact = join(out, "contact.png"), logo: { file: string; from: string } | undefined, fonts: Partial<Record<"display" | "body" | "mono", FontMatch>> = {};
  try {
    await navigate(b, url.href);
    await b.evaluate(`document.fonts.ready.then(() => 0)`);
    facts = await b.evaluate<PageFacts>(READ_PAGE);
    logo = await saveLogo(facts, out);
    for (const r of ["display", "body", "mono"] as const) { const m = matchFont(facts.fonts[r], r); if (m) fonts[r] = m; }
    const bgFromTheme = facts.themeColors.map(t => toHex(t.content)).find(Boolean);
    const bg = toHex(facts.bg) ?? bgFromTheme ?? sampled.background, fg = toHex(facts.fg) ?? (sampled.accent_text === "#ffffff" ? "#ffffff" : "#000000");
    const accents = [...new Set([...facts.accentVars.map(toHex), sampled.accent === "#000000" ? undefined : sampled.accent].filter((c): c is string => !!c && c !== bg && c !== fg))];
    const accent = accents[0]; // samplePalette answers #000000 when the capture holds no saturated colour: that is "none found"

    const name = facts.siteName || facts.title.split(/\s[|–—-]\s/)[0]!.trim() || url.hostname.replace(/^www\./, "");
    const typo = Object.fromEntries(Object.entries(fonts).map(([r, f]) => [r, { family: f.family.replace(/ (SemiBold|Bold|Medium)$/, ""), read: f.from }]));
    const confirm = [
      accent ? `accent ${accent}: ${facts.accentVars.length ? "a CSS variable the page names accent/brand/primary" : "the commonest saturated colour in the capture"}; other candidates: ${accents.slice(1).join(", ") || "none"}. A person picks the accent.`
        : "accent: the page states none and its capture holds no saturated colour; a person supplies one (colors accent), or the theme's own accent is used.",
      `name "${name}": read from ${facts.siteName ? "og:site_name" : "the page title"}; confirm the spelling you want on the end card.`,
      logo ? `logo ${logo.file}: ${logo.from}. Confirm it is the right mark and that you may use it. If it already spells the name, crop its viewBox to the symbol: the end card prints the name too.` : "logo: none could be downloaded; supply a file and set \"logo\".",
      ...Object.values(fonts).filter(f => !f.exact).map(f => `font "${f.from}" is not bundled; the nearest bundled family is ${f.family.replace(/ (SemiBold|Bold|Medium)$/, "")}, which is not the brand's own face.`),
      "copy: write each beat of the brief yourself; the page's own words are listed in draft.copy_quotes. Figures are never read from a page: use only numbers the brand has published, or none.",
    ];
    const brand = {
      name,
      colors: [{ role: "background", hex: bg, from: toHex(facts.bg) ? "computed page background" : bgFromTheme ? "theme-color meta" : "capture" }, { role: "foreground", hex: fg, from: "computed h1 colour" }, ...(accent ? [{ role: "accent", hex: accent, from: "UNCONFIRMED" }] : [])],
      typography: typo, ...(logo ? { logo: logo.file } : {}),
      draft: { source: url.href, confirm, theme_colors: facts.themeColors, og_image: facts.ogImage, copy_quotes: [facts.h1, facts.description, facts.title].filter(Boolean) },
    };
    const brandFile = join(out, "brand.json");
    writeFileSync(brandFile, JSON.stringify(brand, null, 2) + "\n");
    // Say now whether the draft can render, so the person is not surprised later.
    const checks = (() => { try { return readBrand(brandFile, "story").warnings; } catch (e) { return [(e as Error).message]; } })();
    if (checks.length) { confirm.push(...checks.map(w => `render check: ${w}`)); brand.draft.confirm = confirm; writeFileSync(brandFile, JSON.stringify(brand, null, 2) + "\n"); }
    const html = join(out, ".contact.html");
    writeFileSync(html, contactHtml({ url: url.href, shot, bg, fg, ...(accent ? { accent } : {}), ...(logo ? { logo: join(out, logo.file) } : {}), fonts, h1: facts.h1, confirm }));
    await navigate(b, pathToFileURL(html).href);
    await b.evaluate(`document.fonts.ready.then(() => 0)`);
    const png = await b.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1600, height: 900, scale: 1 } });
    writeFileSync(contact, Buffer.from(png.data, "base64"));
    rmSync(html);
    return { brandFile, contact, confirm };
  } finally { await b.close(); }
}

export async function runBrand(argv: string[]): Promise<number> {
  const out = argv.indexOf("--out"), url = argv.find((a, i) => !a.startsWith("--") && i !== out + 1);
  if (!url || out < 0 || !argv[out + 1]) { console.error("takeone brand <url> --out DIR   read a brand link into DIR/brand.json (a draft), logo and contact.png"); return 2; }
  const d = await brandFromUrl(url, argv[out + 1]!);
  console.log(`${d.brandFile}\n${d.contact}\n\nDRAFT. A person confirms before any ad is made:\n${d.confirm.map((c, i) => `${i + 1}. ${c}`).join("\n")}`);
  return 0;
}
