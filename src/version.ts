import { readFileSync } from "node:fs";

/** package.json version: src/version.ts and dist/version.js both sit one level below the root. */
export function packageVersion(): string {
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
