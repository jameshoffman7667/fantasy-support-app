#!/usr/bin/env bash
# v4.19.0: the Android versionCode for a release version X.Y.Z:  MAJOR*100000000 + MINOR*10000 + PATCH.
# Android needs an integer that only ever grows; this keeps release order = code order (4.19.0 -> 400190000).
# Fails above MAJOR 20 or MINOR/PATCH 9999 (the code would overflow the 2,147,483,647 limit or collide).
# Usage: android/tools/version-code.sh 4.19.0   (prints the code, nothing else, on success)
set -euo pipefail
v="${1:-}"
[[ "$v" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || { echo "version '$v' is not MAJOR.MINOR.PATCH" >&2; exit 1; }
major=$((10#${BASH_REMATCH[1]})); minor=$((10#${BASH_REMATCH[2]})); patch=$((10#${BASH_REMATCH[3]}))
[ "$major" -le 20 ] || { echo "MAJOR $major is above 20: the versionCode would overflow" >&2; exit 1; }
[ "$minor" -le 9999 ] || { echo "MINOR $minor is above 9999" >&2; exit 1; }
[ "$patch" -le 9999 ] || { echo "PATCH $patch is above 9999" >&2; exit 1; }
echo $((major * 100000000 + minor * 10000 + patch))
