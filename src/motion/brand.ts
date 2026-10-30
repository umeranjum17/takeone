// A brand file in, validated theme overrides out: `--brand brand.json|DESIGN.md` for a take render or the glow recipe.
// The file is read on this machine only (no network, no model call). Colours become the render's overrides, fonts must be
// ones TakeOne bundles or a font file the file carries (an unknown family is an error, never a quiet fallback), and an
// optional logo image rides the glow end card.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { fontManifest } from "./theme.ts";

export const BRAND_ROLES = ["background", "surface", "foreground", "muted", "border", "accent", "accent-secondary"] as const;
type Role = (typeof BRAND_ROLES)[number];
/** Names a hand-written file may use for a role. */
const ROLE_ALIASES: Record<string, Role> = { bg: "background", text: "foreground", primary: "accent", card: "surface", line: "border" };
export const LOGO_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".svg"];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export interface Brand {
  /** The brand's name, used as the end card wordmark when --logo is not given. */
  name?: string;
  /** Validated theme.overrides: only the keys the file set (and the render stage accepts). */
  overrides: Record<string, string>;
  /** Absolute paths of the font files the file carries, for the render's font directory. */
  fonts?: string[];
  /** Absolute path of the logo image, when the file names one. */
  logo?: string;
  file: string;
}

const hexOf = (v: unknown, path: string): string => {
  const m = typeof v === "string" ? /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim()) : null;
  if (!m) throw new Error(`brand ${path}: expected a #rgb or #rrggbb colour, got ${JSON.stringify(v)}`);
  const h = m[1]!.toLowerCase();
  return "#" + (h.length === 3 ? [...h].map(c => c + c).join("") : h);
};

/** Relative luminance (WCAG) of #rrggbb. */
export function luminance(hex: string): number {
  const lin = [1, 3, 5].map(i => { const v = parseInt(hex.slice(i, i + 2), 16) / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The YAML subset a DESIGN.md frontmatter uses: `key: value` and one level of nested `  key: value`. */
function frontmatter(text: string, file: string): { top: Record<string, string>; maps: Record<string, Record<string, string>> } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const top: Record<string, string> = {}, maps: Record<string, Record<string, string>> = {};
  if (lines[0]?.trim() !== "---") return { top, maps };
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error(`brand ${file}: the frontmatter opens with --- but never closes`);
  const scalar = (v: string): string => {
    const s = v.trim(), q = s[0];
    if ((q === '"' || q === "'") && s.length >= 2 && s.endsWith(q)) return q === '"' ? s.slice(1, -1).replace(/\\(["\\])/g, "$1") : s.slice(1, -1);
    return s;
  };
  let open: string | undefined;
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = /^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, indent, key, value] = m as unknown as [string, string, string, string];
    if (!indent) {
      if (value.trim()) { top[key] = scalar(value); open = undefined; } else { open = key; maps[key] = {}; }
    } else if (open) maps[open]![key] = scalar(value);
  }
  return { top, maps };
}

/** `| accent | Teal | `#19c9a5` | usage |` rows of a DESIGN.md Color Palette table: role -> hex. */
function paletteTable(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^\|\s*([a-z-]+)\s*\|[^|\n]*\|\s*`?(#[0-9a-fA-F]{3,6})`?\s*\|/gm)) {
    const role = ROLE_ALIASES[m[1]!] ?? m[1]!;
    if ((BRAND_ROLES as readonly string[]).includes(role) && !(role in out)) out[role] = m[2]!;
  }
  return out;
}

/** The family name out of a CSS-style value: first entry of a stack, unquoted. */
const familyOf = (v: unknown, path: string): string => {
  const raw = typeof v === "object" && v !== null && "family" in v ? (v as { family: unknown }).family : v;
  if (typeof raw !== "string") throw new Error(`brand ${path}: expected a font family name`);
  const name = raw.split(",")[0]!.trim().replace(/^["']|["']$/g, "").trim();
  if (!name) throw new Error(`brand ${path}: expected a font family name`);
  return name;
};

export const FONT_EXTENSIONS = [".ttf", ".otf"];
const MAX_FONT_BYTES = 32 * 1024 * 1024;

/** The names inside a font's `name` table (family, full name, typographic family): what libass matches a family against. */
export function fontNames(file: string): string[] {
  const buf = readFileSync(file), tag = buf.toString("latin1", 0, 4);
  if (tag === "wOF2" || tag === "wOFF") throw new Error(`brand font ${file}: a web font (woff) is not a font a render can use; give the .ttf or .otf`);
  if (tag === "ttcf") throw new Error(`brand font ${file}: a font collection is not supported; name one .ttf or .otf`);
  if (buf.length < 12) throw new Error(`brand font ${file}: not a TrueType or OpenType font`);
  const tables = buf.readUInt16BE(4);
  let at = -1;
  for (let i = 0; i < tables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > buf.length) break;
    if (buf.toString("latin1", rec, rec + 4) === "name") at = buf.readUInt32BE(rec + 8);
  }
  if (at < 0 || at + 6 > buf.length) throw new Error(`brand font ${file}: no name table, so its family cannot be read`);
  const count = buf.readUInt16BE(at + 2), strings = at + buf.readUInt16BE(at + 4);
  const found: { id: number; rank: number; text: string }[] = [];
  for (let i = 0; i < count; i++) {
    const rec = at + 6 + i * 12;
    const [platform, , language, id, length, offset] = [0, 2, 4, 6, 8, 10].map(d => buf.readUInt16BE(rec + d)) as [number, number, number, number, number, number];
    if (![1, 4, 16].includes(id) || length < 2) continue;
    const bytes = buf.subarray(strings + offset, strings + offset + (length & ~1));
    const text = (platform === 1 ? bytes.toString("latin1") : Buffer.from(bytes).swap16().toString("utf16le").replace(/\u0000/g, "")).replace(/\s+/g, " ").trim();
    if (text) found.push({ id, rank: (platform === 3 || platform === 0 ? 0 : 2) + (language === 0x409 ? 0 : 1), text });
  }
  // Typographic family first, then family, then full name; Windows/English spellings ahead of the rest.
  found.sort((a, b) => (a.id === 16 ? 0 : a.id === 1 ? 1 : 2) - (b.id === 16 ? 0 : b.id === 1 ? 1 : 2) || a.rank - b.rank);
  const names = [...new Set(found.map(f => f.text))];
  if (!names.length) throw new Error(`brand font ${file}: its name table has no family name`);
  return names;
}

/** A family a font file carries, as a value an ASS style may name (plain words only). */
function fontFamily(names: string[], file: string): string {
  const name = names.find(n => /^[A-Za-z0-9 ]{1,64}$/.test(n));
  if (!name) throw new Error(`brand font ${basename(file)}: its family ${JSON.stringify(names[0])} has characters a caption style cannot name; give it a plain name (letters, digits and spaces)`);
  return name;
}

const SUFFIXES: Record<"display" | "body" | "mono", string[]> = {
  display: ["", " Bold", " ExtraBold", " SemiBold", " Medium"],
  body: ["", " Medium", " SemiBold", " Bold"],
  mono: ["", " Bold"],
};

/** The bundled family that carries `family` in this role, else an error naming the bundled families. */
export function bundledFont(family: string, role: "display" | "body" | "mono"): string {
  const have = fontManifest().map(f => f.family);
  for (const suffix of SUFFIXES[role]) {
    const hit = have.find(f => f.toLowerCase() === (family + suffix).toLowerCase());
    if (hit) return hit;
  }
  const names = [...new Set(have.map(f => f.replace(/ (SemiBold|Bold|ExtraBold Expanded|Medium)$/, "")))].sort();
  throw new Error(`brand typography.${role}: "${family}" is not a font TakeOne bundles (no fallback is used); bundled families: ${names.join(", ")}`);
}

function logoPath(v: unknown, dir: string): string | undefined {
  const raw = typeof v === "object" && v !== null && "primary" in v ? (v as { primary: unknown }).primary : v;
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") throw new Error("brand logo: expected a path to an image file");
  const file = isAbsolute(raw) ? raw : resolve(dir, raw);
  if (!LOGO_EXTENSIONS.includes(extname(file).toLowerCase())) throw new Error(`brand logo: ${raw} must be one of ${LOGO_EXTENSIONS.join(", ")}`);
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`brand logo: ${file} does not exist`);
  if (statSync(file).size > MAX_LOGO_BYTES) throw new Error(`brand logo: ${file} is over ${MAX_LOGO_BYTES / 1024 / 1024} MB`);
  if (extname(file).toLowerCase() === ".svg" && /<script|<foreignObject|(?:href|src)\s*=\s*(?!["']?(?:#|data:))|url\(\s*(?!["']?(?:#|data:))/i.test(readFileSync(file, "utf8"))) {
    throw new Error(`brand logo: ${file} is an SVG with a script or an external reference; the page renders offline`);
  }
  return file;
}

/** Tokens a take render accepts: the stage colours and the two typefaces its text uses. */
const TAKE_KEYS = ["background", "background_to", "accent", "text", "card", "border_color", "shadow_color", "display_font", "caption_font"];

/** Read `brand.json` (colors, typography, logo, name) or a DESIGN.md (frontmatter colors, Typography lines) into render overrides.
 * `stage` picks the consumer: glow's dark stage, or a take render (which takes any background lightness and only its own tokens). */
export function readBrand(file: string, stage: "glow" | "take" = "glow"): Brand {
  const path = resolve(file);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`--brand ${file}: no such file`);
  const text = readFileSync(path, "utf8"), dir = dirname(path);
  const json = extname(path).toLowerCase() === ".json";
  if (!json && extname(path).toLowerCase() !== ".md") throw new Error(`--brand ${file}: expected brand.json or DESIGN.md`);

  let name: unknown, logo: unknown;
  const colours: Record<string, unknown> = {}, fonts: Partial<Record<"display" | "body" | "mono", unknown>> = {};
  const colour = (role: string, v: unknown, where: string) => {
    const r = ROLE_ALIASES[role] ?? role;
    if (!(BRAND_ROLES as readonly string[]).includes(r)) return;
    colours[r] = hexOf(v, where);
  };
  if (json) {
    let doc: unknown;
    try { doc = JSON.parse(text); } catch (e) { throw new Error(`--brand ${file}: not valid JSON (${(e as Error).message})`); }
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error(`--brand ${file}: expected a JSON object`);
    const d = doc as Record<string, unknown>;
    name = d["name"]; logo = d["logo"];
    const seed = typeof d["seed"] === "object" && d["seed"] !== null ? d["seed"] as Record<string, unknown> : {};
    for (const [role, key] of [["accent", "colorPrimary"], ["background", "colorBgBase"], ["foreground", "colorTextBase"]] as const) if (seed[key] !== undefined) colour(role, seed[key], `seed.${key}`);
    const list = d["colors"];
    if (Array.isArray(list)) list.forEach((c, i) => {
      if (typeof c !== "object" || c === null) throw new Error(`brand colors[${i}]: expected {role, hex}`);
      const { role, hex } = c as Record<string, unknown>;
      if (typeof role === "string") colour(role, hex, `colors[${i}].hex`);
    });
    else if (typeof list === "object" && list !== null) for (const [role, hex] of Object.entries(list)) colour(role, hex, `colors.${role}`);
    const typo = d["typography"];
    if (typeof typo === "object" && typo !== null) for (const k of ["display", "body", "mono"] as const) fonts[k] = (typo as Record<string, unknown>)[k];
    if (fonts.body === undefined && typeof seed["fontFamily"] === "string") fonts.body = seed["fontFamily"];
    if (fonts.mono === undefined && typeof seed["fontFamilyCode"] === "string") fonts.mono = seed["fontFamilyCode"];
  } else {
    const { top, maps } = frontmatter(text, file);
    name = top["name"] ?? /^#\s+(.+)$/m.exec(text)?.[1]; logo = top["logo"];
    for (const [role, hex] of Object.entries(paletteTable(text))) colour(role, hex, `Color Palette ${role}`);
    for (const [role, hex] of Object.entries(maps["colors"] ?? {})) colour(role, hex, `colors.${role}`);
    for (const k of ["display", "body", "mono"] as const) {
      const line = new RegExp(`^[-*]\\s*\\*\\*${k}:\\*\\*\\s*(.+?)(?:\\s+(?:—|--|-)\\s+.*)?$`, "im").exec(text)?.[1];
      fonts[k] = maps["typography"]?.[k] ?? line;
    }
  }

  const c = colours as Partial<Record<Role, string>>;
  const overrides: Record<string, string> = {};
  const set = (keys: string[], v: string | undefined) => { if (v) for (const k of keys) overrides[k] = v; };
  set(["background", "background_to", "page"], c.background);
  set(["card"], c.surface);
  set(["text", "ink"], c.foreground);
  set(["muted"], c.muted);
  set(["border_color", "line"], c.border);
  set(["accent"], c.accent);
  const files: string[] = [];
  for (const [k, key] of [["display", "display_font"], ["body", "caption_font"], ["mono", "mono_font"]] as const) {
    if (fonts[k] === undefined) continue;
    const where = `typography.${k}`;
    const spec = typeof fonts[k] === "object" && fonts[k] !== null ? (fonts[k] as { file?: unknown }).file : fonts[k];
    const isFile = typeof spec === "string" && FONT_EXTENSIONS.includes(extname(spec).toLowerCase());
    if (!isFile) { overrides[key] = bundledFont(familyOf(fonts[k], where), k); continue; }
    // A font file the take carries: it goes into the render's font directory, and the family the brand
    // names must be the one inside it, or the type would quietly render in another face.
    const fontFile = isAbsolute(spec as string) ? (spec as string) : resolve(dir, spec as string);
    if (!existsSync(fontFile) || !statSync(fontFile).isFile()) throw new Error(`brand ${where}: font file ${fontFile} does not exist`);
    if (statSync(fontFile).size > MAX_FONT_BYTES) throw new Error(`brand ${where}: font file ${fontFile} is over ${MAX_FONT_BYTES / 2 ** 20} MB`);
    const names = fontNames(fontFile);
    const asked = typeof fonts[k] === "object" && fonts[k] !== null ? (fonts[k] as { family?: unknown }).family : undefined;
    const wanted = asked === undefined ? undefined : familyOf(fonts[k], where);
    if (wanted !== undefined && !names.some(n => n.toLowerCase() === wanted.toLowerCase())) {
      throw new Error(`brand ${where}: "${wanted}" is not the family inside ${basename(fontFile)} (it carries ${names.slice(0, 3).map(n => `"${n}"`).join(", ")}); no fallback is used, so the render would show another face`);
    }
    overrides[key] = fontFamily(wanted === undefined ? names : [wanted, ...names], fontFile);
    files.push(fontFile);
  }

  // Glow is a dark-stage recipe: white type and a lit accent on the background. Say so instead of rendering unreadable.
  const bg = overrides["background"] ?? "#030719";
  if (stage === "glow" && c.background && contrast(bg, "#ffffff") < 7) throw new Error(`brand background ${bg} is too light for the glow recipe's dark stage (contrast against white ${contrast(bg, "#ffffff").toFixed(1)}:1, needs 7:1 or more); give it a darker background colour`);
  if (c.foreground && contrast(c.foreground, bg) < 4.5) throw new Error(`brand foreground ${c.foreground} on background ${bg} reads at ${contrast(c.foreground, bg).toFixed(1)}:1; the type needs 4.5:1`);
  if (c.accent && contrast(c.accent, bg) < 3) throw new Error(`brand accent ${c.accent} on background ${bg} reads at ${contrast(c.accent, bg).toFixed(1)}:1; the lit controls need 3:1`);

  const mark = logoPath(logo, dir);
  const label = typeof name === "string" && name.trim() ? name.trim() : undefined;
  if (!Object.keys(overrides).length && !mark) throw new Error(`--brand ${file}: no colours, fonts or logo found; expected brand.json (colors, typography, logo) or DESIGN.md (frontmatter colors, a Typography section)`);
  const kept = stage === "take" ? Object.fromEntries(Object.entries(overrides).filter(([k]) => TAKE_KEYS.includes(k))) : overrides;
  // A take's stage paints bg_stops whenever it has them, so a brand background without this would be
  // invisible: the brand's own colour is the stage, not the default theme's four mesh pools.
  if (stage === "take" && kept["background"]) kept["bg_stops"] = "";
  if (stage === "take" && !Object.keys(kept).length) throw new Error(`--brand ${file}: nothing in it dresses a take render; a take takes a background, surface, foreground, border, accent and display/body typeface`);
  return { ...(label ? { name: label } : {}), overrides: kept, ...(files.length ? { fonts: [...new Set(files)] } : {}), ...(mark ? { logo: mark } : {}), file: path };
}
