/** estimateUsd refuses to price unknown backends instead of fabricating $0,
 * and prices an account route at its zero marginal cost, not the API list price. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateUsd } from "../decide/prices.ts";

test("estimateUsd returns undefined for an unknown backend id", () => {
  assert.equal(estimateUsd({ backend: "not-a-backend" }, 1000), undefined);
});

test("estimateUsd prices an account route at zero and an apiKey route at its list price", () => {
  assert.equal(estimateUsd({ backend: "openai", auth: "account" }, 1_000_000), 0);
  assert.equal(estimateUsd({ backend: "opencode-go", auth: "account" }, 1_000_000), 0);
  assert.equal(estimateUsd({ backend: "openai", auth: "apiKey" }, 1_000_000), 2);
});
