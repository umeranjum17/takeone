/** estimateUsd refuses to price unknown backends instead of fabricating $0. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateUsd } from "../decide/prices.ts";

test("estimateUsd returns undefined for an unknown backend id", () => {
  assert.equal(estimateUsd("not-a-backend", 1000), undefined);
});
