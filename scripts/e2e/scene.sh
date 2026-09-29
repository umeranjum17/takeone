#!/usr/bin/env bash
# Stage or tear down the e2e scene: scene.html in a throwaway Chromium profile,
# fullscreen on an empty Hyprland workspace (default 9).
#   scene.sh start PROFILE_DIR [WORKSPACE]    scene.sh stop PROFILE_DIR [RETURN_WORKSPACE]
set -euo pipefail
cmd=$1 profile=$2
here=$(cd "$(dirname "$0")" && pwd)
case $cmd in
  start)
    ws=${3:-9}
    hyprctl dispatch "hl.dsp.focus({ workspace = \"$ws\" })" >/dev/null
    # --force-device-scale-factor=1 cancels the desktop text-scaling factor, so
    # one CSS pixel is one logical pixel and drive.py coordinates line up.
    hyprctl dispatch "hl.dsp.exec_cmd(\"chromium --user-data-dir=$profile --password-store=basic --ozone-platform=wayland --force-device-scale-factor=1 --no-first-run --no-default-browser-check --disable-features=Translate,MediaRouter --app=file://$here/scene.html\")" >/dev/null
    for _ in $(seq 50); do
      [ "$(hyprctl activewindow -j | jq -r .title)" = "Tidewater board" ] && break
      sleep 0.2
    done
    hyprctl dispatch 'hl.dsp.window.fullscreen({ mode = "fullscreen" })' >/dev/null
    sleep 6 # Chromium's "press Esc to exit full screen" hint fades
    ;;
  stop)
    pkill -f -- "--user-data-dir=$profile" || true
    hyprctl dispatch "hl.dsp.focus({ workspace = \"${3:-3}\" })" >/dev/null
    ;;
esac
