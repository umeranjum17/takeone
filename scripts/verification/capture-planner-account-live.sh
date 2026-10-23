#!/usr/bin/env bash
# Live proof for `capture make --planner-account`: plan a real headless-demo capture
# through an API-key route held in BYOKit's sealed store, in a throwaway HOME.
#
#   scripts/verification/capture-planner-account-live.sh <key-path> <backend> <model> <out-dir>
#
# The key is read from <key-path> only to pipe it into `takeone key set`; it is never
# printed, copied into <out-dir>, or put on a command line. Heavy jobs: start this
# script through fm-mem-gate.sh. Writes into <out-dir>: plan.stdout.json,
# plan.stderr.log, take.json and the planned MP4. Set DRY=1 to stop after storing the
# key and checking the account resolves (no capture, no provider call).
set -euo pipefail
[ $# -eq 4 ] || { sed -n 2,12p "$0" >&2; exit 2; }
key=$1 backend=$2 model=$3 out=$4
[ -r "$key" ] || { echo "key path not readable: $key" >&2; exit 2; }
node=$(node -p process.execPath) # real binary, resolved before HOME changes (version shims read HOME)
repo=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$out" "$tmp/home"
export HOME=$tmp/home XDG_CONFIG_HOME=$tmp/home/.config XDG_STATE_HOME=$tmp/home/.state
export TAKEONE_NO_KEYRING=1 TAKEONE_DIR=$tmp/takes TAKEONE_STATE_DIR=$tmp/state
printf '%s' "sealed-$$-$RANDOM$RANDOM" > "$tmp/pass"
tk() { "$node" "$repo/bin/takeone.mjs" "$@"; }

TAKEONE_SECRETS_PASSPHRASE_FD=3 tk key set --backend "$backend" --model "$model" 3<"$tmp/pass" <"$key" >"$out/key-set.txt"
TAKEONE_SECRETS_PASSPHRASE_FD=3 tk doctor 3<"$tmp/pass" | grep ai-planner | tee "$out/doctor-ai-planner.txt"
[ "${DRY:-}" = 1 ] && { echo "DRY: key stored and planner resolved; no capture run"; exit 0; }

take=$tmp/take
"$node" --input-type=module -e "import('$repo/scripts/headless-scene.mjs').then(m=>m.captureScene(process.argv[1]))" "$take"
set +e
TAKEONE_SECRETS_PASSPHRASE_FD=3 tk capture make "$take" --planner-account 3<"$tmp/pass" >"$out/plan.stdout.json" 2>"$out/plan.stderr.log"
rc=$?
set -e
cp "$take/take.json" "$out/take.json"
cp "$take"/out/*.mp4 "$out/" 2>/dev/null || true
echo "capture make exit $rc"; cat "$out/plan.stdout.json"
[ $rc -eq 0 ] && grep -q '"mode": *"ai"' "$out/take.json" || { echo "NOT PROVEN: planner mode is not ai" >&2; exit 1; }
