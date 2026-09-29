#!/bin/bash
# Diagnostic only: never archives, builds an IPA, pushes, or publishes.
# Usage: ios-dock-diagnostics.sh APP_PATH OUTPUT_DIR [BOOTED_INSTALLED_DEVICE_ID]
# Compile the Debug simulator App once upstream. PYTHON may name a Pillow venv.
set -euo pipefail
APP_PATH="${1:?App.app path required}"
OUTPUT="${2:?Output directory required}"
DEVICE_ID="${3:-}"
PYTHON="${PYTHON:-python3}"
BUNDLE=com.warehouse.app
OWN_DEVICE=0
LAUNCH_PID=""
mkdir -p "$OUTPUT"
"$PYTHON" -c 'import PIL' || { echo 'A Python with Pillow is required' >&2; exit 1; }

bounded() {
  local seconds="$1"
  shift
  "$PYTHON" - "$seconds" "$@" <<'PY'
import os, signal, subprocess, sys
p = subprocess.Popen(sys.argv[2:], start_new_session=True)
try:
    sys.exit(p.wait(timeout=int(sys.argv[1])))
except subprocess.TimeoutExpired:
    os.killpg(p.pid, signal.SIGKILL)
    p.wait()
    print('Diagnostic command timed out: ' + sys.argv[2], file=sys.stderr)
    sys.exit(124)
PY
}
stop_launcher() {
  if [ -n "$LAUNCH_PID" ]; then
    kill "$LAUNCH_PID" 2>/dev/null || true
    wait "$LAUNCH_PID" 2>/dev/null || true
    LAUNCH_PID=""
  fi
}
cleanup() {
  stop_launcher
  if [ -n "$DEVICE_ID" ]; then
    bounded 15 xcrun simctl terminate "$DEVICE_ID" "$BUNDLE" >/dev/null 2>&1 || true
    if [ "$OWN_DEVICE" = 1 ]; then
      bounded 30 xcrun simctl shutdown "$DEVICE_ID" >/dev/null 2>&1 || true
      bounded 30 xcrun simctl delete "$DEVICE_ID" >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
if [ -z "$DEVICE_ID" ]; then
  TEMPLATE="$(bounded 30 xcrun simctl list devices available -j | "$PYTHON" -c '
import json,sys
candidates=[]
for runtime, devices in json.load(sys.stdin)["devices"].items():
    if ".iOS-" not in runtime: continue
    version=tuple(int(x) for x in runtime.split(".iOS-")[1].split("-"))
    if version[0]<26: continue
    for device in devices:
        if device["name"].startswith("iPhone") and device.get("isAvailable",True):
            candidates.append((version, device["deviceTypeIdentifier"], runtime)); break
if not candidates: sys.exit("iOS 26+ iPhone runtime required")
chosen=max(candidates)
print(chosen[1]+"|"+chosen[2])')"
  DEVICE_ID="$(bounded 60 xcrun simctl create Warehouse-Dock-Diagnostics "${TEMPLATE%%|*}" "${TEMPLATE#*|}")"
  OWN_DEVICE=1
  bounded 60 xcrun simctl boot "$DEVICE_ID"
  bounded 180 xcrun simctl bootstatus "$DEVICE_ID" -b
  bounded 180 xcrun simctl install "$DEVICE_ID" "$APP_PATH"
fi
APP_DATA="$(bounded 30 xcrun simctl get_app_container "$DEVICE_ID" "$BUNDLE" data)"
export OUTPUT
for variant in system edge-off web-dark native-white native-dark current; do
  SCENE="$OUTPUT/$variant"
  mkdir -p "$SCENE"
  bounded 15 xcrun simctl terminate "$DEVICE_ID" "$BUNDLE" >/dev/null 2>&1 || true
  stop_launcher
  # Remove only known diagnostic outputs, never app business data.
  "$PYTHON" - "$APP_DATA/Documents" "$SCENE" <<'PY'
import pathlib,sys
for root in map(pathlib.Path,sys.argv[1:]):
    for pattern in ('native-dock-smoke.json','native-dock-step-*.png','result.json','simulator.png','appearance-report.json','collection-error.txt'):
        for path in root.glob(pattern):
            if path.is_file(): path.unlink()
PY
  xcrun simctl launch --console-pty "$DEVICE_ID" "$BUNDLE" --native-dock-smoke "--dock-variant=$variant" > "$SCENE/console.log" 2>&1 &
  LAUNCH_PID=$!
  ready=0
  deadline=$((SECONDS + 240))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ -f "$APP_DATA/Documents/native-dock-smoke.json" ]; then ready=1; break; fi
    if ! kill -0 "$LAUNCH_PID" 2>/dev/null; then break; fi
    sleep 1
  done
  if [ "$ready" = 1 ]; then
    cp "$APP_DATA/Documents/native-dock-smoke.json" "$SCENE/result.json"
    for snapshot in "$APP_DATA"/Documents/native-dock-step-*.png; do
      [ ! -f "$snapshot" ] || cp "$snapshot" "$SCENE/"
    done
    if bounded 30 xcrun simctl io "$DEVICE_ID" screenshot "$SCENE/simulator.png"; then
      "$PYTHON" scripts/verify-native-dock-image.py "$SCENE" --report-only > "$SCENE/appearance.log" 2>&1 || echo 'Image diagnostic failed' > "$SCENE/collection-error.txt"
    else
      echo 'Compositor screenshot failed' > "$SCENE/collection-error.txt"
    fi
  else
    echo 'No ready result before launcher exit/240-second deadline; inspect console, not proof of an app crash' > "$SCENE/collection-error.txt"
    bounded 30 xcrun simctl io "$DEVICE_ID" screenshot "$SCENE/timeout.png" || true
  fi
  bounded 15 xcrun simctl terminate "$DEVICE_ID" "$BUNDLE" >/dev/null 2>&1 || true
  stop_launcher
  echo "Collected native dock candidate: $variant"
done
"$PYTHON" - "$OUTPUT" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]); reports=[]; incomplete=False
for variant in ('system','edge-off','web-dark','native-white','native-dark','current'):
    scene=root/variant; path=scene/'appearance-report.json'
    if path.exists() and not (scene/'collection-error.txt').exists():
        report=json.loads(path.read_text(encoding='utf-8'))
        reports.append({'variant':variant, **report})
    else:
        incomplete=True
        reports.append({'variant':variant,'status':'collection_failed'})
summary={'status':'collection_failed' if incomplete else 'requires_review',
         'productionAcceptance':False,'scenarios':reports,
         'note':'Diagnostic comparison only. Original PNG review and actual XCUITest tap/drag required.'}
(root/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(summary,ensure_ascii=False,indent=2))
sys.exit(1 if incomplete else 2)
PY
