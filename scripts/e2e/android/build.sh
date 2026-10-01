#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
sdk="${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}"
build="$PWD/tmp/android-fixture"
mkdir -p "$build/assets" "$build/classes"
python3 - "$build/assets/scene.html" <<'PY'
from pathlib import Path
import sys
scene=Path('scripts/e2e/scene.html').read_text()
css=Path('scripts/e2e/android/mobile.css').read_text()
scene=scene.replace('<head>', '<head><meta name="viewport" content="width=device-width, initial-scale=1">')
scene=scene.replace('</style>', css+'\n</style>')
# Prefilled demo task avoids showing a keyboard or relying on external accounts.
scene=scene.replace('$("title").value = ""', '$("title").value = "Prepare launch brief"')
scene=scene.replace('$("notes").value = ""', '$("notes").value = "Share the Tidewater release plan with Umer."')
scene=scene.replace('setTimeout(() => $("title").focus(), 50);', '')
# Existing columns have no IDs; name them so the phone shows the To do lane.
for n in range(3):
    needle='<section class="abs col"'
    pos=scene.find(needle)
    scene=scene[:pos]+scene[pos:].replace(needle, f'<section id="col{n}" class="abs col"', 1)
Path(sys.argv[1]).write_text(scene)
PY
javac -source 8 -target 8 -cp "$sdk/platforms/android-35/android.jar" -d "$build/classes" scripts/e2e/android/TidewaterActivity.java
"$sdk/build-tools/35.0.0/d8" --lib "$sdk/platforms/android-35/android.jar" --output "$build" "$build"/classes/design/takeone/tidewater/*.class
"$sdk/build-tools/35.0.0/aapt" package -f -M scripts/e2e/android/AndroidManifest.xml -I "$sdk/platforms/android-35/android.jar" -A "$build/assets" -F "$build/unsigned.apk"
(cd "$build" && zip -q unsigned.apk classes.dex)
"$sdk/build-tools/35.0.0/zipalign" -f 4 "$build/unsigned.apk" "$build/aligned.apk"
if [ ! -f "$build/demo.keystore" ]; then
  keytool -genkeypair -keystore "$build/demo.keystore" -storepass android -keypass android -alias demo -dname 'CN=Tidewater Demo' -keyalg RSA -validity 3650 >/dev/null 2>&1
fi
"$sdk/build-tools/35.0.0/apksigner" sign --ks "$build/demo.keystore" --ks-pass pass:android --out "$build/tidewater.apk" "$build/aligned.apk"
echo "$build/tidewater.apk"
