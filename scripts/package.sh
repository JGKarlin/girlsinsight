#!/bin/sh
# Builds the Chrome Web Store upload, girlsinsight-<version>.zip, containing
# only the files the extension needs (no tests, docs or tooling).
# Usage: sh scripts/package.sh            -> dist/girlsinsight-<version>.zip
#        OUT_DIR=/some/dir sh scripts/package.sh
set -eu
cd "$(dirname "$0")/.."

version=$(node -p "require('./manifest.json').version")
out_dir="${OUT_DIR:-dist}"
out="$out_dir/girlsinsight-$version.zip"
mkdir -p "$out_dir"
rm -f "$out"

zip -rq "$out" \
    manifest.json \
    background.js content.js girlschannel-parsing.js \
    article-pipeline.js rendered-article-session.js \
    popup.html popup.js popup-react.js popup.css \
    _locales icons lib \
    -x '*.DS_Store'
if [ -f LICENSE ]; then zip -q "$out" LICENSE; fi

echo "Built $out"
