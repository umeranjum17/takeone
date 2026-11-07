#!/usr/bin/env node
// Refresh vendor/open-design from a clone of the fork at one exact commit: node scripts/sync-opendesign.mjs <clone> <40-char sha>
// Every file comes from a git blob at that commit, never the clone's working tree, and a branch name is refused, so the pin
// cannot follow main. The file list is the manifest's: taking a new file is a reviewed edit there, with its licence checked.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [clone, sha] = process.argv.slice(2);
if (!clone || !/^[0-9a-f]{40}$/.test(sha ?? "")) {
  console.error("usage: node scripts/sync-opendesign.mjs <clone> <40-char commit sha>");
  process.exit(2);
}
const vendor = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "open-design");
const manifestFile = join(vendor, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
const blob = (path) => execFileSync("git", ["-C", clone, "cat-file", "blob", `${sha}:${path}`], { maxBuffer: 64 * 1024 * 1024 });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

for (const row of manifest.files) {
  const bytes = blob(row.path), file = join(vendor, row.path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  row.sha256 = sha256(bytes);
}
// Adapted work is never copied, so a changed source is a person's call: said here, and the row moves to the new hash.
for (const row of manifest.adapted) {
  const now = sha256(blob(row.path));
  if (now !== row.sha256) console.error(`${row.path} changed at ${sha}: re-check ${row.into} against it`);
  row.sha256 = now;
}
manifest.commit = sha;
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`vendor/open-design at ${sha}: ${manifest.files.length} files, ${manifest.adapted.length} adapted`);
