#!/usr/bin/env node
import { existsSync } from "node:fs";
import("../dist/cli.js").catch((error) => {
  if (!existsSync(new URL("../dist/cli.js", import.meta.url))) {
    console.error(
      "takeone: this install has no build (dist/ is missing). Install the release build instead: npm install -g https://github.com/umeranjum17/takeone/releases/latest/download/takeone.tgz",
    );
    process.exit(1);
  }
  throw error;
});
