// Jev client: one POST per beat, concurrency 8, 3 s timeout, one retry on 429
// honouring retry-after, and a request-hash cache in analysis/jev-cache.jsonl.
// The API key is read from TYPESAFE_API_KEY or ~/.config/takeone/env, sent only
// as a header, and never logged.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { JEV_ENDPOINT, JEV_MODEL } from "./request.ts";

export const CONCURRENCY = 8;
export const TIMEOUT_MS = 3000;

export interface CacheLine {
  key: string;
  request: string;
  response: unknown;
  t: string;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

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

interface CallResult {
  ok: boolean;
  status?: number;
  response?: unknown;
  /** usage.input_tokens when present */
  inputTokens?: number;
  retryAfterMs?: number;
  error?: string;
}

/**
 * One Jev call. `fetchImpl` is injectable for tests. 429 retries once after
 * retry-after (default 1 s); anything else fails immediately.
 */
export async function callJev(
  body: string,
  key: string,
  o: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CallResult> {
  const f = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  const doCall = async (): Promise<CallResult> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await f(JEV_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body,
        signal: ac.signal,
      });
      if (res.status === 429) {
        const header = res.headers.get("retry-after")?.trim();
        const seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : NaN;
        const date = header && !Number.isFinite(seconds) ? Date.parse(header) - Date.now() : NaN;
        return { ok: false, status: 429, retryAfterMs: Number.isFinite(seconds) ? seconds : Number.isFinite(date) ? date : 1000 };
      }
      const text = await res.text();
      if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, error: "malformed response" };
      }
      const usage = (json as { usage?: { input_tokens?: unknown } } | null)?.usage;
      const tokens = usage?.input_tokens;
      if (tokens !== undefined && (!Number.isSafeInteger(tokens) || (tokens as number) < 0)) {
        return { ok: false, error: "malformed usage" };
      }
      return { ok: true, response: json, inputTokens: tokens as number | undefined };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  };
  const first = await doCall();
  if (first.status === 429 && (first.retryAfterMs ?? 1000) >= 0 && (first.retryAfterMs ?? 1000) <= timeoutMs) {
    await new Promise((r) => setTimeout(r, first.retryAfterMs ?? 1000));
    return doCall();
  }
  return first;
}

export class DecisionCache {
  private map = new Map<string, CacheLine>();
  readonly path: string;
  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const s = line.trim();
        if (!s) continue;
        try {
          const c = JSON.parse(s) as CacheLine;
          this.map.set(c.key, c);
        } catch {
          // skip malformed cache lines
        }
      }
    }
  }

  get(body: string): CacheLine | null {
    return this.map.get(sha256(body)) ?? null;
  }

  put(body: string, response: unknown): void {
    const line: CacheLine = { key: sha256(body), request: body, response, t: new Date().toISOString() };
    this.map.set(line.key, line);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(line) + "\n");
  }
}

export interface AskOutcome {
  decisionSource: "cache" | "api" | "failed";
  response?: unknown;
  inputTokens?: number;
}

/** Ask one beat, consulting the cache first. Never throws. */
export async function askBeat(
  body: string,
  key: string | null,
  cache: DecisionCache,
  o: { fetchImpl?: typeof fetch; usable?: (response: unknown) => boolean } = {},
): Promise<AskOutcome> {
  const hit = cache.get(body);
  if (hit && (!o.usable || o.usable(hit.response))) return { decisionSource: "cache", response: hit.response };
  if (!key) return { decisionSource: "failed" };
  const r = await callJev(body, key, o);
  if (!r.ok || r.response === undefined) return { decisionSource: "failed" };
  if (!o.usable || o.usable(r.response)) {
    try {
      cache.put(body, r.response);
    } catch {}
  }
  return { decisionSource: "api", response: r.response, inputTokens: r.inputTokens };
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

export { JEV_MODEL };
