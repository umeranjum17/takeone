/**
 * Out-of-quota detection for the temporary directory, in one place.
 *
 * When /tmp is out of per-user quota the disk still shows free space, and the failure
 * surfaces as a raw mkdtemp error or an ffmpeg tail ending "Disk quota exceeded". Every
 * temp-dir creation and the ffmpeg runner pass their failure through `quotaFailure`, so the
 * caller sees one plain message: what is wrong, what a sweep freed, and what to run.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { human, plan } from "./tmpsweep.ts";

const QUOTA = /EDQUOT|Disk quota exceeded/i;

/** The temporary space is out of quota; its message already says what to do. */
export class TmpQuotaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TmpQuotaError";
  }
}

export function isQuotaError(e: unknown): boolean {
  if (e instanceof TmpQuotaError) return true;
  const err = e as NodeJS.ErrnoException | undefined;
  return err?.code === "EDQUOT" || QUOTA.test(err?.message ?? String(e));
}

function stateFile(): string {
  return join(process.env.TAKEONE_STATE_DIR ?? join(homedir(), ".local", "state", "takeone"), "tmp-sweep.json");
}

/** The last sweep's reclaimed total, kept under the state dir because the temporary space cannot be written to. */
export function recordSweep(reclaimedBytes: number, at = Date.now()): void {
  const file = stateFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ at, reclaimedBytes }));
}

function lastSweep(): { at: number; reclaimedBytes: number } | undefined {
  try { return JSON.parse(readFileSync(stateFile(), "utf8")); } catch { return undefined; }
}

/** The plain message, with the last sweep's total and what a sweep run now would reclaim. */
export function quotaMessage(): string {
  const last = lastSweep();
  let reclaimable = "unknown";
  try { reclaimable = human(plan({ root: "/tmp" }).remove.reduce((n, e) => n + e.bytes, 0)); } catch { /* estimate only */ }
  const freed = last ? `The last sweep freed ${human(last.reclaimedBytes)} (${new Date(last.at).toISOString()}).` : "No sweep has run on this host yet.";
  return [
    "The temporary space (/tmp) is out of quota: writes there fail with \"Disk quota exceeded\" even though the disk shows free space.",
    `${freed} A sweep run now would free about ${reclaimable}.`,
    "Run: node scripts/tmp-sweep.ts   (add --dry-run to list what it would remove first)",
  ].join(" ");
}

/** The one detection point: a quota failure becomes a `TmpQuotaError` with the plain message; anything else is returned as is. */
export function quotaFailure<E>(e: E): E | TmpQuotaError {
  if (!isQuotaError(e) || e instanceof TmpQuotaError) return e;
  return new TmpQuotaError(quotaMessage(), { cause: e });
}

/** `mkdtempSync` under the temp dir; a quota failure is reported in plain words. */
export function scratchDirSync(prefix: string): string {
  try { return mkdtempSync(join(tmpdir(), prefix)); }
  catch (e) {
    if (!isQuotaError(e)) throw e;
    throw new TmpQuotaError(quotaMessage(), { cause: e });
  }
}

/** `mkdtemp` under the temp dir; a quota failure is reported in plain words. */
export async function scratchDir(prefix: string): Promise<string> {
  try { return await mkdtemp(join(tmpdir(), prefix)); }
  catch (e) { throw quotaFailure(e); }
}
