// Demo options and polish rounds on the sign-off board. Every option is a design card option whose mock is a small
// page that plays the cut in place (phone and desktop) beside its judge score; the board opens it full screen. The
// board serves the files beside a mock up to 5 MB each, so each cut goes up as a board copy that fits.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runFfmpeg } from "../render/ffmpeg.ts";
import { renderThreads } from "../render/render.ts";
import { cutPage, type CutPageData } from "./page.ts";

/** The board refuses a file beside a mock above this many bytes. */
export const BOARD_MEDIA_BYTES = 5_000_000;
/** Widths the board copy steps down through until it fits, with the quality it encodes at. */
const STEPS: [number, number][] = [[1280, 26], [1280, 30], [960, 30], [854, 32], [640, 34]];

/** The sign-off CLI: TAKEONE_SIGN_OFF when set (tests point it at a fake), else sign-off-axi on PATH. */
export function signOffBin(): string {
  return process.env.TAKEONE_SIGN_OFF || "sign-off-axi";
}

function signOff(args: string[]): string {
  try {
    return execFileSync(signOffBin(), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string };
    throw new Error(`sign-off ${args[0]}: ${(err.stdout || err.stderr || err.message).trim().split("\n").slice(0, 6).join(" ")}`);
  }
}

/** A copy of the cut the board can serve: H.264, fast start, under the board's file cap; and a poster still. */
export async function boardCopy(film: string, video: string, poster: string, posterAt: number): Promise<{ bytes: number; width: number }> {
  mkdirSync(dirname(video), { recursive: true });
  const threads = renderThreads();
  let bytes = Infinity;
  let width = 0;
  for (const [w, crf] of STEPS) {
    await runFfmpeg(["-y", "-v", "error", "-threads", threads, "-i", film, "-filter_threads", "2", "-vf", `scale='min(${w},iw)':-2:flags=lanczos`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p", "-profile:v", "high", "-threads", threads,
      "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", video]);
    bytes = statSync(video).size;
    width = w;
    if (bytes <= BOARD_MEDIA_BYTES) break;
  }
  if (bytes > BOARD_MEDIA_BYTES) throw new Error(`the board copy of ${film} is still ${(bytes / 1e6).toFixed(1)} MB at ${width} px wide; the board serves at most ${BOARD_MEDIA_BYTES / 1e6} MB`);
  await runFfmpeg(["-y", "-v", "error", "-ss", Math.max(0, posterAt).toFixed(2), "-i", film, "-frames:v", "1", "-update", "1",
    "-vf", "scale='min(1280,iw)':-2", "-q:v", "4", poster]);
  return { bytes, width };
}

export interface BoardOption {
  value: string;
  label: string;
  film: string;
  /** Output second the poster still is taken at. */
  posterAt: number;
  page: Omit<CutPageData, "video" | "poster">;
}

export interface BoardCard {
  board: string;
  key: string;
  title: string;
  tradeoff: string;
  recommend: string;
  filer: string;
  options: BoardOption[];
}

/** Write each option's board copy, poster and page beside the board, then post the design card. */
export async function postCard(card: BoardCard, log: (line: string) => void): Promise<void> {
  if (card.options.length < 2 || card.options.length > 6) throw new Error(`a design card takes 2 to 6 options, not ${card.options.length}`);
  const root = dirname(card.board);
  const folder = join("mocks", card.key);
  mkdirSync(join(root, folder), { recursive: true });
  const args = ["post", card.board, "--type", "design", "--key", card.key, "--title", card.title, "--tradeoff", card.tradeoff,
    "--recommend", card.recommend, "--filer", card.filer];
  for (const o of card.options) {
    const copy = await boardCopy(o.film, join(root, folder, `${o.value}.mp4`), join(root, folder, `${o.value}.jpg`), o.posterAt);
    writeFileSync(join(root, folder, `${o.value}.html`), cutPage({ ...o.page, video: `${o.value}.mp4`, poster: `${o.value}.jpg` }));
    log(`board: option ${o.value} - ${(copy.bytes / 1e6).toFixed(1)} MB board copy at ${copy.width} px`);
    args.push("--option", `${o.value}=${o.label}`, "--mock", `${o.value}=${folder}/${o.value}.html`);
  }
  signOff(args);
  log(`board: posted "${card.title}" (${card.key}) to ${card.board}`);
}

/** Move a card the newer one replaces to the board's archive. A card already gone is not an error. */
export function replaceCard(board: string, key: string, log: (line: string) => void): void {
  try {
    signOff(["dismiss", key, board, "--reason", "replaced"]);
    log(`board: archived ${key} (replaced by the newer card)`);
  } catch (e) {
    log(`board: could not archive ${key}: ${e instanceof Error ? e.message : e}`);
  }
}

export interface BoardAnswer {
  answer?: string;
  label?: string;
  note?: string;
  at?: string;
  rounds?: { note?: string; at?: string }[];
}

/** The owner's answer on a card, or null while it is unanswered. */
export function cardAnswer(board: string, key: string): BoardAnswer | null {
  const out = JSON.parse(signOff(["answers", board, "--key", key, "--json"]) || "{}") as Record<string, BoardAnswer>;
  return out[key] ?? null;
}

/** The notes the owner left on a card, oldest first: the answer's note and each later round's. */
export function cardNotes(answer: BoardAnswer | null): string[] {
  if (!answer) return [];
  return [answer.note, ...(answer.rounds ?? []).map((r) => r.note)].filter((n): n is string => typeof n === "string" && n.trim().length > 0).map((n) => n.trim());
}

/** The board file a command posts to: --board, else TAKEONE_BOARD; none means nothing is posted. */
export function boardFile(flag: string | undefined): string | undefined {
  const file = flag ?? process.env.TAKEONE_BOARD;
  if (file && !existsSync(file)) throw new Error(`no sign-off board at ${file}; create one with \`sign-off-axi init\``);
  return file || undefined;
}
