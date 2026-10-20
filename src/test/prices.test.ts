/** estimateUsd refuses to price unknown backends instead of fabricating $0,
 * and prices an account route at its zero marginal cost, not the API list price. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateUsd } from "../decide/prices.ts";

test("estimateUsd returns undefined for an unknown backend id", () => {
  assert.equal(estimateUsd("not-a-backend", 1000), undefined);
});

test("estimateUsd prices account and OpenCode Go plan-key routes at zero, and an OpenAI apiKey route at its list price", () => {
  assert.equal(estimateUsd("openai", 1_000_000, "account"), 0);
  assert.equal(estimateUsd("opencode-go", 1_000_000, "account"), 0);
  assert.equal(estimateUsd("opencode-go", 1_000_000, "apiKey"), 0);
  assert.equal(estimateUsd("openai", 1_000_000, "apiKey"), 2);
});
