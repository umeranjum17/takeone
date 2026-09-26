// takeone CLI. This slice implements `make` (pipeline steps 1-3); record and
// render arrive from their own lanes.

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { makeTake, PreflightRefusal } from "./make.ts";

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

  Turns a recorded take into beats and camera decisions (pipeline steps 1-3).
  Steps 4-5 (shoot, render) are built by another slice.

  --no-jev        decide every beat with the local heuristic; zero network calls
  --about         optional demo topic; adds the key_moment question
  --screen-text   opt-in: send up to 12 redacted OCR words per zone plus the window title
  --max-tokens    refuse above this many planned input tokens (default 40k x take minutes)`);
  process.exit(code);
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") usage(cmd ? 0 : 2);
  if (cmd !== "make") {
    console.error(
      `takeone: unknown command "${cmd}". This slice provides "make"; "record" and the renderer are separate lanes.`,
    );
    return 2;
  }
  const a = parseArgs(rest);
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
    if (e instanceof PreflightRefusal) {
      console.error(`takeone make: ${e.message}`);
      return 2;
    }
    throw e;
  }
}
