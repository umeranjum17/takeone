import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, afterEach } from "node:test";

const initial = new Set(await descendants(process.pid));

export function installChildProcessCleanup(): void {
  afterEach(async () => {
    const live = await liveNewChildren();
    try { assert.deepEqual(live, [], "test left spawned child processes alive"); }
    finally { await cleanupNewChildren(); }
  });
  after(async () => {
    const live = await liveNewChildren();
    try { assert.deepEqual(live, [], "test suite left spawned child processes alive"); }
    finally { await cleanupNewChildren(); }
  });
}

async function cleanupNewChildren(): Promise<void> {
  const pids = await liveNewChildren();
  for (const pid of pids) signal(pid, "SIGTERM");

  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline && (await liveNewChildren()).length > 0) await delay(25);

  const remaining = await liveNewChildren();
  for (const pid of remaining) signal(pid, "SIGKILL");
  const killDeadline = Date.now() + 1_500;
  while (Date.now() < killDeadline && (await liveNewChildren()).length > 0) await delay(25);
}

async function liveNewChildren(): Promise<number[]> {
  const pids = await descendants(process.pid);
  const live: number[] = [];
  for (const pid of pids) {
    if (initial.has(pid)) continue;
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      if (state !== "Z" && state !== "X") live.push(pid);
    } catch {
      // It exited between enumerating and reading /proc.
    }
  }
  return live;
}

async function descendants(parent: number): Promise<number[]> {
  let children: string;
  try {
    children = await readFile(`/proc/${parent}/task/${parent}/children`, "utf8");
  } catch {
    return [];
  }
  const pids = children.trim().split(/\s+/).filter(Boolean).map(Number);
  const nested = await Promise.all(pids.map((pid) => descendants(pid)));
  return [...pids, ...nested.flat()];
}

function signal(pid: number, value: NodeJS.Signals): void {
  try { process.kill(pid, value); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
