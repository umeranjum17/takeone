// Provider-agnostic AI planner over @byokit/decide: the decider is whatever
// model the user picked through a stored BYOKit decide config
// (`parseConfig` / `createDecider` shape: backend, auth, model, via).
// Jev is only the default when the user picked nothing. Provider names appear
// only in DEFAULT_PLANNER_CONFIG, modelOf (jev's default model),
// loadPlannerConfig and askBeat (opencode-go is the only account-auth backend). The
// provider is never switched automatically: limits, auth errors and timeouts
// stop with PlannerUnavailable instead of silently falling back.
//
// Answer validation stays takeone's own mapping (mapAnswers): the kit floor is
// set to 0 on our questions so a merely unsure answer still widens through the
// existing uncertainty rules instead of dropping the whole beat. Kit-level
// abstention (malformed answers) and transport failures fall back per beat, as
// before. Kit floors engage with per-field fallback in a later slice.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import {
  decide,
  parseConfig,
  ConfigError,
  UnsupportedAccountError,
  type Answer,
  type DecideCache,
  type DecideConfig,
  type Question,
} from "@byokit/decide";
import { writeFileAtomic } from "@byokit/secrets";
import type { PlannerAnswers } from "../types.ts";
import { takeoneConfigDir, loadPlannerKey, readPlannerKey, noKeyring, type KeyOptions } from "../secrets.ts";

export const CONCURRENCY = 8;
/** Whole-call budget per beat (attempts plus bounded 429 waits). */
export const DECIDE_TIMEOUT_MS = 10000;

/** The planner default: Jev, used only when the user picked nothing. This is
 * the one place takeone names a provider; everything else reads the config.
 * Transport matches the long-standing behaviour: 8 calls at once, 10 s per
 * call, one 429 retry. */
export const DEFAULT_PLANNER_CONFIG: DecideConfig = {
  backend: "jev",
  auth: "apiKey",
  model: "jev-latest",
  maxRetries: 1,
  retryBaseMs: 1000,
  retryMaxMs: 3000,
};

export function plannerConfigPath(o: KeyOptions = {}): string {
  return join(takeoneConfigDir(o), "planner.json");
}

/** Stored BYOKit decide config, or the Jev default when the user picked
 * nothing. Throws ConfigError on an invalid file (fix or delete it); an
 * account-auth file this host cannot serve is the same user error, so its
 * kit error is reported as one. */
export function loadPlannerConfig(o: KeyOptions = {}): { config: DecideConfig; defaulted: boolean } {
  const path = plannerConfigPath(o);
  if (!existsSync(path)) return { config: { ...DEFAULT_PLANNER_CONFIG }, defaulted: true };
  let config: DecideConfig;
  try {
    config = parseConfig(readFileSync(path, "utf8"));
  } catch (e) {
    if (e instanceof UnsupportedAccountError) throw new ConfigError(e.message);
    throw e;
  }
  const c = config as { backend: string; auth: string };
  if (c.auth === "account" && c.backend !== "opencode-go") {
    throw new ConfigError(`account authentication is only supported for opencode-go, not ${c.backend}`);
  }
  return { config, defaulted: false };
}

/** Record the user's provider choice. The config is validated by parseConfig,
 * so only shapes BYOKit decide understands are ever stored. */
export async function savePlannerConfig(config: DecideConfig, o: KeyOptions = {}): Promise<void> {
  const parsed = parseConfig(config);
  mkdirSync(dirname(plannerConfigPath(o)), { recursive: true });
  await writeFileAtomic(plannerConfigPath(o), JSON.stringify(parsed, null, 1) + "\n");
}

/** "backend (model)" with the via route when the backend has one. Reads the
 * config; it never names a provider itself. */
export function describePlanner(config: DecideConfig): string {
  return `${(config as { backend: string }).backend}${(config as { via?: string }).via ? ` via ${(config as { via?: string }).via}` : ""} (${modelOf(config)})`;
}

/** The model id behind a planner config. The Jev default is the only
 * provider-specific value here; everything else comes from the config. */
export function modelOf(config: DecideConfig): string {
  const c = config as { backend: string; model?: string };
  return c.model ?? (c.backend === "jev" ? "jev-latest" : "default");
}

export interface ResolvedPlanner {
  config: DecideConfig;
  defaulted: boolean;
  label: string;
  member: string | null;
  /** apiKey credential, when auth is apiKey and a key is stored. */
  key: string | null;
  /** True when auth is account and its sign-in is present. */
  accountPresent: boolean;
  /** True when the planner may be called (not opted out and credentialed). */
  active: boolean;
}

/** Person id for the shared BYOKit machine store: the sanitized OS username
 * (letters, digits, ".", "_" or "-"). A Go plan login is matched only when
 * stored under that machine store's people/<member>/auth.json. */
export function plannerMember(o: { username?: string } = {}): string {
  const name = o.username ?? userInfo().username;
  const clean = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "");
  return clean || "local";
}

export interface ResolvePlannerOptions extends KeyOptions {
  username?: string;
  /** Host-passed credential for the configured apiKey backend. null disables
   * the planner without touching the store; undefined loads the store. */
  apiKeyOverride?: string | null;
  /** Presence probe (doctor, capture hello): read the store without migrating
   * the legacy env file. */
  probe?: boolean;
}

/** Load the stored config and probe only whether its credential exists. Never
 * prints or returns a credential. */
export async function resolvePlanner(o: ResolvePlannerOptions = {}): Promise<ResolvedPlanner> {
  const { config, defaulted } = loadPlannerConfig(o);
  const c = config as { backend: string; auth: string };
  let member: string | null = null;
  let key: string | null = null;
  let accountPresent = false;
  if (o.apiKeyOverride === null) {
    // explicitly disabled: no store reads at all.
  } else if (c.auth === "account") {
    if (o.apiKeyOverride !== undefined) {
      throw new ConfigError(`${describePlanner(config)} plans through an account sign-in, which a supplied key cannot drive; fix planner.json or drop --planner-key-fd`);
    }
    member = plannerMember(o);
    accountPresent = await goAccountPresent(member, o.env);
  } else if (o.apiKeyOverride !== undefined) {
    key = o.apiKeyOverride;
  } else {
    key = await (o.probe ? readPlannerKey : loadPlannerKey)(c.backend, o);
  }
  return {
    config,
    defaulted,
    label: describePlanner(config),
    member,
    key,
    accountPresent,
    active: c.auth === "account" ? accountPresent : key !== null,
  };
}

/** Member-bound OpenCode Go plan account from the shared BYOKit machine
 * store. The key never leaves BYOKit: decide reads it per call. */
export async function loadGoAccount(member: string, env: NodeJS.ProcessEnv = process.env): Promise<import("@byokit/decide").OpenCodeGoAccount> {
  if (noKeyring(env)) throw new Error("OpenCode Go sign-in lives in the OS keyring; TAKEONE_NO_KEYRING is set");
  const { Accounts, machineStore } = await import("@byokit/accounts");
  const { osKeyringSeal } = await import("@byokit/secrets");
  const accounts = new Accounts({ store: (m: string) => machineStore(m, osKeyringSeal({ service: "byokit" })) });
  return accounts.opencodeGo(member);
}

/** Presence of the member's Go plan login. Reads the stored key into memory
 * only to check it exists; never prints or returns it, never touches network. */
export async function goAccountPresent(member: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const account = await loadGoAccount(member, env);
    const key = await account.access(new AbortController().signal);
    return typeof key === "string" && key.length > 0;
  } catch {
    return false;
  }
}
/** Safe presence probe for doctor and CLI banners: never prints, never
 * returns the credential itself, and never migrates or removes the legacy
 * env file. */
export async function plannerStatus(o: ResolvePlannerOptions = {}): Promise<{
  available: boolean;
  detail: string;
  config: DecideConfig;
  label: string;
}> {
  try {
    const r = await resolvePlanner({ ...o, probe: true });
    if (r.active) return { available: true, detail: `AI planner: ${r.label}`, config: r.config, label: r.label };
    const c = r.config as { backend: string; auth: string };
    if (r.defaulted) {
      return {
        available: false,
        detail: "AI planner off: films use fallback rules (no key is set; set one: read -rs k; printf %s \"$k\" | takeone key set)",
        config: r.config,
        label: r.label,
      };
    }
    return {
      available: false,
      detail: `AI planner off: films use fallback rules (no ${c.auth === "account" ? "sign-in" : "key"} for ${r.label})`,
      config: r.config,
      label: r.label,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const { config } = (() => {
      try {
        return loadPlannerConfig(o);
      } catch {
        return { config: { ...DEFAULT_PLANNER_CONFIG } };
      }
    })();
    return { available: false, detail: `AI planner store unavailable: ${reason}`, config, label: describePlanner(config) };
  }
}

/**
 * File-backed DecideCache over analysis/planner-cache.jsonl. Lines hold the
 * decide cache key plus the answers (usage and raw response); request bodies
 * are never stored. Cache errors never fail a decision: write failures are
 * reported through warn (stderr by default) and the decision proceeds.
 */
export class PlannerFileCache implements DecideCache {
  readonly path: string;
  private readonly warn: (line: string) => void;
  private map = new Map<string, Record<string, Answer>>();
  constructor(path: string, warn: (line: string) => void = (s) => console.error(s)) {
    this.path = path;
    this.warn = warn;
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
          if (typeof c.request === "string" && c.request !== "") dirty = true;
        } catch {
          dirty = true;
        }
      }
      if (dirty) {
        try {
          writeFileSync(path, [...this.map.entries()].map(([key, answers]) => JSON.stringify({ key, answers, t: new Date().toISOString() })).join("\n") + (this.map.size ? "\n" : ""));
        } catch (e) {
          this.warn(`planner cache: could not rewrite ${path} (${e instanceof Error ? e.message : String(e)}); stale lines kept`);
        }
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
    } catch (e) {
      this.warn(`planner cache: could not write ${this.path} (${e instanceof Error ? e.message : String(e)}); beat proceeds uncached`);
    }
  }
}

/** Refuse to store beats the mapping cannot use: an abstained or missing
 * field means the whole beat falls back, so caching it would only replay the
 * fallback and hide a model that recovered since. */
export function gateUnusable(cache: DecideCache): DecideCache {
  return {
    get: (key) => cache.get(key),
    set: (key, value) => {
      if (Object.values(value).every((a) => a && typeof a === "object" && !a.abstained)) {
        return cache.set(key, value);
      }
    },
  };
}

export interface AskOutcome {
  decisionSource: "cache" | "api" | "failed";
  answers?: Record<string, Answer>;
  inputTokens?: number;
  outputTokens?: number;
}

/** Statuses that stop the run before rendering instead of falling back: the
 * provider is limited, refused or too slow, and silently using rules would
 * bill nothing yet hide the outage. Anything else fails the beat, as before. */
const LIMIT_RE = /failed: http (429|401|402|403)\b|timed out/;

/** The provider cannot serve this run: rate-limited, unauthorized, or timed
 * out. The CLI exits 3 with the choices; nothing renders. */
export class PlannerUnavailable extends Error {
  readonly provider: string;
  readonly reason: string;
  constructor(provider: string, reason: string) {
    super(
      `AI planner: ${provider} ${reason}. ` +
        `Choose: wait and rerun, run with --no-ai for fallback rules, ` +
        `or switch provider yourself with takeone key set --backend <name> --model <model>.`,
    );
    this.name = "PlannerUnavailable";
    this.provider = provider;
    this.reason = reason;
  }
}

function limitReason(answers: Record<string, Answer>): string | null {
  for (const a of Object.values(answers)) {
    const reason = a && typeof a === "object" ? a.reason : undefined;
    if (typeof reason === "string" && LIMIT_RE.test(reason)) return reason;
  }
  return null;
}

/** Malformed usage counts must not enter accounting: fail the beat instead. */
function validUsageTokens(answers: Record<string, Answer>): { input?: number; output?: number } | null {
  let input: number | undefined;
  let output: number | undefined;
  for (const a of Object.values(answers)) {
    const u = a && typeof a === "object" ? a.usage : undefined;
    if (!u) continue;
    for (const [k, set] of [["input_tokens", (v: number) => (input = v)], ["output_tokens", (v: number) => (output = v)]] as const) {
      const v = (u as Record<string, unknown>)[k];
      if (v === undefined) continue;
      if (!Number.isSafeInteger(v) || (v as number) < 0) return null;
      set(v as number);
    }
  }
  return { ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) };
}

/** Adapt one beat's typed answers into the shape the decision mapping reads.
 * Returns null when an asked field abstained or went missing, and the caller
 * then applies the heuristic for the whole beat. */
export function toPlannerAnswers(answers: Record<string, Answer>): PlannerAnswers | null {
  const choice = (k: string): { choice?: string; probabilities?: Record<string, number>; confidence?: number } | null => {
    const a = answers[k];
    if (!a || a.abstained || typeof a.answer !== "string" || !a.probabilities || typeof a.probabilities !== "object") return null;
    return { choice: a.answer, probabilities: { ...(a.probabilities as Record<string, number>) }, confidence: a.confidence };
  };
  const score = (k: string, levels: number): { probabilities?: number[]; confidence?: number } | null => {
    const a = answers[k];
    if (!a || a.abstained || typeof a.answer !== "number") return null;
    const p = a.probabilities;
    if (!p || typeof p !== "object") return null;
    const arr: number[] = [];
    for (let i = 0; i < levels; i++) {
      const v = (p as Record<string, number>)[String(i)];
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      arr.push(v);
    }
    return { probabilities: arr, confidence: a.confidence };
  };
  const yesno = (k: string): { p?: number } | null => {
    const a = answers[k];
    if (!a || a.abstained || typeof a.answer !== "boolean") return null;
    const t = (a.probabilities as Record<string, number> | undefined)?.["true"];
    if (typeof t !== "number" || !Number.isFinite(t)) return null;
    return { p: t };
  };
  const focus_start = choice("focus_start");
  const focus_end = choice("focus_end");
  const tightness = score("tightness", 4);
  const new_subject = yesno("new_subject");
  const key_moment = score("key_moment", 3);
  if (!focus_start || !focus_end || !tightness || !new_subject || !key_moment) return null;
  return { focus_start, focus_end, tightness, new_subject, key_moment };
}

/** Ask one beat through the configured decider. Never throws on transport or
 * mapping failures (failed beats keep the heuristic); throws
 * PlannerUnavailable when the provider itself cannot serve the run. */
export async function askBeat(
  state: unknown,
  questions: Record<string, Question>,
  planner: ResolvedPlanner,
  cache: DecideCache,
  o: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    usable?: (answers: Record<string, Answer>) => boolean;
  } = {},
): Promise<AskOutcome> {
  const c = planner.config as { backend: string };
  let host: import("@byokit/decide").ConfigHost;
  if ((planner.config as { auth: string }).auth === "account") {
    if (planner.member === null) throw new Error("account planner resolved without a member");
    host = {
      accounts: { "opencode-go": await loadGoAccount(planner.member) },
      ...(o.fetchImpl ? { fetch: o.fetchImpl } : {}),
      cacheScope: planner.member,
    };
  } else {
    host = {
      ...(planner.key !== null ? { keys: { [c.backend]: planner.key } } : {}),
      ...(o.fetchImpl ? { fetch: o.fetchImpl } : {}),
    };
  }
  let answers: Record<string, Answer>;
  try {
    answers = await decide(state, questions, {
      config: planner.config,
      host,
      privacy: "may-leave",
      timeoutMs: o.timeoutMs ?? DECIDE_TIMEOUT_MS,
      cache: gateUnusable(cache),
    });
  } catch (e) {
    if (e instanceof UnsupportedAccountError || e instanceof ConfigError) {
      throw new PlannerUnavailable(planner.label, e instanceof Error ? e.message : String(e));
    }
    throw e;
  }
  if (!answers || typeof answers !== "object") return { decisionSource: "failed" };
  const limited = limitReason(answers);
  if (limited) throw new PlannerUnavailable(planner.label, limited);
  const usage = validUsageTokens(answers);
  if (usage === null) return { decisionSource: "failed" };
  const tokens = {
    ...(usage.input !== undefined ? { inputTokens: usage.input } : {}),
    ...(usage.output !== undefined ? { outputTokens: usage.output } : {}),
  };
  if (!Object.values(answers).some((a) => a && !a.abstained)) return { decisionSource: "failed", ...tokens };
  if (o.usable && !o.usable(answers)) return { decisionSource: "failed", ...tokens };
  const cached = Object.values(answers).filter(Boolean).every((a) => a.source === "cache");
  if (cached) return { decisionSource: "cache", answers };
  return { decisionSource: "api", answers, ...tokens };
}

/** Run tasks with bounded concurrency; results keep input order. */
export async function pooled<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        await fn(items[idx]!);
      } catch (e) {
        i = items.length;
        throw e;
      }
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}
