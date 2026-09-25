#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "[INFO] Git repository not detected. Skipping git hook installation."
  exit 0
fi

git config core.hooksPath .githooks
chmod +x .githooks/*

echo "[SUCCESS] Git hooks installed using core.hooksPath=.githooks"