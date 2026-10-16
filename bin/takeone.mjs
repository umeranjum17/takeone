#!/usr/bin/env node
import("../dist/cli.js").catch((error) => {
  if (
    error &&
    typeof error === "object" &&
    error.code === "ERR_MODULE_NOT_FOUND" &&
    String(error.message).includes("dist/cli")
  ) {
    console.error(
      "takeone: this install has no build (dist/ is missing). Get a working install from a GitHub release tarball: https://github.com/umeranjum17/takeone/releases",
    );
    process.exit(1);
  }
  throw error;
});
