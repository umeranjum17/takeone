import assert from "node:assert/strict";
import { test } from "node:test";
import { loadGoAccount } from "../decide/planner.js";

test("a Go sign-in is never read from the OS keyring under TAKEONE_NO_KEYRING", async () => {
  await assert.rejects(loadGoAccount("someone", { TAKEONE_NO_KEYRING: "1" }), /TAKEONE_NO_KEYRING/);
});
