/**
 * Sweep of stale per-user scratch under the temporary directory.
 *
 * This host's /tmp carries a per-user quota: the disk shows tens of gigabytes free while
 * every write fails with "Disk quota exceeded". The shapes below are what piles up and
 * nobody clears. The patterns are fixed prefixes, the root is only ever /tmp from the CLI,
 * and nothing is removed that is young, owned by another user, in use by a live process,
 * or not a plain directory. `plan` never removes; `sweep` removes what `plan` lists.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";

/** Directory-name prefixes that accumulate; each swept entry must start with one and be a real directory. */
export const SWEEP_PREFIXES = [
  "puppeteer_dev_chrome_profile-",
  "org.chromium.Chromium.",
  "fhl.",
  "fdpack.",
  "npmprobe2.",
  "tmp.",
] as const;

/** Names that belong to running agents; never swept even if a prefix ever matched them. */
export const PROTECTED = ["claude-1000", "opencode"] as const;

export const DEFAULT_MIN_AGE_HOURS = 4;

export type SweepEntry = { path: string; bytes: number; ageHours: number };
export type Skipped = { path: string; reason: string };
export type SweepPlan = {
  root: string;
  remove: SweepEntry[];
  skipped: Skipped[];
  /** Bytes under every entry of a swept shape, young or old, kept or removed. */
  shapeBytes: number;
};
export type SweepResult = SweepPlan & {
  removed: SweepEntry[];
  refused: Skipped[];
  shapeBytesAfter: number;
  freeBefore: number;
  freeAfter: number;
};

export type SweepOptions = {
  root?: string;
  minAgeHours?: number;
  now?: number;
  uid?: number;
  /** Paths of live processes' cwd, open files and command lines; read from /proc when omitted. */
  inUse?: string[];
  /** Removes one directory tree; replaceable so a refusal can be injected. */
  remove?: (path: string) => void;
};

/** Size and newest mtime of a tree, without following symlinks. */
function measure(path: string): { bytes: number; newest: number } {
  let bytes = 0, newest = 0;
  const stack = [path];
  while (stack.length) {
    const p = stack.pop() as string;
    let st;
    try { st = lstatSync(p); } catch { continue; }
    bytes += st.blocks * 512;
    newest = Math.max(newest, st.mtimeMs);
    if (!st.isDirectory()) continue;
    try { for (const name of readdirSync(p)) stack.push(join(p, name)); } catch { /* unreadable: counted as is */ }
  }
  return { bytes, newest };
}

/** Everything a live process of this user points at: working directory, open files, arguments and environment. */
export function liveReferences(): string[] {
  const refs: string[] = [];
  let pids: string[] = [];
  try { pids = readdirSync("/proc").filter(n => /^\d+$/.test(n)); } catch { return refs; }
  for (const pid of pids) {
    try { refs.push(readlinkSync(`/proc/${pid}/cwd`)); } catch { /* another user's, or gone */ }
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        try { refs.push(readlinkSync(`/proc/${pid}/fd/${fd}`)); } catch { /* closed meanwhile */ }
      }
    } catch { /* not ours */ }
    for (const file of ["cmdline", "environ"]) {
      try { refs.push(...readFileSync(`/proc/${pid}/${file}`, "utf8").split("\0")); } catch { /* gone, or not ours */ }
    }
  }
  return refs;
}

/** The top-level names under `root` that any reference mentions, whole or as the start of a longer path. */
function referencedNames(refs: string[], root: string): Set<string> {
  const names = new Set<string>();
  const re = new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^/\\s:;"']+)`, "g");
  for (const m of refs.join("\n").matchAll(re)) names.add(m[1] as string);
  return names;
}

/** A Chromium profile whose SingletonLock names a live pid is in use even if no argument shows it. */
function lockedByLivePid(dir: string): boolean {
  try {
    const target = readlinkSync(join(dir, "SingletonLock"));
    const pid = /-(\d+)$/.exec(target)?.[1];
    return pid !== undefined && existsSync(`/proc/${pid}`);
  } catch { return false; }
}

function freeBytes(root: string): number {
  try { const s = statfsSync(root); return s.bavail * s.bsize; } catch { return 0; }
}

/** What a sweep would remove, and what it leaves and why. Removes nothing. */
export function plan(o: SweepOptions = {}): SweepPlan {
  const root = o.root ?? "/tmp";
  const minAge = (o.minAgeHours ?? DEFAULT_MIN_AGE_HOURS) * 3_600_000;
  const now = o.now ?? Date.now();
  const uid = o.uid ?? process.getuid?.() ?? -1;
  const named = referencedNames(o.inUse ?? liveReferences(), root);
  const remove: SweepEntry[] = [], skipped: Skipped[] = [];
  let shapeBytes = 0;
  let names: string[] = [];
  try { names = readdirSync(root); } catch { /* unreadable root: nothing to sweep */ }
  for (const name of names.sort()) {
    if (!SWEEP_PREFIXES.some(p => name.startsWith(p))) continue;
    const path = join(root, name);
    if ((PROTECTED as readonly string[]).includes(name)) { skipped.push({ path, reason: "protected" }); continue; }
    let st;
    try { st = lstatSync(path); } catch { continue; }
    const { bytes, newest } = measure(path);
    shapeBytes += bytes;
    if (st.uid !== uid) { skipped.push({ path, reason: `owned by uid ${st.uid}, not ours` }); continue; }
    if (!st.isDirectory()) { skipped.push({ path, reason: "not a plain directory" }); continue; }
    const ageMs = now - newest;
    if (ageMs < minAge) { skipped.push({ path, reason: `touched ${(ageMs / 3_600_000).toFixed(1)} h ago, under the ${minAge / 3_600_000} h floor` }); continue; }
    if (named.has(name) || lockedByLivePid(path)) {
      skipped.push({ path, reason: "in use by a running process" });
      continue;
    }
    remove.push({ path, bytes, ageHours: ageMs / 3_600_000 });
  }
  return { root, remove, skipped, shapeBytes };
}

/** Remove what `plan` lists, one entry at a time; an entry the OS refuses is reported and skipped, never retried. */
export function sweep(o: SweepOptions = {}): SweepResult {
  const root = o.root ?? "/tmp";
  const freeBefore = freeBytes(root);
  const p = plan(o);
  const removed: SweepEntry[] = [], refused: Skipped[] = [];
  for (const e of p.remove) {
    try {
      (o.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true })))(e.path);
      removed.push(e);
    } catch (err) {
      refused.push({ path: e.path, reason: `removal refused by the OS (${(err as NodeJS.ErrnoException).code ?? err}), likely content we do not own; left in place` });
    }
  }
  // An entry the OS only half removed still counts as not reclaimed.
  const leftover = removed.filter(e => existsSync(e.path));
  const gone = removed.filter(e => !leftover.includes(e));
  for (const e of leftover) refused.push({ path: e.path, reason: "removal refused: entries remain" });
  const reclaimed = gone.reduce((n, e) => n + e.bytes, 0);
  return { ...p, removed: gone, refused, shapeBytesAfter: Math.max(0, p.shapeBytes - reclaimed), freeBefore, freeAfter: freeBytes(root) };
}

export function human(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
