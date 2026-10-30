#!/usr/bin/env bash
# Run a command in a provider-free, isolated planner state whose only AI engine is the recorded one:
#   scripts/verification/recorded-engine.sh <scratch-dir> <command> [args...]
# `claude` on PATH becomes recorded-engine.mjs, and HOME, the config folder and the keyring are the
# scratch directory's, so no real sign-in or stored key can answer.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
scratch=$1; shift
mkdir -p "$scratch/engine" "$scratch/home" "$scratch/config"
# A wrapper, not a symlink: the engine runs under the node that started this, whatever PATH holds.
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$(node -p process.execPath)" "$here/recorded-engine.mjs" > "$scratch/engine/claude"
chmod +x "$scratch/engine/claude"
export PATH="$scratch/engine:$PATH" HOME="$scratch/home" XDG_CONFIG_HOME="$scratch/config" TAKEONE_NO_KEYRING=1
exec "$@"
