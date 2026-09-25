#!/usr/bin/env bash
set -euo pipefail
RUNTIME_VERSION="${1:-26.2}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/release/glass-prototype-$RUNTIME_VERSION"
mkdir -p "$OUT"
xcodebuild -version > "$OUT/toolchain.txt"
xcrun swift --version >> "$OUT/toolchain.txt"
xcrun simctl list runtimes -j > "$OUT/runtimes.json"
xcrun simctl list devices available -j > "$OUT/devices.json"
DEVICE_ID=$(python3 - "$OUT/devices.json" "$RUNTIME_VERSION" <<'PY'
import json,sys
devices=json.load(open(sys.argv[1]))['devices']
runtime='com.apple.CoreSimulator.SimRuntime.iOS-'+sys.argv[2].replace('.','-')
phones=[d for d in devices.get(runtime,[]) if d.get('isAvailable') and d['name'].startswith('iPhone')]
if not phones: raise SystemExit('Required runtime missing: '+runtime+'; no silent substitution')
phones.sort(key=lambda d: ('Pro' not in d['name'],d['name']))
print(phones[0]['udid'])
PY
)
printf '%s' "$DEVICE_ID" > "$OUT/device-id.txt"
xcrun simctl boot "$DEVICE_ID" 2>/dev/null || true
xcrun simctl bootstatus "$DEVICE_ID" -b
xcrun simctl status_bar "$DEVICE_ID" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100
cd "$ROOT/prototypes/ios-glass"
xcodegen generate
xcodebuild -project GlassPrototype.xcodeproj -scheme GlassPrototype -configuration Debug -destination "platform=iOS Simulator,id=$DEVICE_ID" -derivedDataPath "$OUT/build" CODE_SIGNING_ALLOWED=NO build-for-testing > "$OUT/build.log" 2>&1
RECORD_PID=''
cleanup() {
  if [ -n "$RECORD_PID" ]; then kill -INT "$RECORD_PID" 2>/dev/null || true; wait "$RECORD_PID" || true; fi
}
trap cleanup EXIT
xcrun simctl io "$DEVICE_ID" recordVideo --codec=h264 --force "$OUT/interaction.mp4" > "$OUT/recording.log" 2>&1 &
RECORD_PID=$!
set +e
xcodebuild -project GlassPrototype.xcodeproj -scheme GlassPrototype -configuration Debug -destination "platform=iOS Simulator,id=$DEVICE_ID" -derivedDataPath "$OUT/build" -resultBundlePath "$OUT/tests.xcresult" -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO test-without-building > "$OUT/test.log" 2>&1
TEST_EXIT=$?
set -e
cleanup
RECORD_PID=''
xcrun simctl io "$DEVICE_ID" screenshot "$OUT/final-screen.png"
xcrun xcresulttool export attachments --path "$OUT/tests.xcresult" --output-path "$OUT/screenshots" > "$OUT/export.log" 2>&1
python3 - "$OUT" "$TEST_EXIT" "$RUNTIME_VERSION" <<'PY'
import json,sys,pathlib
out=pathlib.Path(sys.argv[1]); screenshots=list((out/'screenshots').rglob('*.png'))
video=out/'interaction.mp4'
ok=int(sys.argv[2])==0 and bool(screenshots) and video.exists() and video.stat().st_size>0
result={'success':bool(ok),'xcodeTestExit':int(sys.argv[2]),'runtime':sys.argv[3],'screenshots':len(screenshots),'recordingBytes':video.stat().st_size if video.exists() else 0,'physicalDevice':'pending','visualApproval':'pending'}
(out/'result.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result,indent=2))
if not ok: raise SystemExit(1)
PY
# verification rerun: App Store-style blue glass selection
