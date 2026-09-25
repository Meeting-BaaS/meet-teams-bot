#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

source ".ci/env/common.env"
source ".ci/scripts/utils.sh"

REGISTRY_HOST="${REGISTRY_HOST:-$SCW_REGISTRY_HOST}"

if [[ -z "${AWS_SECRET_ACCESS_KEY:-}" && "${DRY_RUN:-false}" != "true" ]]; then
  echo "[ERROR] AWS_SECRET_ACCESS_KEY is required for Scaleway registry login."
  exit 1
fi

if is_dry_run; then
  echo "[DRY-RUN] Would login to registry: ${REGISTRY_HOST}"
else
  echo "[INFO] Logging in to registry: ${REGISTRY_HOST}"
  echo "$AWS_SECRET_ACCESS_KEY" | docker login "$REGISTRY_HOST" -u _token --password-stdin
fi
