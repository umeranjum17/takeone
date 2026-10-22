# Print the installed version

Part of the takeone verification map. Source: `src/cli.ts` (the `--version` and `-v` handling) and `src/version.ts`.

## How to get to it (user POV)

A user who installs TakeOne runs `takeone --version` (or `-v`) and sees the installed version. It works before any subcommand, with no ffmpeg and no network.

## Driving it

Harness: Shell (bash) with node only on PATH.

1. From a checkout, run the `version` journey in `.done-done.yaml`: it builds the CLI, then runs `bin/takeone.mjs --version` and `-v` under `env -i` with only node's directory on PATH.
2. Compare each output with the `version` field of `package.json`; the journey fails on any difference.
3. Evidence: `version-check.txt` (the three commands and their output, with the result) and `node-env.txt` (the node binary and PATH the check ran under) in the run folder.

The drive changes no repo file: note findings in the run's report.
