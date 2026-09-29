#!/bin/bash
set -euo pipefail
APP_PATH="$1"
mkdir -p release/ios-smoke
# CoreSimulator can hang before the acceptance loop even starts. Bound every
# synchronous simulator operation and identify the stalled command in CI.
bounded_simctl() {
  local seconds="$1"
  shift
  python3 - "$seconds" "$@" <<'PY'
import subprocess, sys
command = ['xcrun', 'simctl', *sys.argv[2:]]
print('Simulator operation: ' + ' '.join(command[2:]), file=sys.stderr, flush=True)
try:
    result = subprocess.run(command, timeout=int(sys.argv[1]))
    sys.exit(result.returncode)
except subprocess.TimeoutExpired:
    print('::error title=Simulator operation timeout::' + ' '.join(command[2:]), file=sys.stderr)
    sys.exit(124)
PY
}
# Native Liquid Glass must be exercised on iOS 26+, not whichever older
# simulator happens to appear first in the shared runner inventory.
DEVICE_TEMPLATE="$(bounded_simctl 30 list devices available -j | ruby -rjson -e '
  j = JSON.parse(STDIN.read)
  candidates = j.fetch("devices").map do |runtime, devices|
    version = runtime.split(".iOS-")[1]
    next unless version
    parts = version.split("-").map(&:to_i)
    next if parts.first < 26
    device = devices.find { |v| v["name"].start_with?("iPhone") && v["isAvailable"] != false }
    device ? [parts, device, runtime] : nil
  end.compact
  selected = candidates.max_by { |entry| entry[0] }
  abort "An available iOS 26+ iPhone simulator is required for native Liquid Glass acceptance" unless selected
  warn "Native acceptance device: #{selected[1]["name"]} / #{selected[2]}"
  puts [selected[1].fetch("deviceTypeIdentifier"), selected[2]].join("|")
')"
# Use the selected runtime/type in a fresh per-job device instead of
# installing into a prebooted runner device with unknown simulator state.
DEVICE_ID="$(bounded_simctl 60 create Warehouse-Native-Acceptance "${DEVICE_TEMPLATE%%|*}" "${DEVICE_TEMPLATE#*|}")"
bounded_simctl 60 boot "$DEVICE_ID"
bounded_simctl 180 bootstatus "$DEVICE_ID" -b
bounded_simctl 180 install "$DEVICE_ID" "$APP_PATH"
APP_DATA="$(bounded_simctl 30 get_app_container "$DEVICE_ID" com.warehouse.app data)"
xcrun simctl launch --console-pty "$DEVICE_ID" com.warehouse.app --native-dock-smoke > release/ios-smoke/console.log 2>&1 &
LAUNCH_PID=$!
mkdir -p release/ios-smoke
for attempt in {1..180}; do
  if [ -f "$APP_DATA/Documents/native-dock-smoke.json" ]; then
    cp "$APP_DATA/Documents/native-dock-smoke.json" release/ios-smoke/result.json
    for snapshot in "$APP_DATA"/Documents/native-dock-step-*.png; do
      [ ! -f "$snapshot" ] || cp "$snapshot" release/ios-smoke/
    done
    bounded_simctl 30 io "$DEVICE_ID" screenshot release/ios-smoke/simulator.png
    python3 - release/ios-smoke/result.json <<'PY'
import json, sys
result = json.load(open(sys.argv[1]))
print(json.dumps(result, ensure_ascii=False, indent=2))
valid = result.get('success') is True and result.get('material') == 'system-liquid-glass'
if not valid:
    for line in [result.get('error') or 'Expected system Liquid Glass'] + result.get('trace', []):
        escaped = line.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
        print('::error title=Native dock acceptance::' + escaped)
    sys.exit(1)
PY
    exit 0
  fi
  if ! kill -0 "$LAUNCH_PID" 2>/dev/null; then
    tail -70 release/ios-smoke/console.log
    bounded_simctl 30 io "$DEVICE_ID" screenshot release/ios-smoke/crash.png
    echo "::error title=Native application launch::Simulator process exited before acceptance completed"
    exit 1
  fi
  sleep 2
done
bounded_simctl 30 io "$DEVICE_ID" screenshot release/ios-smoke/timeout.png
echo "Native dock smoke timed out" >&2
exit 1
