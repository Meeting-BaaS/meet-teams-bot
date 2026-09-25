#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

source ".ci/env/common.env"
source ".ci/scripts/detect-env.sh"
source ".ci/scripts/registry.sh"
source ".ci/scripts/utils.sh"

SERVICE="meet-teams-bots"
IMAGE_NAME="web-based-bots-v2"
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

if [[ "$SERVICE" != "meet-teams-bots" ]]; then
  echo "[ERROR] Unknown service: $SERVICE (this repository builds only 'meet-teams-bots')"
  exit 1
fi

# The orchestrator (@meeting-baas/sqs-consumer) is installed from GitHub Packages inside
# the build. The token reaches Docker as a BuildKit secret, never as a layer: NPM_TOKEN in
# the environment (a PAT with read:packages locally, the run's GITHUB_TOKEN in CI).
if [[ -z "${NPM_TOKEN:-}" && "${DRY_RUN:-false}" != "true" ]]; then
  echo "[ERROR] NPM_TOKEN is required to install @meeting-baas/sqs-consumer during the build."
  exit 1
fi

if [[ "$TARGET_ARCH" != "amd64" && "$TARGET_ARCH" != "arm64" ]]; then
  echo "[ERROR] Invalid architecture: $TARGET_ARCH"
  echo "Supported architectures: amd64, arm64"
  exit 1
fi

TARGET_PLATFORM="linux/${TARGET_ARCH}"

echo "[INFO] Build config:"
echo "  provider:     $(detect_ci_provider)"
echo "  branch:       $(detect_branch)"
echo "  environment:  ${ENVIRON:-}"
echo "  service:      ${SERVICE}"
echo "  image tag:    ${IMAGE_TAG}"
echo "  architecture: ${TARGET_ARCH}"
echo "  platform:     ${TARGET_PLATFORM}"

mkdir -p .ci

# When BUILDX_REGISTRY_CACHE=true (set by CI), pull/push a registry build cache
# (<image-repo>/<image>:buildcache, mode=max) so the dependency install layers are
# restored across ephemeral runners. Outside CI it is a plain local buildx build.
cache_args=()
if [[ "${BUILDX_REGISTRY_CACHE:-false}" == "true" ]]; then
  cache_ref="$(get_image_repo "$SERVICE")/${IMAGE_NAME}:buildcache"
  echo "[INFO] Registry build cache: ${cache_ref} (mode=max)"
  cache_args=(
    --cache-from "type=registry,ref=${cache_ref}"
    --cache-to "type=registry,ref=${cache_ref},mode=max"
  )
fi

echo "[INFO] Building the meet/teams bot image (web-based-bots-v2)..."

run_cmd docker buildx build \
  --platform="$TARGET_PLATFORM" \
  --build-arg TARGETPLATFORM="$TARGET_PLATFORM" \
  --build-arg BUILDPLATFORM="linux/amd64" \
  ${cache_args[@]+"${cache_args[@]}"} \
  --secret id=npm_token,env=NPM_TOKEN \
  --load \
  -f deploy/Dockerfile . \
  --tag="${IMAGE_NAME}:${IMAGE_TAG}"

echo "${IMAGE_NAME}:${IMAGE_TAG}" > ".ci/meet-teams-bots.local-image"

echo "[SUCCESS] Build completed: ${IMAGE_NAME}:${IMAGE_TAG}"
