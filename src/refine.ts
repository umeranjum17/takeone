// `takeone zoom` and `takeone look`: edit a take's zooms and keep named looks, no keyframes.
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ManualZoom } from "./camera/types.ts";
import { validateZooms } from "./render/edits.ts";
import { takeoneConfigDir } from "./secrets.ts";

export const REFINE_USAGE = `takeone zoom <take> list
takeone zoom <take> add <from-s> <to-s> <x,y,w,h> [--level 0-3]
takeone zoom <take> move <n> [--from S] [--to S] [--box x,y,w,h] [--level 0-3]
takeone zoom <take> remove <n>
takeone look save <name> [--theme T] [--aspect A] [--set key=value]...
takeone look list|show <name>|remove <name>
takeone render <take-dir> --look <name>

  zoom edits the take's saved zooms (source seconds, source-pixel box); run takeone render to see them.
  look keeps a theme, aspect and --set pairs under a name; render --look applies it, and options after it win.`;

function readTake(dir: string): { path: string; text: string; meta: Record<string, unknown> } {
  const path = join(dir, "take.json");
  if (!existsSync(path)) throw Error(`no take at ${dir} (take.json missing)`);
  const text = readFileSync(path, "utf8");
  return { path, text, meta: JSON.parse(text) as Record<string, unknown> };
}

function sourceSize(meta: Record<string, unknown>): [number, number] {
  const s = (meta["stream"] as { w?: number; h?: number } | undefined) ?? { w: meta["width"] as number, h: meta["height"] as number };
  if (typeof s.w !== "number" || typeof s.h !== "number") throw Error("take.json has no source size");
  return [s.w, s.h];
}

const num = (v: string | undefined, what: string): number => {
  const n = Number(v);
  if (v === undefined || v === "" || !Number.isFinite(n)) throw Error(`${what} needs a number, got ${v ?? "nothing"}`);
  return n;
};
const box = (v: string | undefined): ManualZoom["bbox"] => {
  const p = (v ?? "").split(",");
  if (p.length !== 4) throw Error(`box needs x,y,w,h in source pixels, got ${v ?? "nothing"}`);
  return p.map(s => num(s, "box")) as ManualZoom["bbox"];
};
const level = (v: string): NonNullable<ManualZoom["level"]> => {
  const n = num(v, "--level");
  if (![0, 1, 2, 3].includes(n)) throw Error("--level must be 0 (whole screen), 1, 2 or 3");
  return n as 0 | 1 | 2 | 3;
};

/** Flags after the positional words; every flag takes one value. */
function flags(args: string[], allowed: string[]): { words: string[]; opt: Record<string, string> } {
  const words: string[] = [], opt: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) { words.push(a); continue; }
    if (!allowed.includes(a)) throw Error(`unknown option ${a}`);
    const v = args[++i];
    if (v === undefined) throw Error(`${a} needs a value`);
    opt[a] = v;
  }
  return { words, opt };
}

const line = (z: ManualZoom, i: number) => `${i + 1}  ${z.t0}s-${z.t1}s  box ${z.bbox.join(",")}  level ${z.level ?? 2}`;

/** Edit or list a take's zooms; returns the lines to print. */
export function runZoom(dir: string, args: string[]): string[] {
  const [verb, ...rest] = args;
  const { path, text, meta } = readTake(dir);
  const [w, h] = sourceSize(meta);
  const zooms = [...((meta["zooms"] as ManualZoom[] | undefined) ?? [])].sort((a, b) => a.t0 - b.t0);
  if (verb === "list") return zooms.length ? zooms.map(line) : ["no zooms; the planner frames this take"];
  const { words, opt } = flags(rest, ["--level", "--from", "--to", "--box"]);
  let message: string;
  if (verb === "add") {
    if (words.length !== 3) throw Error("usage: takeone zoom <take> add <from-s> <to-s> <x,y,w,h> [--level 0-3]");
    const z: ManualZoom = { t0: num(words[0], "from"), t1: num(words[1], "to"), bbox: box(words[2]), level: opt["--level"] === undefined ? 2 : level(opt["--level"]) };
    zooms.push(z);
    message = `added zoom ${z.t0}s-${z.t1}s`;
  } else if (verb === "move" || verb === "remove") {
    if (words.length !== 1) throw Error(`usage: takeone zoom <take> ${verb} <n>`);
    const i = num(words[0], "n") - 1;
    if (!Number.isInteger(i) || i < 0 || i >= zooms.length) throw Error(`no zoom ${words[0]}; this take has ${zooms.length} (takeone zoom <take> list)`);
    if (verb === "remove") { zooms.splice(i, 1); message = `removed zoom ${i + 1}`; }
    else {
      const z = zooms[i]!;
      if (opt["--from"] !== undefined) z.t0 = num(opt["--from"], "--from");
      if (opt["--to"] !== undefined) z.t1 = num(opt["--to"], "--to");
      if (opt["--box"] !== undefined) z.bbox = box(opt["--box"]);
      if (opt["--level"] !== undefined) z.level = level(opt["--level"]);
      message = `moved zoom ${i + 1}`;
    }
  } else throw Error(`unknown zoom command ${verb ?? ""}; use list, add, move or remove`);
  validateZooms(zooms, w, h);
  zooms.sort((a, b) => a.t0 - b.t0);
  const next = { ...meta, zooms };
  if (!zooms.length) delete (next as { zooms?: unknown }).zooms;
  writeFileSync(path, JSON.stringify(next, null, text.startsWith("{\n") ? 2 : 0) + (text.endsWith("\n") ? "\n" : ""));
  return [message, ...zooms.map(line), `run: takeone render ${dir}`];
}

export interface Look { theme?: string; aspect?: string; set: string[] }
const looksFile = () => join(takeoneConfigDir(), "looks.json");
function readLooks(): Record<string, Look> {
  try { return JSON.parse(readFileSync(looksFile(), "utf8")) as Record<string, Look>; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw Error(`${looksFile()}: ${(e as Error).message}`); }
}

/** The render arguments a saved look stands for. */
export function lookArgs(name: string): string[] {
  const look = readLooks()[name];
  if (!look) throw Error(`no look named ${name}; saved looks: ${Object.keys(readLooks()).join(", ") || "none"}`);
  return [...(look.theme ? ["--theme", look.theme] : []), ...(look.aspect ? ["--aspect", look.aspect] : []), ...look.set.flatMap(p => ["--set", p])];
}

/** `check` rejects a bad aspect or theme before anything is saved. */
export function runLook(args: string[], check: (look: Look) => void): string[] {
  const [verb, ...rest] = args;
  const looks = readLooks();
  if (verb === "list") return Object.keys(looks).length ? Object.keys(looks) : ["no saved looks; takeone look save <name> --theme T"];
  const name = rest[0];
  if (!name || name.startsWith("--") || !/^[\w.-]+$/.test(name)) throw Error(`usage: takeone look ${verb ?? "save"} <name> (letters, digits, . _ -)`);
  if (verb === "show") return [JSON.stringify(looks[name] ?? (() => { throw Error(`no look named ${name}`); })(), null, 2)];
  if (verb === "remove") {
    if (!looks[name]) throw Error(`no look named ${name}`);
    delete looks[name];
  } else if (verb === "save") {
    const look: Look = { set: [] };
    for (let i = 1; i < rest.length; i += 2) {
      const [o, v] = [rest[i], rest[i + 1]];
      if (v === undefined || v.startsWith("--")) throw Error(`${o} needs a value`);
      if (o === "--theme") look.theme = v;
      else if (o === "--aspect") look.aspect = v;
      else if (o === "--set") look.set.push(v);
      else throw Error(`unknown option ${o}`);
    }
    if (!look.theme && !look.aspect && !look.set.length) throw Error("a look needs --theme, --aspect or --set");
    check(look);
    looks[name] = look;
  } else throw Error(`unknown look command ${verb ?? ""}; use save, list, show or remove`);
  mkdirSync(takeoneConfigDir(), { recursive: true });
  writeFileSync(looksFile(), JSON.stringify(looks, null, 2) + "\n");
  return [`${verb === "save" ? "saved" : "removed"} look ${name}`];
}
