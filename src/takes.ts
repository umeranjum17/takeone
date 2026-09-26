/** Listing of takes under the takes root. */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface TakeEntry {
  id: string;
  path: string;
  /** "recording" = the live pid file names this take; else per take.json. */
  status: "recording" | "complete" | "incomplete";
  durationMs: number | null;
  frames: number | null;
  pointer: string | null;
}

/** The live-recording marker, shared by `record`, `stop` and listing. */
export interface RecordingInfo {
  pid: number;
  take: string;
}

export function parseTakeId(name: string): string | null {
  return /^\d{8}-\d{6}$/.test(name) ? name : null;
}

/** Parse and liveness-check a pid file's content. Null when stale or absent. */
export function parsePidFile(content: string): RecordingInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const pid = (parsed as { pid?: unknown }).pid;
  const take = (parsed as { take?: unknown }).take;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof take !== "string" || take === "") return null;
  try {
    process.kill(pid, 0); // throws ESRCH when the process is gone
  } catch {
    return null;
  }
  return { pid, take };
}

export async function listTakes(
  root: string,
  recording: RecordingInfo | null,
): Promise<TakeEntry[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const entries: TakeEntry[] = [];
  for (const name of names.sort().reverse()) {
    const id = parseTakeId(name);
    if (id === null) continue;
    const dir = join(root, name);
    let takeJson: Record<string, unknown> | null = null;
    try {
      takeJson = JSON.parse(await readFile(join(dir, "take.json"), "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      // no take.json yet: incomplete, or recording without a live pid
    }
    const status =
      recording !== null && recording.take === dir
        ? "recording"
        : takeJson !== null
          ? "complete"
          : "incomplete";
    const clock = takeJson?.clock as { frames?: unknown } | undefined;
    const durationMs =
      typeof takeJson?.started_at === "string" && typeof takeJson?.stopped_at === "string"
        ? Math.round(
            new Date(takeJson.stopped_at as string).getTime() -
              new Date(takeJson.started_at as string).getTime(),
          )
        : null;
    entries.push({
      id,
      path: dir,
      status,
      durationMs,
      frames: typeof clock?.frames === "number" ? clock.frames : null,
      pointer: typeof takeJson?.pointer === "string" ? takeJson.pointer : null,
    });
  }
  return entries;
}
