// Zero-dependency Chrome DevTools Protocol client over Node's built-in WebSocket.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface Browser {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  on(method: string, fn: (params: Record<string, unknown>) => void): void;
  close(): Promise<void>;
}

export interface LaunchOptions {
  width: number;
  height: number;
  dsf?: number;
  /** Renders run offline; only URL ingest turns the network on. */
  network?: boolean;
}

/** The flag set the determinism gate was proved on. Changing it needs the gate re-run. */
export function shellFlags(o: LaunchOptions, profile: string): string[] {
  return [
    "--headless", "--no-sandbox", "--hide-scrollbars", "--mute-audio",
    "--font-render-hinting=none", "--disable-lcd-text", "--force-color-profile=srgb",
    "--allow-file-access-from-files", `--force-device-scale-factor=${o.dsf ?? 1}`,
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    ...(o.network ? [] : ["--proxy-server=127.0.0.1:9", "--proxy-bypass-list=<-loopback>"]),
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    `--window-size=${o.width},${o.height}`, "about:blank",
  ];
}

export async function launch(shell: string, o: LaunchOptions): Promise<Browser> {
  const profile = await mkdtemp(join(tmpdir(), "takeone-motion-"));
  const child = spawn(shell, shellFlags(o, profile), { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "", failure: Error | undefined, socket: WebSocket | undefined, id = 0;
  child.on("error", (e) => { failure = e; });
  child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
  const pending = new Map<number, { ok: (v: unknown) => void; bad: (e: Error) => void; method: string; timer: NodeJS.Timeout }>();
  const listeners = new Map<string, ((p: Record<string, unknown>) => void)[]>();
  const rejectAll = (e: Error) => { for (const p of pending.values()) { clearTimeout(p.timer); p.bad(e); } pending.clear(); };
  const close = async () => {
    rejectAll(new Error("browser closed"));
    socket?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once("close", r));
      child.kill("SIGTERM");
      await Promise.race([exited, delay(2000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    }
    await rm(profile, { recursive: true, force: true });
  };
  try {
    let port: string | undefined;
    for (let i = 0; i < 600 && !port; i++) {
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error(`chrome exited ${child.exitCode}: ${stderr.split("\n").slice(-4).join(" | ")}`);
      port = await readFile(join(profile, "DevToolsActivePort"), "utf8").then((s) => s.split("\n")[0], () => undefined);
      if (!port) await delay(25);
    }
    if (!port) throw new Error(`chrome did not expose DevToolsActivePort: ${stderr.split("\n").slice(-4).join(" | ")}`);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json() as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("chrome has no page target");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    socket = ws;
    await new Promise<void>((ok, bad) => {
      const timer = setTimeout(() => bad(new Error("CDP connect timed out")), 5000);
      ws.onopen = () => { clearTimeout(timer); ok(); };
      ws.onerror = () => { clearTimeout(timer); bad(new Error("CDP connect failed")); };
    });
    ws.onmessage = ({ data }) => {
      const m = JSON.parse(String(data)) as { id?: number; method?: string; params?: Record<string, unknown>; error?: { message: string }; result?: unknown };
      if (m.id !== undefined) {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id); clearTimeout(p.timer);
        if (m.error) p.bad(new Error(`${p.method}: ${m.error.message}`)); else p.ok(m.result);
      } else if (m.method) for (const fn of listeners.get(m.method) ?? []) fn(m.params ?? {});
    };
    ws.onclose = () => rejectAll(new Error("CDP disconnected"));
    const send = <T,>(method: string, params: Record<string, unknown> = {}) => new Promise<T>((ok, bad) => {
      const seq = ++id;
      const timer = setTimeout(() => { pending.delete(seq); bad(new Error(`CDP timeout: ${method}`)); }, 120_000);
      pending.set(seq, { ok: ok as (v: unknown) => void, bad, method, timer });
      ws.send(JSON.stringify({ id: seq, method, params }));
    });
    const evaluate = async <T,>(expression: string): Promise<T> => {
      const r = await send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
        "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    };
    const on = (method: string, fn: (p: Record<string, unknown>) => void) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
    return { send, evaluate, on, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/** Navigate and wait for the load event. */
export async function navigate(b: Browser, url: string): Promise<void> {
  await b.send("Page.enable");
  const loaded = new Promise<void>((r) => b.on("Page.loadEventFired", () => r()));
  const nav = await b.send<{ errorText?: string }>("Page.navigate", { url });
  if (nav.errorText) throw new Error(`navigate ${url}: ${nav.errorText}`);
  let timer: ReturnType<typeof setTimeout>;
  try { await Promise.race([loaded, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("page load timed out")), 30000); })]); } finally { clearTimeout(timer!); }
}
