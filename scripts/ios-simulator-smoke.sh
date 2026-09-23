#!/bin/bash
set -euo pipefail
APP_PATH="$1"
DEVICE_ID="$(xcrun simctl list devices available -j | ruby -rjson -e 'j=JSON.parse(STDIN.read); d=j["devices"].values.flatten.find { |v| v["name"].start_with?("iPhone") }; abort "No iPhone simulator" unless d; puts d["udid"]')"
xcrun simctl boot "$DEVICE_ID" 2>/dev/null || true
xcrun simctl bootstatus "$DEVICE_ID" -b
xcrun simctl install "$DEVICE_ID" "$APP_PATH"
mkdir -p release/ios-smoke
xcrun simctl launch --console-pty "$DEVICE_ID" com.warehouse.app --native-dock-smoke > release/ios-smoke/console.log 2>&1 &
APP_DATA="$(xcrun simctl get_app_container "$DEVICE_ID" com.warehouse.app data)"
mkdir -p release/ios-smoke
for attempt in {1..90}; do
  if [ -f "$APP_DATA/Documents/native-dock-smoke.json" ]; then
    cp "$APP_DATA/Documents/native-dock-smoke.json" release/ios-smoke/result.json
    xcrun simctl io "$DEVICE_ID" screenshot release/ios-smoke/simulator.png
    ruby -rjson -e 'j=JSON.parse(File.read(ARGV[0])); puts JSON.pretty_generate(j); abort "Native dock smoke failed" unless j["success"]' release/ios-smoke/result.json
    exit 0
  fi
  sleep 2
done
xcrun simctl io "$DEVICE_ID" screenshot release/ios-smoke/timeout.png
echo "Native dock smoke timed out" >&2
exit 1
