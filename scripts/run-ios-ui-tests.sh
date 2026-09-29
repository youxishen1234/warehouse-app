#!/bin/bash
# Usage: bash scripts/run-ios-ui-tests.sh <booted-ios26-device-udid> <derived-data> [output-dir] [variant]
# The caller owns simulator creation/cleanup and build-for-testing. No rebuilds.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DEVICE_ID="${1:?Pass a booted iOS 26+ simulator UDID}"
DERIVED_DATA="${2:?Pass the build-for-testing derived-data directory}"
DERIVED_DATA="$(cd "$DERIVED_DATA" && pwd)"
OUTPUT="${3:-release/ios-ui-tests}"
VARIANT="${4:-}"
mkdir -p "$OUTPUT"
OUTPUT="$(cd "$OUTPUT" && pwd)"
RESULT="$OUTPUT/NativeDock.xcresult"
if [ -e "$RESULT" ]; then
  echo "Refusing to overwrite existing UI test evidence: $RESULT" >&2
  exit 1
fi
command -v xcodebuild >/dev/null
: > "$OUTPUT/xcodebuild.log"

# Bound the entire test command, retaining original exit status and log.
set +e
python3 - "$DEVICE_ID" "$RESULT" "$OUTPUT/xcodebuild.log" "$DERIVED_DATA" "$VARIANT" <<'PY'
import os, pathlib, plistlib, signal, subprocess, sys, tempfile
products = pathlib.Path(sys.argv[4]) / 'Build/Products'
candidates = list(products.glob('NativeDockUITests*.xctestrun'))
candidates = [path for path in candidates if not path.name.startswith('NativeDockUITests-variant-')]
if len(candidates) != 1:
    sys.exit('Expected exactly one NativeDockUITests .xctestrun from build-for-testing, found ' + str(candidates))
with candidates[0].open('rb') as source:
    spec = plistlib.load(source)
if 'TestConfigurations' in spec:
    targets = [target for config in spec['TestConfigurations'] for target in config.get('TestTargets', [])]
else:
    targets = [value for key, value in spec.items() if not key.startswith('__') and isinstance(value, dict)]
matched = [target for target in targets if target.get('BlueprintName') == 'NativeDockUITests' or 'NativeDockUITests' in target.get('TestBundlePath', '')]
if not matched:
    sys.exit('UI test target was not present in the generated .xctestrun')
for target in matched:
    target.setdefault('EnvironmentVariables', {})['DOCK_UI_TEST_VARIANT'] = sys.argv[5]
# __TESTROOT__ paths resolve relative to this file, so keep the disposable copy
# beside the original .xctestrun rather than in the evidence output directory.
with tempfile.NamedTemporaryFile(prefix='NativeDockUITests-variant-', suffix='.xctestrun', dir=products, delete=False) as output:
    spec_path = output.name
    plistlib.dump(spec, output)
command = [
    'xcodebuild', '-xctestrun', spec_path,
    '-destination', 'platform=iOS Simulator,id=' + sys.argv[1],
    '-destination-timeout', '60',
    '-resultBundlePath', sys.argv[2], '-parallel-testing-enabled', 'NO',
    '-maximum-concurrent-test-simulator-destinations', '1',
    '-test-timeouts-enabled', 'YES', '-default-test-execution-time-allowance', '120',
    '-maximum-test-execution-time-allowance', '180',
    'test-without-building'
]
try:
    with open(sys.argv[3], 'w') as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            status = process.wait(timeout=900)
        except subprocess.TimeoutExpired:
            print('::error title=Native UI tests::xcodebuild exceeded 15 minutes', flush=True)
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            status = 124
finally:
    os.unlink(spec_path)
sys.exit(status)
PY
TEST_STATUS=$?
set -e
tail -100 "$OUTPUT/xcodebuild.log"
printf '%s\n' "$TEST_STATUS" > "$OUTPUT/exit-status.txt"

# Keep xcresult regardless of test status. Attachments contain lossless original
# screenshots with .keepAlways, including the failing test's final screen.
EXPORT_STATUS=0
if [ -d "$RESULT" ]; then
  xcrun xcresulttool export attachments --path "$RESULT" --output-path "$OUTPUT/attachments" \
    > "$OUTPUT/attachment-export.log" 2>&1 || EXPORT_STATUS=$?
else
  echo "::error title=Native UI tests::xcodebuild did not create xcresult"
  EXPORT_STATUS=1
fi
if [ "$TEST_STATUS" -ne 0 ]; then
  echo "::error title=Native UI tests::Real tap/drag navigation acceptance failed; see xcresult and screenshots"
  exit "$TEST_STATUS"
fi
if [ "$EXPORT_STATUS" -ne 0 ]; then
  cat "$OUTPUT/attachment-export.log" 2>/dev/null || true
  echo "::error title=Native UI tests::Failed to export original screenshot evidence"
  exit "$EXPORT_STATUS"
fi
echo "Native tap/drag tests passed; evidence: $OUTPUT"
