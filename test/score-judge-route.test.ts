import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JUDGE_MODEL, resolveJudge } from "../src/decide/planner.ts";

/** A throwaway PATH holding only a fake `claude` that answers `auth status`. */
function fakeClaude(status: object | null): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), "judge-route-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  if (status) {
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho '${JSON.stringify(status)}'\n`);
    chmodSync(join(bin, "claude"), 0o755);
  }
  return { HOME: root, PATH: bin, TAKEONE_NO_KEYRING: "1" };
}

test("the judge defaults to Claude Haiku on the signed-in subscription, never a key", async () => {
  const env = fakeClaude({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" });
  const judge = await resolveJudge({ env, configDir: join(env.HOME!, "cfg") });
  assert.equal(judge.active, true, judge.refusal ?? "");
  assert.equal((judge.config as { backend: string }).backend, "claude-code");
  assert.equal((judge.config as { model: string }).model, JUDGE_MODEL);
  assert.equal(judge.key, null);
  assert.match(judge.label, /Claude account.*haiku/);
});

test("a saved judge.json replaces the default route", async () => {
  const env = fakeClaude({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" });
  const configDir = join(env.HOME!, "cfg");
  mkdirSync(join(configDir, "takeone"), { recursive: true });
  writeFileSync(join(configDir, "takeone", "judge.json"), JSON.stringify({ backend: "pi", bin: "/nonexistent/pi", model: "other/model" }));
  const judge = await resolveJudge({ env, configDir });
  assert.equal((judge.config as { backend: string }).backend, "pi");
  assert.equal(judge.active, false);
});

test("no Claude CLI or an API-key login leaves the judge unavailable with the reason", async () => {
  const none = await resolveJudge({ env: fakeClaude(null), configDir: join(tmpdir(), "judge-route-none") });
  assert.equal(none.active, false);
  assert.match(none.refusal ?? "", /not installed/);
  const keyed = await resolveJudge({ env: fakeClaude({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }), configDir: join(tmpdir(), "judge-route-none") });
  assert.equal(keyed.active, false);
  assert.match(keyed.refusal ?? "", /API key/);
});
