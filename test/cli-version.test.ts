import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("takeone --version and -v print the package.json version and nothing else", () => {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  for (const flag of ["--version", "-v"]) {
    // PATH holds only node: no ffmpeg or other tool is reachable, and no subcommand runs first.
    const result = spawnSync(process.execPath, [join(root, "bin/takeone.mjs"), flag], {
      encoding: "utf8", timeout: 15_000, env: { PATH: dirname(process.execPath) },
    });
    assert.equal(result.status, 0, `${flag}: ${result.stderr}`);
    assert.equal(result.stdout, `${version}\n`, flag);
    assert.equal(result.stderr, "", flag);
  }
});
