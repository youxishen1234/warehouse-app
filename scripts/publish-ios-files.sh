#!/bin/sh
set -eu
root=/opt/shuguang/public
test -s /tmp/shuguang-source.json
mkdir -p "$root/download"
install -m 644 /tmp/shuguang.ipa "$root/shuguang.ipa.new"
mv "$root/shuguang.ipa.new" "$root/shuguang.ipa"
install -m 644 "$root/shuguang.ipa" "$root/download/shuguang.ipa.new"
mv "$root/download/shuguang.ipa.new" "$root/download/shuguang.ipa"
install -m 644 /tmp/shuguang-download.html "$root/download/index.html"
install -m 644 /tmp/shuguang-ipa.json "$root/download/ipa.json.new"
mv "$root/download/ipa.json.new" "$root/download/ipa.json"
install -m 644 /tmp/shuguang-source.json "$root/download/source.json.new"
mv "$root/download/source.json.new" "$root/download/source.json"
sha256sum "$root/shuguang.ipa" "$root/download/shuguang.ipa"
