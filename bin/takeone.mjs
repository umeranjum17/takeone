#!/usr/bin/env node
import("../dist/cli.js").catch((error) => {
  if (
    error &&
    typeof error === "object" &&
    error.code === "ERR_MODULE_NOT_FOUND" &&
    String(error.message).includes("dist/cli")
  ) {
    console.error(
      "takeone: this install has no build (dist/ is missing). Install the release build instead: npm install -g https://github.com/umeranjum17/takeone/releases/latest/download/takeone.tgz",
    );
    process.exit(1);
  }
  throw error;
});
