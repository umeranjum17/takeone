/**
 * `--flow FILE`: a lead agent drives an app flow while a recorder captures it.
 *
 * The flow file is JSON: `{"steps": [{"wait_ms": 1500}, {"run": ["adb", "-s", "emulator-5554", "shell", "input", "tap", "540", "900"]}]}`.
 * A `run` step is an argv list started without a shell (so the lead's own driver, such as
 * chrome-devtools-axi, adb or xcrun, does the driving); a `wait_ms` step holds. The steps start
 * once the recorder reports frames flowing and the recording stops itself after the last one,
 * through the same SIGINT `takeone stop` sends. Capture is the existing adapters' job: this
 * file records nothing and makes no model call.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type FlowStep = { wait_ms: number } | { run: string[]; timeout_ms: number };

export interface Flow {
  steps: FlowStep[];
  dir: string;
}

const STEP_TIMEOUT_MS = 60_000;
const MAX_WAIT_MS = 600_000;

export class FlowError extends Error {
  readonly code = "invalid-flow";
  readonly hint = "a flow file is {\"steps\": [{\"wait_ms\": 1000}, {\"run\": [\"command\", \"arg\"]}]}; see docs/recording.md";
}

export function parseFlow(file: string): Flow {
  const path = resolve(file);
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new FlowError(`cannot read flow ${path}: ${error instanceof Error ? error.message : error}`);
  }
  const steps = (doc as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw new FlowError(`flow ${path} needs a non-empty "steps" list`);
  return {
    dir: dirname(path),
    steps: steps.map((raw, i): FlowStep => {
      const at = `flow step ${i + 1}`;
      const step = raw as { wait_ms?: unknown; run?: unknown; timeout_ms?: unknown };
      if (typeof raw !== "object" || raw === null) throw new FlowError(`${at} is not an object`);
      if (step.wait_ms !== undefined && step.run === undefined) {
        if (typeof step.wait_ms !== "number" || !Number.isFinite(step.wait_ms) || step.wait_ms < 0 || step.wait_ms > MAX_WAIT_MS) {
          throw new FlowError(`${at}: wait_ms must be 0 to ${MAX_WAIT_MS}`);
        }
        return { wait_ms: step.wait_ms };
      }
      if (step.run !== undefined && step.wait_ms === undefined) {
        if (!Array.isArray(step.run) || step.run.length === 0 || step.run.some((a) => typeof a !== "string") || step.run[0] === "") {
          throw new FlowError(`${at}: run must be a list of strings starting with the command`);
        }
        const timeout = step.timeout_ms ?? STEP_TIMEOUT_MS;
        if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) throw new FlowError(`${at}: timeout_ms must be a positive number`);
        return { run: step.run as string[], timeout_ms: timeout };
      }
      throw new FlowError(`${at} needs exactly one of "wait_ms" or "run"`);
    }),
  };
}

function runStep(argv: string[], timeoutMs: number, cwd: string, env: NodeJS.ProcessEnv, adopt: (child: ChildProcess) => void): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
    adopt(child);
    const timer = setTimeout(() => { child.kill("SIGTERM"); fail(new Error(`timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.once("error", (e) => { clearTimeout(timer); fail(e); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) done();
      else fail(new Error(signal ? `killed by ${signal}` : `exited ${code}`));
    });
  });
}

export interface FlowRun {
  /** Hand this to the recorder's ready hook: it starts the steps, then stops the recording. */
  start(takeDir: string): void;
  /** Call once the recorder has returned: ends a flow still running and says how it went. */
  outcome(): { ok: true } | { ok: false; message: string };
}

/** Runs `flow` once `start` is called, then stops the recording the way `takeone stop` does. */
export function runFlow(flow: Flow): FlowRun {
  let state: "waiting" | "running" | "done" | "failed" | "cancelled" = "waiting";
  let failure = "";
  let current: ChildProcess | null = null;
  const run = async (takeDir: string): Promise<void> => {
    state = "running";
    const env = { ...process.env, TAKEONE_TAKE: takeDir };
    try {
      for (const [i, step] of flow.steps.entries()) {
        if (state !== "running") return;
        if ("wait_ms" in step) await new Promise((r) => setTimeout(r, step.wait_ms));
        else {
          console.error(`flow step ${i + 1}/${flow.steps.length}: ${step.run.join(" ")}`);
          try { await runStep(step.run, step.timeout_ms, flow.dir, env, (c) => { current = c; }); }
          catch (error) {
            if (state !== "running") return;
            throw new Error(`flow step ${i + 1} (${step.run[0]}) failed: ${error instanceof Error ? error.message : error}`);
          }
        }
      }
      state = "done";
    } catch (error) {
      state = "failed";
      failure = error instanceof Error ? error.message : String(error);
    }
    process.kill(process.pid, "SIGINT");
  };
  return {
    start: (takeDir) => { if (state === "waiting") void run(takeDir); },
    outcome() {
      if (state === "running") { state = "cancelled"; current?.kill("SIGTERM"); return { ok: false, message: "the recording stopped before the flow finished" }; }
      if (state === "failed") return { ok: false, message: failure };
      if (state === "waiting") return { ok: false, message: "the recording never started, so the flow did not run" };
      return { ok: true };
    },
  };
}
