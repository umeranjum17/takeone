#!/usr/bin/env node
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { makeTake, PreflightRefusal, TakeInputError } from "./make.ts";
import { renderTake } from "./render/render.ts";
import { applyOverrides } from "./camera/defaults.ts";

export function takesDir(): string {
  return process.env["TAKEONE_DIR"] ?? join(homedir(), "Videos", "takeone");
}

interface Args {
  id?: string;
  noJev: boolean;
  about?: string;
  screenText: boolean;
  maxTokens?: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { noJev: false, screenText: false };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i]!;
    if (s === "--no-jev") a.noJev = true;
    else if (s === "--about") a.about = argv[++i];
    else if (s === "--screen-text") a.screenText = true;
    else if (s === "--max-tokens") a.maxTokens = Number(argv[++i]);
    else if (!s.startsWith("--") && a.id === undefined) a.id = s;
    else if (s === "--help" || s === "-h") usage(0);
    else {
      console.error(`unknown option: ${s}`);
      usage(2);
    }
  }
  return a;
}

function usage(code: number): never {
  console.error(`takeone make <id> [--no-jev] [--about "<topic>"] [--screen-text] [--max-tokens N]
takeone render <take-dir> [--set key=value]

  make plans beats and camera decisions, then renders an MP4.
  render creates a camera path and MP4 from a planned take.

  --no-jev        decide every beat with the local heuristic; zero network calls
  --about         optional demo topic; adds the key_moment question
  --screen-text   opt-in: send up to 12 redacted OCR words per zone plus the window title
  --max-tokens    refuse above this many planned input tokens (default 40k x take minutes)`);
  process.exit(code);
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") usage(cmd ? 0 : 2);
  if (cmd === "render") {
    const [dir, ...args] = rest;
    if (!dir) { console.error("usage: takeone render <take-dir>"); return 2; }
    try {
      const overrides: Record<string, number | string> = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== "--set") throw Error(`unknown option ${args[i]}`);
        const value = args[++i];
        const match = /^([^=]+)=([^=]+)$/.exec(value ?? "");
        if (!match) throw Error(`invalid --set ${value}`);
        const [, k, v] = match;
        const n = Number(v);
        overrides[k!] = k === "background" ? v! : Number.isFinite(n) ? n : NaN;
      }
      console.log(await renderTake(dir, applyOverrides(overrides)));
      return 0;
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      return 1;
    }
  }
  if (cmd !== "make") {
    console.error(`takeone: unknown command "${cmd}". Use "make" or "render".`);
    return 2;
  }
  const a = parseArgs(rest);
  if (a.maxTokens !== undefined && (!Number.isSafeInteger(a.maxTokens) || a.maxTokens <= 0)) {
    console.error("takeone make: --max-tokens must be a positive integer");
    return 2;
  }
  if (!a.id) {
    console.error("takeone make: missing take id");
    usage(2);
  }
  const dir = /^\//.test(a.id) ? a.id : join(takesDir(), a.id);
  if (!existsSync(join(dir, "take.json"))) {
    console.error(`takeone make: no take at ${dir} (take.json missing)`);
    return 2;
  }
  try {
    await makeTake(dir, a);
    return 0;
  } catch (e) {
    if (e instanceof PreflightRefusal || e instanceof TakeInputError) {
      console.error(`takeone make: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; },
  );
}
