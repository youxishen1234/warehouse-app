#!/bin/sh
set -eu

root=/opt/shuguang/public
stage=${1:?A unique staging directory is required}
case "$stage" in
  /tmp/warehouse-ios-*) ;;
  *) echo 'Invalid iOS staging directory' >&2; exit 1 ;;
esac

test -s "$stage/shuguang.ipa"
test -s "$stage/ipa.json"
test -s "$stage/source.json"
test -s "$stage/index.html"
test -s "$stage/app-icon.png"
mkdir -p "$root/download"

release_info=$(python3 - "$stage" <<'PY'
import hashlib, json, pathlib, re, sys
stage = pathlib.Path(sys.argv[1])
info = json.loads((stage / 'ipa.json').read_text(encoding='utf-8'))
build = str(info.get('build', ''))
if not build.isdigit() or int(build) < 1:
    raise SystemExit('Invalid IPA build')
url = str(info.get('url', ''))
if not re.fullmatch(r'/download/shuguang-[A-Za-z0-9._-]+\.ipa', url):
    raise SystemExit('Invalid versioned IPA URL')
commit = info.get('sourceCommit', '')
if commit and not re.fullmatch(r'[a-f0-9]{40}', str(commit)):
    raise SystemExit('Invalid source commit')
data = (stage / 'shuguang.ipa').read_bytes()
if len(data) != info.get('sizeBytes') or hashlib.sha256(data).hexdigest() != info.get('sha256'):
    raise SystemExit('IPA integrity does not match metadata')
print('\t'.join((build, info['sha256'], url, commit)))
PY
)

build=$(printf '%s' "$release_info" | cut -f1)
sha256=$(printf '%s' "$release_info" | cut -f2)
artifact_path=$(printf '%s' "$release_info" | cut -f3)
source_commit=$(printf '%s' "$release_info" | cut -f4)
artifact_name=$(basename "$artifact_path")

exec 9>"$root/.ios-release.lock"
flock 9

current_build=0
current_sha=''
current_commit=''
if test -s "$root/download/ipa.json"; then
  current=$(python3 - "$root/download/ipa.json" <<'PY'
import json, pathlib, sys
info = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
build = str(info.get('build', '0'))
print('\t'.join((build if build.isdigit() else '0', str(info.get('sha256', '')), str(info.get('sourceCommit', '')))))
PY
)
  current_build=$(printf '%s' "$current" | cut -f1)
  current_sha=$(printf '%s' "$current" | cut -f2)
  current_commit=$(printf '%s' "$current" | cut -f3)
fi

if test "$current_build" -gt "$build"; then
  echo "Keeping newer published iOS build $current_build; this run is build $build"
  exit 0
fi
if test "$current_build" -eq "$build"; then
  if test "$current_sha" = "$sha256" && test "$current_commit" = "$source_commit"; then
    echo "iOS build $build is already published"
    exit 0
  fi
  echo "iOS build $build is already published with different content" >&2
  exit 1
fi

install -m 644 "$stage/shuguang.ipa" "$root/download/$artifact_name.new"
install -m 644 "$stage/shuguang.ipa" "$root/shuguang.ipa.new"
install -m 644 "$stage/shuguang.ipa" "$root/download/shuguang.ipa.new"
mv "$root/download/$artifact_name.new" "$root/download/$artifact_name"
mv "$root/shuguang.ipa.new" "$root/shuguang.ipa"
mv "$root/download/shuguang.ipa.new" "$root/download/shuguang.ipa"
install -m 644 "$stage/index.html" "$root/download/index.html.new"
install -m 644 "$stage/app-icon.png" "$root/download/app-icon.png.new"
install -m 644 "$stage/ipa.json" "$root/download/ipa.json.new"
install -m 644 "$stage/source.json" "$root/download/source.json.new"
mv "$root/download/index.html.new" "$root/download/index.html"
mv "$root/download/app-icon.png.new" "$root/download/app-icon.png"
mv "$root/download/ipa.json.new" "$root/download/ipa.json"
mv "$root/download/source.json.new" "$root/download/source.json"

printf 'Published iOS build %s (%s)\n' "$build" "$source_commit"
sha256sum "$root/shuguang.ipa" "$root/download/shuguang.ipa" "$root/download/$artifact_name"
