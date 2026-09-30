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
    '-maximum-test-execution-time-allowance', '240',
    'test-without-building'
]
try:
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               start_new_session=True, env={**os.environ, 'NSUnbufferedIO': 'YES'})
    # tee mirrors bytes immediately; the parent still owns xcodebuild's timeout
    # and exit status, so a successful logger cannot hide a failing test run.
    mirror = subprocess.Popen(['tee', sys.argv[3]], stdin=process.stdout)
    process.stdout.close()
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
    try:
        mirror_status = mirror.wait(timeout=15)
    except subprocess.TimeoutExpired:
        mirror.kill()
        mirror.wait()
        print('::error title=Native UI tests::Live log forwarding did not finish', flush=True)
        mirror_status = 124
    if status == 0 and mirror_status != 0:
        status = mirror_status
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
  # Preserve Xcode's raw reports for checking the actual executed test list and
  # skipped counts. Do not infer successful methods from an unverified schema.
  for section in summary tests; do
    SECTION_STATUS=0
    xcrun xcresulttool get test-results "$section" --path "$RESULT" \
      > "$OUTPUT/test-results-$section.json" 2> "$OUTPUT/test-results-$section-export.log" || SECTION_STATUS=$?
    printf '%s\n' "$SECTION_STATUS" > "$OUTPUT/test-results-$section-exit-status.txt"
    if [ "$SECTION_STATUS" -ne 0 ]; then
      printf '\nxcresulttool test-results %s exited %s\n' "$section" "$SECTION_STATUS" >> "$OUTPUT/test-results-$section-export.log"
      cat "$OUTPUT/test-results-$section-export.log"
      EXPORT_STATUS="$SECTION_STATUS"
    fi
  done
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
  echo "::error title=Native UI tests::Failed to export screenshots or test-result reports"
  exit "$EXPORT_STATUS"
fi
echo "Native UI test command completed; inspect test-result reports and screenshot evidence: $OUTPUT"
