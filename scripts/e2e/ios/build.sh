#!/usr/bin/env bash
# Builds only this fixture inside the supplied task-owned Mac lab directory.
set -euo pipefail
lab=${1:?provide the task-owned lab directory}
here=$(cd "$(dirname "$0")" && pwd)
app="$lab/Tidewater.app"
mkdir -p "$app" "$lab/swift-cache"
sdk=$(xcrun --sdk iphonesimulator --show-sdk-path)
xcrun swiftc -parse-as-library "$here/App.swift" -o "$app/Tidewater" -sdk "$sdk" \
  -target arm64-apple-ios18.0-simulator -module-cache-path "$lab/swift-cache" \
  -framework UIKit -framework WebKit
cp "$here/scene.html" "$app/scene.html"
cat > "$app/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Tidewater</string><key>CFBundleIdentifier</key><string>design.takeone.lab.pm14</string>
<key>CFBundleName</key><string>Tidewater</string><key>CFBundleVersion</key><string>1</string><key>CFBundlePackageType</key><string>APPL</string>
<key>UILaunchScreen</key><dict/><key>LSRequiresIPhoneOS</key><true/>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>takeone-ios-camera</string></array></dict></array>
</dict></plist>
PLIST
