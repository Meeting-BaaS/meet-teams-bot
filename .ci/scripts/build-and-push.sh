#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

source ".ci/env/common.env"
source ".ci/scripts/detect-env.sh"

SERVICE=""
TARGET_ARCH="${TARGET_ARCH:-amd64}"
IMAGE_TAG="${IMAGE_TAG:-$(make_image_tag)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service)
      SERVICE="${2:?--service requires a value}"
      shift 2
      ;;
    --arch)
      TARGET_ARCH="${2:?--arch requires a value}"
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

if [[ -z "$SERVICE" ]]; then
  echo "[ERROR] --service is required"
  exit 1
fi

BEGIN_TS="$(date +%s)"

echo "[INFO] Build and push started"
echo "  service:   ${SERVICE}"
echo "  environ:   ${ENVIRON:-}"
echo "  image tag: ${IMAGE_TAG}"

# Log in before building so buildx can push the registry build cache (--cache-to) during
# the build, not just the final image afterwards.
.ci/scripts/docker-login.sh

.ci/scripts/build-image.sh \
  --service "$SERVICE" \
  --arch "$TARGET_ARCH" \
  --image-tag "$IMAGE_TAG"

.ci/scripts/push-image.sh \
  --service "$SERVICE" \
  --image-tag "$IMAGE_TAG"

END_TS="$(date +%s)"

echo "[SUCCESS] Build and push completed"
echo "IMAGE_TAG=${IMAGE_TAG}"
echo "Duration: $((END_TS - BEGIN_TS)) seconds"