// Provider-agnostic AI planner over @byokit/decide: the decider is whatever
// model the user picked through a stored BYOKit decide config
// (`parseConfig` / `createDecider` shape: backend, auth, model, via).
//
// THIS MODULE OWNS THE DISCOVERY ORDER. With nothing saved, an
// already-signed-in Claude or Codex CLI account is offered first, then a
// signed-in ChatGPT or OpenCode Go plan account, then the stored key, then
// local rules. Every other place states the order by pointing here
// (docs/guide.md "Discovery order"). A saved choice is never switched:
// limits, refusals, auth errors and timeouts stop with PlannerUnavailable
// instead of silently falling back.
//
// A discovered account is offered only when it can serve. `cliAccounts` says
// how a signed-in Claude is signed in (`SignInMethod`), and an API key,
// Bedrock or Vertex login cannot serve takeone's ask: it is passed over for
// the stored key and the reason is said out loud, never swallowed. At call
// time a true refusal (the kit's `RefusalCode`, or a CLI that refuses the ask)
// stops the run; only `bad_reply` and other per-beat failures fall back.
//
// Provider names live in this module's config, label and installed-CLI
// account paths; there is no model list here (pi's model comes from
// planner.json, a discovered plan account's from its own live list).
//
// Answer validation stays takeone's own mapping (mapAnswers): the kit floor is
// set to 0 on our questions so a merely unsure answer still widens through the
// existing uncertainty rules instead of dropping the whole beat. Kit-level
// abstention (malformed answers) and transport failures fall back per beat, as
// before. Kit floors engage with per-field fallback in a later slice.

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, accessSync, constants } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
  decide,
  parseConfig,
  ConfigError,
  UnsupportedAccountError,
  UnsupportedImagesError,
  type Answer,
  type DecideCache,
  type DecideConfig,
  type FailureCode,
  type ImageInput,
  type Question,
  type RefusalCode,
} from "@byokit/decide";
import { codex } from "@byokit/decide/codex";
import { pi } from "@byokit/decide/pi";
import { claudeCode } from "@byokit/decide/claude-code";
import { writeFileAtomic } from "@byokit/secrets";
// Type only: the sign-in method the kit reads from the CLI's own status
// command. Erased at compile time, so the Node-only subpath stays dynamic.
import type { SignInMethod } from "@byokit/accounts/cli";
import type { PlannerAnswers } from "../types.ts";
import { takeoneConfigDir, loadPlannerKey, readPlannerKey, noKeyring, type KeyOptions } from "../secrets.ts";

/** Whole-call budget per chunk of beats (attempts plus bounded 429 waits). */
export const DECIDE_TIMEOUT_MS = 30000;
/** MiniMax reasons before it answers: replayed real planning requests took 10-17 s, and a slow one passes 30 s. */
const MINIMAX_TIMEOUT_MS = 120000;

/** The planner default: Jev, the last resort of the discovery order above,
 * used only when the user picked nothing and no installed or signed-in
 * account can serve. One 429 retry per call. */
export const DEFAULT_PLANNER_CONFIG: DecideConfig = {
  backend: "jev",
  auth: "apiKey",
  model: "jev-latest",
  maxRetries: 1,
  retryBaseMs: 1000,
  retryMaxMs: 3000,
};

type CliPlannerConfig = { backend: "claude-code" | "codex"; auth: "account"; account: "installed-claude" | "installed-codex"; bin: string; model?: string };
/** The person's installed pi CLI and the model it should ask. TakeOne stores no
 * key of its own: pi answers with the provider sign-in it already has. */
type PiPlannerConfig = { backend: "pi"; bin: string; model: string };
type PlannerConfig = DecideConfig | CliPlannerConfig | PiPlannerConfig;

export function plannerConfigPath(o: KeyOptions = {}): string {
  return join(takeoneConfigDir(o), "planner.json");
}

/** Stored BYOKit decide config, or the Jev default when the user picked
 * nothing. Throws ConfigError on an invalid file (fix or delete it); an
 * account-auth file this host cannot serve is the same user error, so its
 * kit error is reported as one. */
export function loadPlannerConfig(o: KeyOptions = {}): { config: PlannerConfig; defaulted: boolean } {
  const path = plannerConfigPath(o);
  if (!existsSync(path)) return { config: { ...DEFAULT_PLANNER_CONFIG }, defaulted: true };
  const raw = readFileSync(path, "utf8");
  let config: PlannerConfig;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value?.backend === "pi") {
      if (typeof value.bin !== "string" || !isAbsolute(value.bin) || typeof value.model !== "string" || !value.model.trim() || Object.keys(value).some((key) => !["backend", "bin", "model"].includes(key))) {
        throw new ConfigError("pi planner requires an absolute bin and a model");
      }
      config = value as PiPlannerConfig;
    } else if (value?.backend === "codex") {
      if (value.auth !== "account" || value.account !== "installed-codex" || typeof value.bin !== "string" || !isAbsolute(value.bin) || (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim())) || Object.keys(value).some((key) => !["backend", "auth", "account", "bin", "model"].includes(key))) {
        throw new ConfigError("codex planner requires its installed account and an absolute bin");
      }
      config = value as CliPlannerConfig;
    } else {
      config = parseConfig(raw);
    }
  } catch (e) {
    if (e instanceof UnsupportedAccountError || e instanceof SyntaxError) throw new ConfigError(e.message);
    throw e;
  }
  return { config, defaulted: false };
}

/** Record the user's planner choice after validating its backend-specific config. */
export async function savePlannerConfig(config: PlannerConfig, o: KeyOptions = {}): Promise<void> {
  const parsed = config.backend === "codex" || config.backend === "pi" ? config : parseConfig(config);
  mkdirSync(dirname(plannerConfigPath(o)), { recursive: true });
  await writeFileAtomic(plannerConfigPath(o), JSON.stringify(parsed, null, 1) + "\n");
}

/** "backend (model)" with the via route when the backend has one. A saved
 * installed CLI only names its provider; the resolved planner decides whether
 * its sign-in can actually serve the backend. */
export function describePlanner(config: PlannerConfig): string {
  const c = config as { auth?: string };
  return plannerLabel(config, c.auth === "account");
}

function plannerLabel(config: PlannerConfig, accountPresent: boolean): string {
  const c = config as { backend: string; via?: string; auth?: string };
  const account = c.backend === "claude-code" ? "Claude" : c.backend === "codex" ? "Codex" : c.backend === "openai" ? "ChatGPT" : c.backend === "opencode-go" ? "OpenCode Go" : null;
  const cli = c.backend === "claude-code" || c.backend === "codex";
  const name = account && c.auth === "account"
    ? cli
      ? accountPresent ? `signed-in ${account} account` : `installed ${account} CLI`
      : accountPresent ? `signed-in ${account} account` : account
    : c.backend;
  return `${name}${c.via ? ` via ${c.via}` : ""} (${modelOf(config)})`;
}

/** Whether the planner can return free text beside its choices (answerFields).
 * Jev answers only choices, so a film asks for a title and captions only of the others. */
export function plannerAnswersText(config: PlannerConfig): boolean {
  return (config as { backend: string }).backend !== "jev";
}

/** The model id behind a planner config. The Jev default is the only
 * provider-specific value here; everything else comes from the config. */
export function modelOf(config: PlannerConfig): string {
  const c = config as { backend: string; model?: string };
  return c.model ?? (c.backend === "jev" ? "jev-latest" : "default");
}

export interface ResolvedPlanner {
  config: PlannerConfig;
  defaulted: boolean;
  label: string;
  member: string | null;
  /** apiKey credential, when auth is apiKey and a key is stored. */
  key: string | null;
  /** True when auth is account and its sign-in is present, or the pi CLI is ready. */
  accountPresent: boolean;
  /** True when the planner may be called (not opted out and credentialed). */
  active: boolean;
  /** Why the resolved account sign-in or the pi CLI cannot serve the backend, in plain words. */
  refusal: string | null;
  /** A signed-in account discovery passed over because its own sign-in cannot
   * serve (an API key, Bedrock or Vertex Claude login), while another provider
   * took the run. Said out loud instead of being swallowed. Null when nothing
   * signed-in was passed over. */
  skipped: string | null;
  /** The installed CLI launch this resolve validated, when a CLI account is the planner. */
  cliLaunch: CliAccount | null;
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
  const loaded = loadPlannerConfig(o);
  let config = loaded.config;
  const { defaulted } = loaded;
  const env = o.env ?? process.env;
  let refusal: string | null = null;
  let skipped: string | null = null;
  let cliLaunch: CliAccount | null = null;
  // Discovery already validated the account it hands back, so its readiness is
  // never probed a second time here or per chunk.
  let found = false;
  if (defaulted && o.apiKeyOverride === undefined) {
    const discovered = await discoverAccount(plannerMember(o), env, o.configDir);
    if (discovered.config) {
      config = discovered.config;
      cliLaunch = discovered.cli;
      found = true;
    } else {
      refusal = discovered.refusal;
    }
    // A signed-in account that could not serve is reported whether or not
    // another provider took the run, so a passed-over sign-in is never silent.
    skipped = discovered.skipped;
  }
  const c = config as { backend: string; auth: string };
  let member: string | null = null;
  let key: string | null = null;
  let accountPresent = found;
  if (o.apiKeyOverride === null) {
    // explicitly disabled: no store reads at all.
  } else if (c.backend === "pi") {
    if (o.apiKeyOverride !== undefined) {
      throw new ConfigError(`${describePlanner(config)} plans through the installed pi CLI, which a supplied key cannot drive; fix planner.json or drop --planner-key-fd`);
    }
    const ready = await piReadiness(config as PiPlannerConfig, o.env);
    accountPresent = ready.ok;
    if (!ready.ok) refusal = ready.reason;
  } else if (c.auth === "account") {
    if (o.apiKeyOverride !== undefined) {
      throw new ConfigError(`${describePlanner(config)} plans through an account sign-in, which a supplied key cannot drive; fix planner.json or drop --planner-key-fd`);
    }
    member = plannerMember(o);
    if (!found) {
      if (c.backend === "codex") {
        const ready = await cliReady(config as CliPlannerConfig, env, o.configDir);
        accountPresent = ready.ok;
        if (ready.ok) cliLaunch = ready.launch;
        else refusal = ready.message;
      } else {
        accountPresent = c.backend === "openai"
          ? await openAIAccountPresent(member, env)
          : await goAccountPresent(member, env);
      }
    }
  } else if (o.apiKeyOverride !== undefined) {
    key = o.apiKeyOverride;
  } else {
    key = await (o.probe ? readPlannerKey : loadPlannerKey)(c.backend, o);
  }
  return {
    config,
    defaulted,
    label: plannerLabel(config, accountPresent),
    member,
    key,
    accountPresent,
    refusal,
    skipped,
    cliLaunch,
    active: c.auth === "account" || c.backend === "pi" ? accountPresent : key !== null,
  };
}

/** Whether the installed pi can answer for this model, asked with pi's own
 * `auth check` (no model call, no credential read). A nonzero-exit check, an
 * unreadable reply or a status other than `ready` all mean it cannot run yet;
 * the reason is what the user reads instead of a silent fallback. */
async function piReadiness(config: PiPlannerConfig, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; reason: string }> {
  if (!existsSync(config.bin)) {
    return { ok: false, reason: `not installed at ${config.bin}: put the absolute path to your pi in planner.json "bin"` };
  }
  const run = (): Promise<{ stdout: string }> =>
    new Promise((resolve, reject) => {
      execFile(config.bin, ["auth", "check", "--model", config.model, "--json"], { env, timeout: 20000 }, (e, stdout) => (e ? reject(e) : resolve({ stdout })));
    });
  try {
    const { stdout } = await run();
    const answer = JSON.parse(stdout) as { status?: unknown; reason?: unknown };
    if (answer?.status === "ready") return { ok: true, reason: "" };
    const why = typeof answer?.reason === "string" && answer.reason ? ` (${answer.reason})` : "";
    return { ok: false, reason: `is not signed in for ${config.model}${why}: run \`pi\` once, or pick a model it can reach` };
  } catch (e) {
    return { ok: false, reason: `could not be run (${e instanceof Error ? e.message : String(e)}): check it with \`pi auth check --model ${config.model}\`` };
  }
}

/** Member-bound OpenCode Go plan account from the shared BYOKit machine
 * store. The key never leaves BYOKit: decide reads it per call. */
async function machineAccounts(env: NodeJS.ProcessEnv) {
  if (noKeyring(env)) throw new Error("BYOKit sign-in lives in the OS keyring; TAKEONE_NO_KEYRING is set");
  const { Accounts, machineStore } = await import("@byokit/accounts");
  const { osKeyringSeal } = await import("@byokit/secrets");
  return new Accounts({ store: (m: string) => machineStore(m, osKeyringSeal({ service: "byokit" })) });
}

/** Member-bound OpenCode Go plan account; the key never leaves BYOKit. */
export async function loadGoAccount(member: string, env: NodeJS.ProcessEnv = process.env): Promise<import("@byokit/decide").OpenCodeGoAccount> {
  return (await machineAccounts(env)).opencodeGo(member);
}

export async function loadOpenAIAccount(member: string, env: NodeJS.ProcessEnv = process.env): Promise<import("@byokit/decide").OpenAIAccount> {
  return (await machineAccounts(env)).chatgpt(member);
}

async function openAIAccountPresent(member: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    return await (await machineAccounts(env)).signedIn(member, "chatgpt");
  } catch {
    return false;
  }
}

/** The launch environment of the person's installed Claude or Codex CLI: no
 * folder variable, so their own sign-in answers. */
function cliLaunchEnv(env: NodeJS.ProcessEnv): { HOME: string; PATH: string } & Record<string, string> {
  return {
    HOME: env.HOME ?? homedir(),
    PATH: env.PATH ?? "",
    ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {}),
    ...(env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } : {}),
  };
}

async function loadCliLaunch(config: CliPlannerConfig, env: NodeJS.ProcessEnv, configDir: string | undefined) {
  const { cliAccounts } = await import("@byokit/accounts/cli");
  const provider = config.backend === "claude-code" ? "claude" : "codex";
  const stateDir = join(takeoneConfigDir({ env, configDir }), "cli-accounts");
  mkdirSync(dirname(stateDir), { recursive: true });
  return cliAccounts({ stateDir, bins: { [provider]: config.bin }, env: cliLaunchEnv(env), installed: true }).launch(config.account);
}

type CliLaunch = Awaited<ReturnType<typeof loadCliLaunch>>;
type CliAccount = Extract<CliLaunch, { ok: true }>;
type CliServed = { ok: true; launch: CliAccount } | { ok: false; message: string };

/** The installed CLI's own sign-in as the kit's roster reports it. Whether the
 * backend can serve the run (claude.ai subscription, keyring-stored Codex login)
 * is decided by the kit's backend at call time, not reimplemented here. A probe
 * that throws only means the found account cannot serve, never a raw error. */
async function cliReady(config: CliPlannerConfig, env: NodeJS.ProcessEnv, configDir: string | undefined): Promise<CliServed> {
  const name = config.backend === "claude-code" ? "Claude" : "Codex";
  try {
    const launch = await loadCliLaunch(config, env, configDir);
    return launch.ok ? { ok: true, launch } : { ok: false, message: launch.message };
  } catch (e) {
    return { ok: false, message: `the installed ${name} CLI account could not be started (${e instanceof Error ? e.message : String(e)})` };
  }
}

function executable(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = resolve(dir, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* try next PATH entry */ }
  }
  return undefined;
}

/** The model a discovered plan account serves: the first model its own live
 * list offers. The kit keeps no tier list of its own (`Provider.models` is
 * gone), so takeone names no model either. An account whose list cannot be read
 * cannot serve, and discovery falls through to the next account or the stored
 * key rather than guessing a model the plan may not run. */
async function planAccountModel(member: string, route: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const accounts = await machineAccounts(env);
    const rows = await accounts.list(member);
    for (const row of rows) {
      // The kit resolves these two handles to exactly this id (its providerKey
      // splits on "." only, so for both keys the id is the route key).
      if (row.id !== route || row.state !== "ready") continue;
      const first = (await accounts.models(member, row.id)).find((m) => m.available);
      if (first) return first.id;
    }
    return null;
  } catch {
    return null;
  }
}

interface Discovered {
  config: PlannerConfig | null;
  refusal: string | null;
  /** A signed-in account that cannot serve and was passed over, in plain words. */
  skipped: string | null;
  /** The validated launch behind a discovered CLI config, for reuse. */
  cli: CliAccount | null;
}

/** Why a signed-in Claude login cannot serve takeone's ask, or null when it
 * can. An API key, Bedrock or Vertex login is a real, working Claude sign-in
 * that bills per call and cannot answer the subscription ask the backend makes;
 * the kit reports which one it is (`SignInMethod`, read from the CLI's own
 * `auth status`), so the person is told that instead of watching the run
 * quietly fall back. An absent method means the CLI did not say, so the account
 * is still tried and a refusal at call time stops the run honestly. */
function unusableClaudeLogin(method: SignInMethod | undefined): string | null {
  if (method === "api_key") return "the signed-in Claude CLI is signed in with an API key, not a Claude subscription; sign in with `claude` to plan with it";
  if (method === "other") return "the signed-in Claude CLI is signed in through a cloud provider or token (Bedrock, Vertex), not a Claude subscription; sign in with `claude` to plan with it";
  return null;
}

async function discoverCliAccount(env: NodeJS.ProcessEnv, configDir: string | undefined): Promise<Discovered> {
  const bins = { claude: executable("claude", env), codex: executable("codex", env) };
  let refusal: string | null = null;
  let skipped: string | null = null;
  for (const provider of ["claude", "codex"] as const) {
    const bin = bins[provider];
    if (!bin) continue;
    const config: CliPlannerConfig = { backend: provider === "claude" ? "claude-code" : "codex", auth: "account", account: `installed-${provider}`, bin };
    const ready = await cliReady(config, env, configDir);
    if (!ready.ok) {
      refusal ??= ready.message;
      continue;
    }
    if (provider === "claude") {
      const why = unusableClaudeLogin(ready.launch.account.method);
      if (why) {
        // Signed in, but not in a way this backend can ask. The stored key and
        // the other accounts still get their turn; the reason is kept so the
        // run can say which account it passed over.
        skipped ??= why;
        continue;
      }
    }
    return { config, refusal: null, skipped, cli: ready.launch };
  }
  return { config: null, refusal, skipped, cli: null };
}

/** The user picked nothing, and the order is the one this module owns: a
 * signed-in installed CLI that can serve, then a signed-in BYOKit plan account
 * whose own list names a model, then the stored key and local rules below. The
 * model of a discovered CLI comes from the backend's own default. */
async function discoverAccount(member: string, env: NodeJS.ProcessEnv, configDir: string | undefined): Promise<Discovered> {
  const cli = await discoverCliAccount(env, configDir);
  if (cli.config) return cli;
  if (await openAIAccountPresent(member, env)) {
    const model = await planAccountModel(member, "chatgpt", env);
    if (model) return { config: { backend: "openai", auth: "account", model }, refusal: cli.refusal, skipped: cli.skipped, cli: null };
    cli.refusal ??= "the signed-in ChatGPT account named no model this planner can ask";
  }
  if (await goAccountPresent(member, env)) {
    const model = await planAccountModel(member, "opencode:plan_key:opencode-go", env);
    if (model) return { config: { backend: "opencode-go", auth: "account", model }, refusal: cli.refusal, skipped: cli.skipped, cli: null };
    cli.refusal ??= "the signed-in OpenCode Go account named no model this planner can ask";
  }
  return { config: null, refusal: cli.refusal, skipped: cli.skipped, cli: null };
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
  config: PlannerConfig;
  label: string;
}> {
  try {
    const r = await resolvePlanner({ ...o, probe: true });
    if (r.active) {
      return { available: true, detail: `AI planner: found and using ${r.label}`, config: r.config, label: r.label };
    }
    const c = r.config as { backend: string; auth: string };
    if (r.defaulted) {
      return {
        available: false,
        detail: r.refusal
          ? `AI planner off: ${r.refusal}; films use fallback rules (set a key: read -rs k; printf %s "$k" | takeone key set)`
          : "AI planner off: no signed-in account or stored key was found; films use fallback rules (set a key: read -rs k; printf %s \"$k\" | takeone key set)",
        config: r.config,
        label: r.label,
      };
    }
    return {
      available: false,
      detail: r.refusal
        ? `AI planner off: ${r.refusal}`
        : `AI planner off: films use fallback rules (no ${c.auth === "account" ? "sign-in" : "key"} for ${r.label})`,
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

const OPTIONAL_CAMERA_KEY = /_(shot|idle|follow)$/;

/** Refuse to store beats the mapping cannot use: an abstained or missing
 * field means the whole beat falls back, so caching it would only replay the
 * fallback and hide a model that recovered since. Optional camera keys are
 * exempt because the mapping treats an abstention there as no choice. */
export function gateUnusable(cache: DecideCache): DecideCache {
  return {
    get: (key) => cache.get(key),
    set: (key, value) => {
      if (Object.entries(value).every(([k, a]) => OPTIONAL_CAMERA_KEY.test(k) || (a && typeof a === "object" && !a.abstained))) {
        return cache.set(key, value);
      }
    },
  };
}

/** Refuse only requests with no usable answer at all: a partly answered request
 * keeps its good fields, and the caller maps each field on its own. */
export function gateEmpty(cache: DecideCache): DecideCache {
  return {
    get: (key) => cache.get(key),
    set: (key, value) => {
      if (Object.values(value).some((a) => a && typeof a === "object" && !a.abstained)) {
        return cache.set(key, value);
      }
    },
  };
}

export interface AskOutcome {
  decisionSource: "cache" | "api" | "failed";
  /** Why a failed ask failed, per call: the kit's code and status, its reason and the shape of the provider's reply. No keys, no model text. */
  failure?: string;
  answers?: Record<string, Answer>;
  inputTokens?: number;
  outputTokens?: number;
}

/** Statuses that stop the run before rendering instead of falling back: the
 * provider is limited, refused or too slow, and silently using rules would
 * bill nothing yet hide the outage. Anything else fails the beat, as before.
 * This stays the text fallback for what the kit reports without a code (a bare
 * HTTP status, a timeout); the codes below are the primary signal. */
const LIMIT_RE = /failed: http (429|401|402|403)\b|timed out/;

/** The kit's refusal codes, in the words a person reads. `bad_reply` is not
 * here: a model that answered in the wrong shape is a per-beat failure, not a
 * refusal, and falls back instead of stopping the film. */
const REFUSAL_WORDS: Record<RefusalCode, string> = {
  key_refused: "refused the account or key",
  out_of_credit: "has no credit left for this account",
  rate_limited: "rate limited the account",
};

/** The kit's failure code for an abstained answer, or undefined when it did
 * not classify one. Read defensively: the answer crosses a package boundary. */
function failureCode(answer: Answer): FailureCode | undefined {
  const code = (answer as { failure?: { code?: unknown } }).failure?.code;
  return typeof code === "string" ? (code as FailureCode) : undefined;
}

/** What to tell the user about a refusal, or null when this answer is not one. */
function refusalReason(a: Answer): string | null {
  const code = failureCode(a);
  if (!code || code === "bad_reply") return null;
  const status = (a as { failure?: { status?: unknown } }).failure?.status;
  return `${REFUSAL_WORDS[code]}${typeof status === "number" ? ` (HTTP ${status})` : ""}`;
}

/** The provider cannot serve this run: rate-limited, unauthorized, or timed
 * out. The CLI exits 3 with the choices; nothing renders. A missing
 * credential names the sign-in and key instead of a wait, because no rerun
 * brings either of them back. */
export class PlannerUnavailable extends Error {
  readonly provider: string;
  readonly reason: string;
  /** True when nothing was wrong with the provider: no credential was there. */
  readonly credentialMissing: boolean;
  constructor(provider: string, reason: string, o: { credentialMissing?: boolean } = {}) {
    const missing = o.credentialMissing === true;
    super(
      `AI planner: ${provider} ${reason}. ` +
        (missing
          ? `Choose: sign that account in, store a key with takeone key set, ` +
            `or run with --no-ai for fallback rules.`
          : `Choose: wait and rerun, run with --no-ai for fallback rules, ` +
            `or switch provider yourself with takeone key set --backend <name> --model <model>.`),
    );
    this.name = "PlannerUnavailable";
    this.provider = provider;
    this.reason = reason;
    this.credentialMissing = missing;
  }
}

/** Why the run must stop, or null when every beat may fall back to its
 * heuristic. A refusal the kit classified is named in plain words; a status it
 * left unclassified (or a timeout, which carries no code) is read from the
 * reason the kit writes, so a stop never weakens. */
function stopReason(answers: Record<string, Answer>): string | null {
  for (const a of Object.values(answers)) {
    if (!a || typeof a !== "object") continue;
    const refused = refusalReason(a);
    if (refused) return refused;
    const reason = a.reason;
    if (typeof reason === "string" && LIMIT_RE.test(reason)) return reason;
  }
  return null;
}

/** How the account behind a CLI call is signed in, for the stop message. The
 * kit reads it from the CLI's own `auth status`; an absent one means the CLI
 * did not say. */
function cliSignIn(launch: CliAccount): string {
  const method = launch.account.method;
  if (method === "subscription") return "its Claude subscription sign-in";
  if (method === "api_key") return "its API key sign-in";
  if (method === "other") return "its cloud provider or token sign-in";
  return "its sign-in";
}

/** A CLI backend that refuses an ask abstains every question with the bare
 * `<backend> failed` the kit writes when the account will not serve (its
 * sign-in lapsed, or the process could not answer). That is a true refusal, so
 * the run stops instead of falling back per beat while still claiming the
 * account. The kit now reports a wrong-shaped reply as `bad_reply` apart from a
 * refusal, and that one does fall back per beat. */
function cliRefused(answers: Record<string, Answer>, backend: string): boolean {
  const all = Object.values(answers);
  return all.length > 0 && all.every((a) => a && a.abstained && failureCode(a) !== "bad_reply" && a.reason === `${backend} failed`);
}

/** The shape of the provider's reply behind an answer (stop reason and block types), enough to tell a
 * truncated or tool-less reply from a good one without carrying any model text. */
function replyShape(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "no reply body";
  const r = raw as { stop_reason?: unknown; content?: unknown; error?: { type?: unknown; message?: unknown } };
  const parts: string[] = [];
  if (typeof r.stop_reason === "string") parts.push(`stop_reason ${r.stop_reason}`);
  if (Array.isArray(r.content)) {
    const types = r.content.map((b) => (b && typeof b === "object" && typeof (b as { type?: unknown }).type === "string" ? (b as { type: string }).type : "?"));
    parts.push(`content [${types.join(", ")}]`);
  }
  if (r.error && typeof r.error.type === "string") parts.push(`error ${r.error.type}${typeof r.error.message === "string" ? `: ${r.error.message.slice(0, 160)}` : ""}`);
  return parts.length ? parts.join(", ") : "reply without content";
}

/** One line saying why these answers all failed: each distinct kit code, status and reason with the reply shape. */
function failureSummary(answers: Record<string, Answer>): string {
  const seen = new Set<string>();
  for (const a of Object.values(answers)) {
    if (!a || typeof a !== "object") continue;
    const f = (a as { failure?: { code?: unknown; status?: unknown } }).failure;
    const bits = [
      a.abstained ? "abstained" : "answered but unusable",
      ...(typeof f?.code === "string" ? [`code ${f.code}`] : []),
      ...(typeof f?.status === "number" ? [`HTTP ${f.status}`] : []),
      ...(typeof a.reason === "string" ? [`reason "${a.reason.slice(0, 160)}"`] : []),
      replyShape((a as { raw?: unknown }).raw),
    ];
    seen.add(bits.join(", "));
  }
  return [...seen].join("; ") || "no answers returned";
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
  // Camera choices are optional: an abstained or missing one leaves the rule in charge.
  const flag = (k: string): boolean | undefined => {
    const a = answers[k];
    return a && !a.abstained && typeof a.answer === "boolean" ? a.answer : undefined;
  };
  return { focus_start, focus_end, tightness, new_subject, key_moment, shot: flag("shot"), idle: flag("idle"), follow: flag("follow") };
}

/** The decide host for a resolved planner: its credential or account, and
 * the injectable fetch. */
async function plannerHost(planner: ResolvedPlanner, fetchImpl?: typeof fetch): Promise<import("@byokit/decide").ConfigHost> {
  const c = planner.config as { backend: string };
  if ((planner.config as { auth: string }).auth === "account") {
    if (planner.member === null) throw new Error("account planner resolved without a member");
    return {
      ...(c.backend === "openai"
        ? { account: await loadOpenAIAccount(planner.member) }
        : { accounts: { "opencode-go": await loadGoAccount(planner.member) } }),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      cacheScope: planner.member,
    };
  }
  const send = c.backend === "minimax" ? withOutputBudget(fetchImpl ?? globalThis.fetch) : fetchImpl;
  return {
    ...(planner.key !== null ? { keys: { [c.backend]: planner.key } } : {}),
    ...(send ? { fetch: send } : {}),
  };
}

/** Output budget for a MiniMax ask. BYOKit's Messages backend caps a reply at
 * 1024 tokens and its decide config has no option to raise it; MiniMax spends
 * that on reasoning before the forced `decisions` tool call, so every reply was
 * cut and every beat fell back (live run, 4 requests, 4094 output tokens). */
const MINIMAX_MAX_TOKENS = 8192;

/** A fetch that gives a MiniMax ask the larger output budget and changes nothing else. */
function withOutputBudget(inner: typeof fetch): typeof fetch {
  return (async (url, init) => {
    if (typeof init?.body !== "string") return inner(url, init);
    let body: Record<string, unknown>;
    try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { return inner(url, init); }
    if (typeof body.max_tokens !== "number" || body.max_tokens >= MINIMAX_MAX_TOKENS) return inner(url, init);
    return inner(url, { ...init, body: JSON.stringify({ ...body, max_tokens: MINIMAX_MAX_TOKENS }) });
  }) as typeof fetch;
}

const PROBE_PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==", "base64"));

/** Whether the decider BYOKit builds for this config reads images. decide
 * refuses images (UnsupportedImagesError) before any request when the built
 * backend does not support them; otherwise it reaches fetch, which here is a
 * local stub that sends nothing. TakeOne keeps no model list of its own. */
export async function seesImages(planner: ResolvedPlanner): Promise<boolean> {
  // This planner does not send images to the installed Claude, Codex or pi CLI
  // today: enabling that is a separate, deliberate step in the image-planning work.
  const backend = (planner.config as { backend: string }).backend;
  if (backend === "codex" || backend === "claude-code" || backend === "pi") return false;
  let reached = false;
  const stub = (async () => {
    reached = true;
    throw new Error("image capability probe: nothing is sent");
  }) as typeof fetch;
  try {
    await decide({}, { probe: { kind: "yesno", question: "probe", images: ["probe"] } }, {
      config: { ...(planner.config as DecideConfig), maxRetries: 0 },
      host: await plannerHost(planner, stub),
      privacy: "may-leave",
      images: [{ id: "probe", mime: "image/png", bytes: PROBE_PNG }],
    });
  } catch {
    // UnsupportedImagesError, or a backend that cannot be built here: text only.
  }
  return reached;
}

/** Ask one chunk of beats through the configured decider. Never throws on
 * transport or mapping failures (failed beats keep the heuristic); throws
 * PlannerUnavailable when the provider itself cannot serve the run. An answer
 * the `usable` check refuses comes back as "failed" with its answers, so the
 * caller can keep the beats that do map. */
export async function askChunk(
  state: unknown,
  questions: Record<string, Question>,
  planner: ResolvedPlanner,
  cache: DecideCache,
  o: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    usable?: (answers: Record<string, Answer>) => boolean;
    images?: ImageInput[];
    /** Cache partly answered requests too: the caller maps each field and falls back per field. */
    keepAnswers?: boolean;
  } = {},
): Promise<AskOutcome> {
  const c = planner.config as { backend: string; model?: string };
  let runDecider: () => Promise<Record<string, Answer>>;
  if (c.backend === "pi") {
    const config = planner.config as PiPlannerConfig;
    const backend = pi({ bin: config.bin, model: config.model, timeoutMs: 120_000 });
    // Answers cached per model and binary: a different pi or model is a different decider.
    const scopedCache: DecideCache = {
      get: (key) => cache.get(`pi:${config.model}:${config.bin}:${key}`),
      set: (key, value) => cache.set(`pi:${config.model}:${config.bin}:${key}`, value),
    };
    runDecider = async () => {
      const answered = await decide(state, questions, {
        backends: [backend],
        privacy: "may-leave",
        timeoutMs: o.timeoutMs ?? 120_000,
        cache: o.keepAnswers ? gateEmpty(scopedCache) : gateUnusable(scopedCache),
        ...(o.images?.length ? { images: o.images } : {}),
      });
      // A pi run that refused outright (the key or model it needs is gone)
      // answers nothing at all. Stop the run with the check the user can run
      // instead of letting every beat fall back; a wrong-shaped reply is
      // `bad_reply` and still falls back per beat.
      if (cliRefused(answered, "pi")) {
        throw new PlannerUnavailable(planner.label, `pi could not answer for ${config.model}: check it with \`pi auth check --model ${config.model}\``);
      }
      return answered;
    };
  } else if (c.backend === "codex" || c.backend === "claude-code") {
    if (planner.member === null) throw new Error("account planner resolved without a member");
    const config = planner.config as CliPlannerConfig;
    const account = planner.cliLaunch;
    if (account === null) throw new Error("CLI planner resolved without a launch");
    const backend = config.backend === "codex"
      ? codex({ bin: config.bin, account, model: config.model, timeoutMs: 120_000 })
      : claudeCode({ bin: config.bin, account, model: config.model, timeoutMs: 120_000 });
    const scopedCache: DecideCache = {
      get: (key) => cache.get(`${config.backend}:${modelOf(config)}:${config.account}:${key}`),
      set: (key, value) => cache.set(`${config.backend}:${modelOf(config)}:${config.account}:${key}`, value),
    };
    runDecider = async () => {
      const answered = await decide(state, questions, {
        backends: [backend],
        privacy: "may-leave",
        timeoutMs: o.timeoutMs ?? 120_000,
        cache: o.keepAnswers ? gateEmpty(scopedCache) : gateUnusable(scopedCache),
        ...(o.images?.length ? { images: o.images } : {}),
      });
      // The signed-in CLI refused the ask (the sign-in lapsed, or the account
      // no longer serves): stop the run as unavailable rather than falling back
      // per beat while still claiming that account. Only a true refusal stops;
      // a wrong-shaped reply is `bad_reply` and falls back per beat.
      if (cliRefused(answered, config.backend)) {
        throw new PlannerUnavailable(planner.label, `${config.backend === "codex" ? "codex" : "claude"} could not answer for ${config.model ?? "its default model"}: check ${cliSignIn(account)} with \`${config.backend === "codex" ? "codex login status" : "claude auth status"}\``);
      }
      return answered;
    };
  } else {
    const host = await plannerHost(planner, o.fetchImpl);
    runDecider = () => decide(state, questions, {
      config: planner.config as DecideConfig,
      host,
      privacy: "may-leave",
      timeoutMs: o.timeoutMs ?? (c.backend === "minimax" ? MINIMAX_TIMEOUT_MS : DECIDE_TIMEOUT_MS),
      cache: o.keepAnswers ? gateEmpty(cache) : gateUnusable(cache),
      ...(o.images?.length ? { images: o.images } : {}),
    });
  }
  let answers: Record<string, Answer>;
  try {
    answers = await runDecider();
  } catch (e) {
    if (e instanceof UnsupportedAccountError || e instanceof UnsupportedImagesError || e instanceof ConfigError) {
      throw new PlannerUnavailable(planner.label, e instanceof Error ? e.message : String(e));
    }
    throw e;
  }
  if (!answers || typeof answers !== "object") return { decisionSource: "failed", failure: "the decider returned no answers object" };
  const stopped = stopReason(answers);
  if (stopped) throw new PlannerUnavailable(planner.label, stopped);
  const usage = validUsageTokens(answers);
  if (usage === null) return { decisionSource: "failed", failure: "the provider reported malformed token usage" };
  const tokens = {
    ...(usage.input !== undefined ? { inputTokens: usage.input } : {}),
    ...(usage.output !== undefined ? { outputTokens: usage.output } : {}),
  };
  if (!Object.values(answers).some((a) => a && !a.abstained)) return { decisionSource: "failed", failure: failureSummary(answers), ...tokens };
  if (o.usable && !o.usable(answers)) return { decisionSource: "failed", answers, failure: failureSummary(answers), ...tokens };
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
