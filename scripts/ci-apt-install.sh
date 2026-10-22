#!/usr/bin/env bash
# Install apt packages on a CI runner without letting a slow Ubuntu mirror hold the job.
# The runners' mirror sometimes trickles at a few kB/s: the apt step has a 24 s median but has
# taken 36+ min (80 MB at 37 kB/s) and held a whole 40-minute job before any capture started.
# Only the network work is capped and retried (apt resumes partial downloads); the local unpack
# runs uncapped so a kill never lands mid-dpkg.
# After the first failed attempt the retries use archive.ubuntu.com instead of the runner image's
# azure.archive.ubuntu.com mirror, which is the one that trickles.
# Usage: scripts/ci-apt-install.sh <package>...    APT_ATTEMPT_SECONDS caps one network attempt.
set -euo pipefail
apt=(sudo timeout --kill-after=10 "${APT_ATTEMPT_SECONDS:-180}" apt-get
  -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20)
# Index and download run as one attempt: switching mirror needs a fresh index.
fetch() { "${apt[@]}" update && "${apt[@]}" install --download-only -y "$@"; }
for n in 1 2 3; do
  fetch "$@" && break
  code=$?
  echo "::warning::apt attempt $n of 3 failed ($([ "$code" = 124 ] && echo "stalled past ${APT_ATTEMPT_SECONDS:-180}s" || echo "exit $code"))"
  [ "$n" = 3 ] && { echo "::error::apt mirror unusable after 3 attempts"; exit 1; }
  echo "http://archive.ubuntu.com/ubuntu/" | sudo tee /etc/apt/apt-mirrors.txt >/dev/null
done
sudo apt-get install -y "$@"
