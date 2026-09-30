/** Jev credentials: persistence and encryption belong to BYOKit. */
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileStore, keyringStore, overrideStore, writeFileAtomic, KeystoreError, type Keystore } from "@byokit/secrets";

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

/** Keyring first; only absent/unsupported keyrings select a sealed file. */
export function persistentKeys(o: KeyOptions = {}): Keystore {
  if (o.store) return o.store;
  const env = o.env ?? process.env;
  try {
    return keyringStore({ service: "takeone", env: {
      ...(env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS } : {}),
      ...(env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR } : {}),
    } });
  } catch (error) {
    if (!(error instanceof KeystoreError) || !["unavailable", "unsupported"].includes(error.code)) throw error;
  }
  const fd = env.TAKEONE_SECRETS_PASSPHRASE_FD;
  if (!fd || !/^\d+$/.test(fd) || Number(fd) < 3 || !Number.isSafeInteger(Number(fd))) {
    throw new Error("no OS keyring; supply a passphrase on TAKEONE_SECRETS_PASSPHRASE_FD (an open fd >= 3) for the BYOKit sealed store");
  }
  // fileStore retains these bytes for subsequent operations; it owns encryption.
  const passphrase = readFileSync(Number(fd));
  return fileStore({ path: join(configRoot(o), "takeone", "secrets.json"), passphrase });
}

function legacyValue(line: string): string | null {
  const s = line.trim();
  if (!s || s.startsWith("#")) return null;
  const m = /^TYPESAFE_API_KEY\s*=\s*(.+)$/.exec(s);
  return m?.[1]?.trim() ?? (!s.includes("=") ? s : null);
}

/** Verify persistence before removing every old key line; preserve unrelated settings. */
async function migrate(store: Keystore, path: string): Promise<void> {
  if (!existsSync(path)) return;
  const source = readFileSync(path, "utf8");
  const lines = source.split("\n");
  const key = lines.map(legacyValue).find((value) => value !== null);
  if (!key) return;
  if (await store.get(JEV_SECRET) !== null) return;
  await store.set(JEV_SECRET, key);
  if (await store.get(JEV_SECRET) !== key) throw new Error("Jev key migration could not verify the secret store");
  // Do not replace a file edited while the keyring operation was in progress.
  if (readFileSync(path, "utf8") !== source) throw new Error("legacy key file changed during migration; retry");
  const remaining = lines.filter((line) => legacyValue(line) === null).join("\n");
  if (remaining.trim()) await writeFileAtomic(path, remaining);
  else unlinkSync(path);
}

/** The environment is a host-passed BYOKit override; it never enters persistence. */
export async function loadApiKey(o: KeyOptions = {}): Promise<string | null> {
  const env = o.env ?? process.env;
  if (env.TYPESAFE_API_KEY) return overrideStore({ [JEV_SECRET]: env.TYPESAFE_API_KEY }).get(JEV_SECRET);
  const store = persistentKeys(o);
  const legacyPaths = new Set([
    join(env.HOME ?? homedir(), ".config", "takeone", "env"),
    join(configRoot(o), "takeone", "env"),
  ]);
  for (const path of legacyPaths) await migrate(store, path);
  return store.get(JEV_SECRET);
}

/** Safe presence probe: neither migrates nor prints the credential. */
export async function keyStatus(o: KeyOptions = {}): Promise<{ available: boolean; detail: string }> {
  try {
    const env = o.env ?? process.env;
    const store = env.TYPESAFE_API_KEY
      ? overrideStore({ [JEV_SECRET]: env.TYPESAFE_API_KEY }) : persistentKeys(o);
    const available = !!await store.get(JEV_SECRET);
    return { available, detail: available ? "Jev key available through BYOKit" : "no Jev key; run takeone key set (stdin)" };
  } catch {
    return { available: false, detail: "Jev store unavailable; enable the OS keyring or supply TAKEONE_SECRETS_PASSPHRASE_FD for the BYOKit sealed store" };
  }
}

/** Read a key from piped stdin only; argv is intentionally never echoed. */
export async function setKeyFromStdin(input: AsyncIterable<Uint8Array | string>, o: KeyOptions = {}): Promise<void> {
  let key = "";
  for await (const chunk of input) {
    key += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(key) > 16_384) throw new Error("key input too large");
  }
  key = key.trim();
  if (!key || /[\r\n\0]/.test(key)) throw new Error("stdin must contain one nonempty key line");
  const store = persistentKeys(o);
  await store.set(JEV_SECRET, key);
  if (await store.get(JEV_SECRET) !== key) throw new Error("could not verify the stored Jev key");
}
