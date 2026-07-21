#!/usr/bin/env bash
# fetch-stealthfox.sh — download + verify the invisible_playwright "stealthfox"
# patched Firefox binary used by the bot's USE_STEALTHFOX path.
#
# The binary is the anti-detect Firefox build produced by the invisible_playwright
# project (feder-cr). It is NOT bundled in this repo (~250MB compressed / ~580MB
# extracted, GPL-3 Firefox); the bot loads it at runtime via STEALTHFOX_BINARY_PATH.
# This script fetches it from the SAME GitHub release invisible_playwright's own
# download.py resolves, so the two stay in sync.
#
#   Source repo:  github.com/feder-cr/firefox_antidetect_patch  (releases)
#   Wrapper repo: github.com/feder-cr/invisible_playwright
#
# Usage:
#   ./scripts/fetch-stealthfox.sh [-d DEST_DIR] [-t TAG] [-f FIREFOX_VERSION] [-q]
#
#   -d DEST_DIR    where to extract (default: ./.stealthfox)
#   -t TAG         release tag / BINARY_VERSION (default: firefox-16)
#   -f VERSION     upstream Firefox version in the asset name (default: 150.0.1)
#   -q             quiet (only print the final binary path)
#
# On success prints the absolute path to the `firefox` binary — feed it to the bot:
#   export STEALTHFOX_BINARY_PATH="$(./scripts/fetch-stealthfox.sh -q)"
#   export USE_STEALTHFOX=true
#
# Env overrides mirror the flags: STEALTHFOX_DEST, STEALTHFOX_TAG, STEALTHFOX_FF_VERSION.
set -euo pipefail

DEST="${STEALTHFOX_DEST:-.stealthfox}"
TAG="${STEALTHFOX_TAG:-firefox-16}"
FF_VERSION="${STEALTHFOX_FF_VERSION:-150.0.1}"
QUIET=0

while getopts "d:t:f:qh" opt; do
  case "$opt" in
    d) DEST="$OPTARG" ;;
    t) TAG="$OPTARG" ;;
    f) FF_VERSION="$OPTARG" ;;
    q) QUIET=1 ;;
    h) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "invalid option; run with -h" >&2; exit 2 ;;
  esac
done

log() { [ "$QUIET" -eq 1 ] || echo "$@" >&2; }

# ── resolve os/arch → asset name + in-archive entry (mirrors invisible_core/constants.py)
uname_s="$(uname -s)"
uname_m="$(uname -m)"
case "$uname_m" in
  x86_64|amd64)   ARCH=x86_64 ;;
  arm64|aarch64)  ARCH=arm64 ;;
  *) echo "unsupported arch: $uname_m" >&2; exit 1 ;;
esac
case "$uname_s" in
  Linux)  ASSET="firefox-${FF_VERSION}-stealth-linux-${ARCH}.tar.gz"; ENTRY="firefox" ;;
  Darwin) ASSET="firefox-${FF_VERSION}-stealth-macos-${ARCH}.tar.gz"; ENTRY="Firefox.app/Contents/MacOS/firefox" ;;
  *) echo "unsupported OS: $uname_s (use invisible_playwright on Windows)" >&2; exit 1 ;;
esac

BASE="https://github.com/feder-cr/firefox_antidetect_patch/releases/download/${TAG}"
VERSION_DIR="${DEST%/}/${TAG}"
ENTRY_PATH="${VERSION_DIR}/${ENTRY}"

# ── already cached? verify the entry exists and is executable, then done.
abspath() { echo "$(cd "$VERSION_DIR" && pwd)/$ENTRY"; }

if [ -x "$ENTRY_PATH" ]; then
  log "✅ stealthfox already present: $ENTRY_PATH"
  abspath
  exit 0
fi

command -v curl >/dev/null || { echo "curl not found" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log "⬇️  downloading $ASSET  (tag=$TAG)"
http=$(curl -fL --retry 3 -o "$TMP/$ASSET" -w '%{http_code}' "$BASE/$ASSET") || {
  echo "download failed (http=$http). Check the tag exists: $BASE/$ASSET" >&2; exit 1; }

log "⬇️  downloading checksums.txt"
curl -fsSL -o "$TMP/checksums.txt" "$BASE/checksums.txt" || {
  echo "could not fetch checksums.txt for tag $TAG" >&2; exit 1; }

expected="$(grep -E "  ${ASSET}\$| \*${ASSET}\$" "$TMP/checksums.txt" | awk '{print $1}' | head -1)"
[ -n "$expected" ] || { echo "no SHA256 for $ASSET in checksums.txt" >&2; exit 1; }

if command -v sha256sum >/dev/null; then
  actual="$(sha256sum "$TMP/$ASSET" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
fi
if [ "$actual" != "$expected" ]; then
  echo "SHA256 mismatch for $ASSET" >&2
  echo "  expected: $expected" >&2
  echo "  actual:   $actual" >&2
  exit 1
fi
log "🔒 SHA256 verified"

log "📦 extracting → $VERSION_DIR"
mkdir -p "$VERSION_DIR"
tar -xzf "$TMP/$ASSET" -C "$VERSION_DIR"

[ -x "$ENTRY_PATH" ] || { echo "binary not found after extraction: $ENTRY_PATH" >&2; exit 1; }

log "✅ done. Set: export STEALTHFOX_BINARY_PATH=\"<path below>\"  USE_STEALTHFOX=true"
abspath
