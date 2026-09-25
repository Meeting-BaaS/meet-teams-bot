#!/usr/bin/env bash
set -euo pipefail

is_dry_run() {
  [[ "${DRY_RUN:-false}" == "true" ]]
}

run_cmd() {
  echo "[CMD] $*"

  if is_dry_run; then
    echo "[DRY-RUN] Skipping execution"
    return 0
  fi

  "$@"
}
