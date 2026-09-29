// Jev planner via @byokit/decide's jev({key}) backend: one POST per beat,
// concurrency 8, a pluggable request-hash cache in analysis/jev-cache.jsonl,
// and decide's bounded 429 retry honouring retry-after.
// The API key is read from TYPESAFE_API_KEY or ~/.config/takeone/env, sent only
// as a header, and never logged.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { cacheKey, decide, jev, type Answer, type DecideCache, type Question } from "@byokit/decide";

export const CONCURRENCY = 8;
/** Whole-call budget per beat (attempts plus bounded 429 waits). */
export const DECIDE_TIMEOUT_MS = 10000;

/** Load the key from the environment or <configDir>/takeone/env. Never logged. */
export function loadApiKey(env: NodeJS.ProcessEnv = process.env, configDir?: string): string | null {
  if (env["TYPESAFE_API_KEY"]) return env["TYPESAFE_API_KEY"];
  const p = join(configDir ?? join(homedir(), ".config"), "takeone", "env");
  if (!existsSync(p)) return null;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const m = s.match(/^TYPESAFE_API_KEY\s*=\s*(.+)$/);
    if (m?.[1]) return m[1].trim();
    if (!s.includes("=")) return s; // a bare key on its own line
  }
  return null;
}

/**
 * File-backed DecideCache over analysis/jev-cache.jsonl. Lines hold the
 * decide cache key plus the answers (usage and raw response); request bodies
 * are never stored, and with omitRequestBody any legacy `request` fields found
 * in the file are scrubbed on load. Cache errors never fail a decision.
 */
export class JevFileCache implements DecideCache {
  readonly path: string;
  private readonly omitRequestBody: boolean;
  private map = new Map<string, Record<string, Answer>>();
  constructor(path: string, o: { omitRequestBody?: boolean } = {}) {
    this.omitRequestBody = o.omitRequestBody ?? false;
    this.path = path;
    if (existsSync(path)) {
      let dirty = false;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const s = line.trim();
        if (!s) continue;
        try {
          const c = JSON.parse(s) as { key?: unknown; answers?: unknown; request?: unknown };
          if (typeof c.key !== "string" || !c.answers || typeof c.answers !== "object") {
            dirty = true; // legacy or malformed line: never a hit under decide keys
            continue;
          }
          this.map.set(c.key, c.answers as Record<string, Answer>);
          if (this.omitRequestBody && typeof c.request === "string" && c.request !== "") dirty = true;
        } catch {
          dirty = true;
        }
      }
      if (dirty) {
        try {
          writeFileSync(path, [...this.map.entries()].map(([key, answers]) => JSON.stringify({ key, answers, t: new Date().toISOString() })).join("\n") + (this.map.size ? "\n" : ""));
        } catch {}
      }
    }
  }

  get(key: string): Record<string, Answer> | undefined {
    return this.map.get(key);
  }

  set(key: string, value: Record<string, Answer>): void {
    this.map.set(key, value);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify({ key, answers: value, t: new Date().toISOString() }) + "\n");
    } catch {}
  }
}

export interface AskOutcome {
  decisionSource: "cache" | "api" | "failed";
  response?: unknown;
  inputTokens?: number;
}

/** The first raw backend response across the answers, if any backend call happened. */
function firstRaw(answers: Record<string, Answer>): unknown {
  for (const a of Object.values(answers)) {
    if (a && typeof a === "object" && a.raw !== undefined) return a.raw;
  }
  return undefined;
}

/** usage.input_tokens when the backend sent a valid one. */
function firstInputTokens(answers: Record<string, Answer>): number | undefined {
  for (const a of Object.values(answers)) {
    const t = a && typeof a === "object" ? a.usage?.input_tokens : undefined;
    if (t !== undefined) return t;
  }
  return undefined;
}

/** Malformed usage counts must not enter accounting: fail the beat instead. */
function validUsage(response: unknown): boolean {
  const usage = (response as { usage?: { input_tokens?: unknown } } | null)?.usage;
  const tokens = usage?.input_tokens;
  return tokens === undefined || (Number.isSafeInteger(tokens) && (tokens as number) >= 0);
}

/** Ask one beat through decide's jev backend, consulting the cache first. Never throws. */
export async function askBeat(
  state: unknown,
  questions: Record<string, Question>,
  key: string | null,
  cache: DecideCache,
  o: { fetchImpl?: typeof fetch; timeoutMs?: number; usable?: (response: unknown) => boolean } = {},
): Promise<AskOutcome> {
  try {
    const ckey = cacheKey(state, questions);
    let hit: Record<string, Answer> | undefined;
    try {
      hit = await cache.get(ckey);
    } catch {
      hit = undefined;
    }
    // A cache hit costs zero network calls and records zero tokens, as before.
    if (hit && typeof hit === "object") {
      const raw = firstRaw(hit);
      if (raw !== undefined && (!o.usable || o.usable(raw))) return { decisionSource: "cache", response: raw };
    }
    if (!key) return { decisionSource: "failed" };
    const answers = await decide(state, questions, {
      privacy: "may-leave",
      backends: [jev({ key, fetch: o.fetchImpl, maxRetries: 2, retryBaseMs: 1000, retryMaxMs: 3000 })],
      timeoutMs: o.timeoutMs ?? DECIDE_TIMEOUT_MS,
    });
    const raw = firstRaw(answers);
    if (raw === undefined || !validUsage(raw)) return { decisionSource: "failed" };
    if (o.usable && !o.usable(raw)) return { decisionSource: "failed" };
    try {
      await cache.set(ckey, answers);
    } catch {}
    return { decisionSource: "api", response: raw, inputTokens: firstInputTokens(answers) };
  } catch {
    return { decisionSource: "failed" };
  }
}

/** Run tasks with bounded concurrency; results keep input order. */
export async function pooled<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}
