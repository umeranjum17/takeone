/** Planner credentials: persistence and encryption belong to BYOKit.
 * TakeOne never reads a key from an environment variable: every credential
 * comes from the OS keyring or the BYOKit sealed file (apiKey slots), from a
 * host-passed fd (capture), or from the member's BYOKit sign-in store
 * (account auth). */
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileStore, keyringStore, writeFileAtomic, KeystoreError, type Keystore } from "@byokit/secrets";

export const JEV_SECRET = "jev";

export interface KeyOptions {
  env?: NodeJS.ProcessEnv;
  configDir?: string;
  /** Host-owned backend; tests pass BYOKit's overrideStore, never a real keyring. */
  store?: Keystore;
}

function configRoot(o: KeyOptions): string {
  const env = o.env ?? process.env;
  return o.configDir ?? env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config");
}

/** takeone's own config dir: planner.json lives next to secrets.json. */
export function takeoneConfigDir(o: KeyOptions = {}): string {
  return join(configRoot(o), "takeone");
}

/** Only an explicit enabled value skips the keyring: wrappers and CI unset flags with 0, false or "". */
export function noKeyring(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes)$/i.test(env.TAKEONE_NO_KEYRING ?? "");
}

function sealedStore(env: NodeJS.ProcessEnv, o: KeyOptions): Keystore {
  const fd = env.TAKEONE_SECRETS_PASSPHRASE_FD;
  if (!fd || !/^\d+$/.test(fd) || Number(fd) < 3 || !Number.isSafeInteger(Number(fd))) {
    throw new Error("no OS keyring; supply a passphrase on TAKEONE_SECRETS_PASSPHRASE_FD (an open fd >= 3) for the BYOKit sealed store");
  }
  // fileStore retains these bytes for subsequent operations; it owns encryption.
  const passphrase = readFileSync(Number(fd));
  return fileStore({ path: join(configRoot(o), "takeone", "secrets.json"), passphrase });
}

/** Keyring first; a failed keyring operation selects the sealed file when configured.
  * TAKEONE_NO_KEYRING skips the OS keyring entirely, so an isolated run (throwaway
  * HOME, CI) cannot reach the host session bus even when its env vars are inherited. */
export function persistentKeys(o: KeyOptions = {}): Keystore {
  if (o.store) return o.store;
  const env = o.env ?? process.env;
  if (noKeyring(env)) return sealedStore(env, o);
  try {
    const keyring = keyringStore({ service: "takeone", env: {
      ...(env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS } : {}),
      ...(env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR } : {}),
    } });
    let fallback: Keystore | undefined;
    const useFallback = (error: unknown): Keystore => {
      if (!(error instanceof KeystoreError) || !["unavailable", "failed"].includes(error.code)) throw error;
      return fallback ??= sealedStore(env, o);
    };
    return {
      async get(name) {
        if (fallback) return fallback.get(name);
        try {
          const value = await keyring.get(name);
          // A keyring CLI can report "not found" when its service is unreachable.
          if (value !== null || !env.TAKEONE_SECRETS_PASSPHRASE_FD) return value;
          return useFallback(new KeystoreError("unavailable", "keyring entry unavailable")).get(name);
        }
        catch (error) { return useFallback(error).get(name); }
      },
      async set(name, secret) {
        if (fallback) return fallback.set(name, secret);
        try { return await keyring.set(name, secret); }
        catch (error) { return useFallback(error).set(name, secret); }
      },
      async delete(name) {
        if (fallback) return fallback.delete(name);
        try { return await keyring.delete(name); }
        catch (error) { return useFallback(error).delete(name); }
      },
    };
  } catch (error) {
    if (!(error instanceof KeystoreError) || !["unavailable", "unsupported"].includes(error.code)) throw error;
  }
  return sealedStore(env, o);
}

function legacyPath(env: NodeJS.ProcessEnv): string {
  return join(env.HOME ?? homedir(), ".config", "takeone", "env");
}

function legacyValue(line: string): string | null {
  const s = line.trim();
  if (!s || s.startsWith("#")) return null;
  const m = /^TYPESAFE_API_KEY\s*=\s*(.+)$/.exec(s);
  return m?.[1]?.trim() ?? (!s.includes("=") ? s : null);
}

/** Verify persistence before removing every old key line; preserve unrelated settings. */
async function migrate(store: Keystore, path: string, slot: string): Promise<void> {
  if (!existsSync(path)) return;
  const source = readFileSync(path, "utf8");
  const lines = source.split("\n");
  const key = lines.map(legacyValue).find((value) => value !== null);
  if (!key) return;
  const stored = await store.get(slot);
  if (stored !== null && stored !== key) return;
  if (stored === null) await store.set(slot, key);
  if (await store.get(slot) !== key) throw new Error("planner key migration could not verify the secret store");
  // Do not replace a file edited while the keyring operation was in progress.
  if (readFileSync(path, "utf8") !== source) throw new Error("legacy key file changed during migration; retry");
  const remaining = lines.filter((line) => legacyValue(line) === null).join("\n");
  if (remaining.trim()) await writeFileAtomic(path, remaining);
  else unlinkSync(path);
}

/** Load one backend's apiKey credential from the persistent store. The legacy
 * TYPESAFE file migrates into the Jev slot; the environment is never read. */
export async function loadPlannerKey(slot: string, o: KeyOptions = {}): Promise<string | null> {
  const env = o.env ?? process.env;
  const store = persistentKeys(o);
  if (slot === JEV_SECRET) await migrate(store, legacyPath(env), slot);
  return store.get(slot);
}

function legacyKey(o: KeyOptions): string | null {
  const path = legacyPath(o.env ?? process.env);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").split("\n").map(legacyValue).find((value) => value !== null) ?? null;
}

/** Read one backend's apiKey credential from the persistent store. The Jev slot
 * also reads the legacy TYPESAFE file without migrating or changing it; the
 * environment is never read. */
export async function readPlannerKey(slot: string, o: KeyOptions = {}): Promise<string | null> {
  const stored = await persistentKeys(o).get(slot);
  if (stored !== null || slot !== JEV_SECRET) return stored;
  return legacyKey(o);
}

/** Read a key from piped stdin only; argv is intentionally never echoed. */
export async function setKeyFromStdin(input: AsyncIterable<Uint8Array | string>, slot: string = JEV_SECRET, o: KeyOptions = {}): Promise<void> {
  let key = "";
  for await (const chunk of input) {
    key += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(key) > 16_384) throw new Error("key input too large");
  }
  key = key.trim();
  if (!key || /[\r\n\0]/.test(key)) throw new Error("stdin must contain one nonempty key line");
  const store = persistentKeys(o);
  await store.set(slot, key);
  if (await store.get(slot) !== key) throw new Error("could not verify the stored key");
}
