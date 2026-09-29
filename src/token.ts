/**
 * Single-use portal restore token: atomic persist (0600) and consume-before-
 * reuse. The portal hands a new token per session; a saved token is burned the
 * moment it is read, so a crash cannot leave a stale token that silently fails.
 */

import { rmSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export const TOKEN_FILENAME = "portal-token";

export function tokenPath(stateDir: string): string {
  return `${stateDir}/${TOKEN_FILENAME}`;
}

async function ensureStateDir(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
}

/** Write the token atomically (temp file + rename) with mode 0600. */
export async function saveToken(stateDir: string, token: string): Promise<void> {
  await ensureStateDir(stateDir);
  const final = tokenPath(stateDir);
  const tmp = `${final}.tmp.${randomUUID()}`;
  try {
    await writeFile(tmp, token, { flag: "wx", mode: 0o600 });
    await rename(tmp, final);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Read and delete the saved token (single use: consume before sending).
 * Returns null when none is saved.
 */
export async function consumeToken(stateDir: string, cancelled?: () => boolean): Promise<string | null> {
  let token: string;
  try {
    token = (await readFile(tokenPath(stateDir), "utf8")).trim();
  } catch {
    return null;
  }
  if (cancelled?.()) return null;
  rmSync(tokenPath(stateDir), { force: true });
  return token === "" ? null : token;
}
