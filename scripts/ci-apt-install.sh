#!/usr/bin/env bash
# Install apt packages on a CI runner without letting a slow Ubuntu mirror hold the job.
# The runners' mirror sometimes trickles at a few kB/s: the apt step has a 24 s median but has
# taken 36+ min (80 MB at 37 kB/s) and held a whole 40-minute job before any capture started.
# Only the network work is capped and retried (apt resumes partial downloads); the local unpack
# runs uncapped so a kill never lands mid-dpkg.
# Usage: scripts/ci-apt-install.sh <package>...    APT_ATTEMPT_SECONDS caps one network attempt.
set -euo pipefail
apt=(sudo timeout --kill-after=10 "${APT_ATTEMPT_SECONDS:-120}" apt-get
  -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20)
retry() {
  local what=$1; shift
  for n in 1 2 3; do
    "$@" && return 0
    code=$?
    echo "::warning::apt attempt $n of 3 failed ($([ "$code" = 124 ] && echo "stalled past ${APT_ATTEMPT_SECONDS:-120}s" || echo "exit $code")): $what"
  done
  echo "::error::apt mirror unusable after 3 attempts: $what"
  return 1
}
retry "apt-get update" "${apt[@]}" update
retry "apt-get download" "${apt[@]}" install --download-only -y "$@"
sudo apt-get install -y "$@"
