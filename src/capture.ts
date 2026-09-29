// `takeone capture ...`: recorder protocol v1 surface. `hello` now;
// record/stop/make land in later lanes and currently fall through to the
// capture-scoped invalid-arguments envelope below.
import { readFileSync } from "node:fs";
import { loadApiKey } from "./decide/jev.ts";

export interface CaptureError {
  code: string;
  message: string;
  hint: string;
}

/** Capture-scoped failure: envelope on stdout; usage errors exit 2, rest exit 1. */
export function captureFail(error: CaptureError): never {
  console.log(JSON.stringify({ error }));
  process.exit(error.code === "invalid-arguments" ? 2 : 1);
}

/** package.json version, resolved from the installed layout (dist/../package.json). */
function recorderVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    if (typeof pkg.version === "string" && pkg.version) return pkg.version;
  } catch {
    // installed without a readable package.json; beat on without a version
  }
  return "0.0.0";
}

export function runCapture(argv: string[]): number {
  const [verb, ...rest] = argv;
  if (verb === "hello" && rest.length === 0) {
    console.log(
      JSON.stringify({
        protocol: 1,
        recorder: { name: "takeone", version: recorderVersion() },
        sources: ["screen", "x11"],
        android: false,
        // presence only; the key itself is never printed
        planner: { available: loadApiKey() !== null, needsKey: true },
      }),
    );
    return 0;
  }
  captureFail({
    code: "invalid-arguments",
    message: verb === undefined ? "capture needs a verb" : `unknown capture verb: ${verb}`,
    hint: "run `takeone capture hello`",
  });
}
