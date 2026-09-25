#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

source ".ci/env/common.env"
source ".ci/scripts/detect-env.sh"
source ".ci/scripts/registry.sh"
source ".ci/scripts/utils.sh"

SERVICE="meet-teams-bots"
IMAGE_TAG="${IMAGE_TAG:-$(make_image_tag)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service)
      SERVICE="${2:?--service requires a value}"
      shift 2
      ;;
    --image-tag)
      IMAGE_TAG="${2:?--image-tag requires a value}"
      shift 2
      ;;
    *)
      echo "[ERROR] Unknown option: $1"
      exit 1
      ;;
  esac
done

if [[ "$SERVICE" != "meet-teams-bots" ]]; then
  echo "[ERROR] Unknown service: $SERVICE (this repository builds only 'meet-teams-bots')"
  exit 1
fi

if [[ ! -f ".ci/meet-teams-bots.local-image" ]]; then
  echo "[ERROR] Missing .ci/meet-teams-bots.local-image. Run build-image.sh first."
  exit 1
fi

local_image="$(cat .ci/meet-teams-bots.local-image)"
remote_image="$(get_image_repo meet-teams-bots)/${local_image}"

echo "[INFO] Tagging image:"
echo "  local:  ${local_image}"
echo "  remote: ${remote_image}"

run_cmd docker tag "$local_image" "$remote_image"

echo "[INFO] Pushing ${remote_image}"
run_cmd docker push "$remote_image"

echo "$remote_image" > .ci/meet-teams-bots.remote-image

echo "[SUCCESS] Push completed for service: $SERVICE"
