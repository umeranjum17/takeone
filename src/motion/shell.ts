// The one Chromium build motion renders are proved deterministic on. Any other build or version needs the
// determinism gate re-run before the pin moves.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const SHELL_VERSION = "151.0.7922.34";
export const SHELL_ARCHIVE_SHA256 = "3cfc2bd00d1bafcf8a68dc74c9c92bb7150ddc8d26ade948a776316e1cec4f14";
export const SHELL_SHA256 = "e11fc9ce65c96313476f7ee9844b6fb6a9220fb048693cfe9eee00acf4170a9f";
const ARCHIVE_URL = `https://storage.googleapis.com/chrome-for-testing-public/${SHELL_VERSION}/linux64/chrome-headless-shell-linux64.zip`;
const BIN = "chrome-headless-shell-linux64/chrome-headless-shell";

export function shellCache(): string {
  return join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "takeone", "headless-shell", SHELL_VERSION);
}

/** Where a pinned shell may already live: explicit env, TakeOne's cache, or Playwright's cache of the same build. */
export function shellCandidates(): string[] {
  const env = process.env["TAKEONE_CHROME"];
  return [
    ...(env ? [env] : []),
    join(shellCache(), BIN),
    join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1234", BIN),
  ];
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const data of createReadStream(path)) hash.update(data as Buffer);
  return hash.digest("hex");
}

export interface Shell { path: string; version: string; sha256: string }

/** The first candidate whose sha256 and version both match the pin; throws with an install hint otherwise. */
export async function pinnedShell(): Promise<Shell> {
  const seen: string[] = [];
  for (const path of shellCandidates()) {
    if (!existsSync(path)) continue;
    const sha = await sha256File(path);
    if (sha !== SHELL_SHA256) { seen.push(`${path}: sha256 ${sha.slice(0, 12)}… is not the pin`); continue; }
    const version = execFileSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
    if (!version.endsWith(SHELL_VERSION)) { seen.push(`${path}: ${version}`); continue; }
    return { path, version: SHELL_VERSION, sha256: sha };
  }
  throw new Error(`pinned chrome-headless-shell ${SHELL_VERSION} not found${seen.length ? ` (${seen.join("; ")})` : ""}; run \`takeone motion install-shell\``);
}

/** Download the pinned build, check the archive and binary sha256, and unpack it into TakeOne's cache. */
export async function installShell(): Promise<Shell> {
  try { return await pinnedShell(); } catch { /* fetch a verified copy */ }
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("the pinned motion shell is Linux x86_64 only");
  const dir = shellCache();
  await mkdir(join(dir, ".."), { recursive: true });
  const temp = await mkdtemp(join(dir, "..", ".install-"));
  try {
    const archive = join(temp, "shell.zip");
    const response = await fetch(ARCHIVE_URL, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error(`shell download failed: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(archive));
    if (await sha256File(archive) !== SHELL_ARCHIVE_SHA256) throw new Error("shell archive sha256 mismatch");
    execFileSync("unzip", ["-q", archive, "-d", join(temp, "unpacked")]);
    await rm(dir, { recursive: true, force: true });
    await rename(join(temp, "unpacked"), dir);
    return await pinnedShell();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
