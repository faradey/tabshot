#!/bin/sh
# Builds the zip the Chrome Web Store takes: the contents of extension/ with
# manifest.json at the root, into dist/tabshot-extension-<version>[-nodebugger].zip.
#
#   bin/package-extension.sh                 the extension as it is in the repo
#   bin/package-extension.sh --no-debugger   drops the `debugger` permission:
#       no "Capture covered windows" switch, no debugger install warning, and a
#       lighter store review. The code checks for chrome.debugger and hides the
#       switch when it is missing.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
src="$root/extension"
nodebug=0
for a in "$@"; do
  case "$a" in
    --no-debugger) nodebug=1 ;;
    *) echo "usage: $0 [--no-debugger]" >&2; exit 2 ;;
  esac
done

version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$src/manifest.json")
desc_len=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["description"]))' "$src/manifest.json")
if [ "$desc_len" -gt 132 ]; then
  echo "manifest description is $desc_len characters; the store takes at most 132" >&2
  exit 1
fi
for s in 16 32 48 128; do
  [ -f "$src/icons/icon$s.png" ] || { echo "missing extension/icons/icon$s.png" >&2; exit 1; }
done

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
# Only what the extension loads; nothing hidden, no editor or OS litter.
cp "$src"/*.js "$src"/*.html "$src"/manifest.json "$stage"/
mkdir "$stage/icons"
cp "$src"/icons/*.png "$stage/icons/"

suffix=""
if [ "$nodebug" = 1 ]; then
  python3 - "$stage/manifest.json" <<'EOF'
import json, sys
p = sys.argv[1]
m = json.load(open(p))
m["permissions"] = [x for x in m["permissions"] if x != "debugger"]
json.dump(m, open(p, "w"), indent=2)
open(p, "a").write("\n")
EOF
  suffix="-nodebugger"
fi

mkdir -p "$root/dist"
out="$root/dist/tabshot-extension-$version$suffix.zip"
rm -f "$out"
(cd "$stage" && zip -qrX "$out" .)
echo "$out"
unzip -l "$out"
