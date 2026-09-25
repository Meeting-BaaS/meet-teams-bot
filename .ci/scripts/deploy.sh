#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

source ".ci/scripts/utils.sh"

SERVICE="web-based-bots"
TARGET_ENVIRONMENT="${ENVIRON:-}"
TARGET_IMAGE_TAG="${IMAGE_TAG:-}"
DEPLOYMENT_DIR="${DEPLOYMENT_DIR:-.ci/deployment}"
HOME_DIR="${HOME:-$ROOT_DIR/.ci/home}"

usage() {
  echo "Usage: .ci/scripts/deploy.sh --service web-based-bots --environment preprod --image-tag <tag>"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service)
      SERVICE="${2:?--service requires a value}"
      shift 2
      ;;
    --environment)
      TARGET_ENVIRONMENT="${2:?--environment requires a value}"
      shift 2
      ;;
    --image-tag)
      TARGET_IMAGE_TAG="${2:?--image-tag requires a value}"
      shift 2
      ;;
    --deployment-dir)
      DEPLOYMENT_DIR="${2:?--deployment-dir requires a value}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[ERROR] Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$TARGET_ENVIRONMENT" || -z "$TARGET_IMAGE_TAG" ]]; then
  echo "[ERROR] --environment and --image-tag are required"
  usage
  exit 1
fi

if [[ "$SERVICE" != "web-based-bots" ]]; then
  echo "[ERROR] Unsupported service: $SERVICE (this repository deploys only 'web-based-bots')"
  exit 1
fi

# Prod is released from the monorepo (a vX.Y.Z tag there builds this repository's
# v2-improvements and rolls every service); this pipeline only ever rolls preprod.
if [[ "$TARGET_ENVIRONMENT" != "preprod" ]]; then
  echo "[ERROR] Invalid environment: $TARGET_ENVIRONMENT (this repository deploys only preprod)"
  exit 1
fi

# Both browser-bot pools (meet/teams and web-based Zoom) run this image; they are rolled
# by the same controller as every other service (helm-charts, the nested submodule of the
# private deployment repo). DEPLOYMENT_DIR is a checkout of that repo: CI makes one with
# checkout-deployment.sh; by hand, point it at any clone you have.
case "$DEPLOYMENT_DIR" in
  /*) DEPLOYMENT_PATH="$DEPLOYMENT_DIR" ;;
  *) DEPLOYMENT_PATH="$ROOT_DIR/$DEPLOYMENT_DIR" ;;
esac
KUBECONFIG_PATH="${KUBECONFIG:-$DEPLOYMENT_PATH/kubeconfig.yaml}"
CONTROLLER_DIR="$DEPLOYMENT_PATH/helm-charts"
CONTROLLER_PATH="$CONTROLLER_DIR/baas_controller.sh"

if [[ ! -f "$CONTROLLER_PATH" ]]; then
  echo "[ERROR] Deployment controller not found: $CONTROLLER_PATH"
  echo "[ERROR] Run .ci/scripts/checkout-deployment.sh, or set DEPLOYMENT_DIR to an existing clone of kubernetes-config-private (with its helm-charts submodule)."
  exit 1
fi

if [[ ! -f "$KUBECONFIG_PATH" ]]; then
  echo "[ERROR] Kubeconfig not found: $KUBECONFIG_PATH"
  exit 1
fi

bootstrap_spoker_profile() {
  local spoker_profile_path="$HOME_DIR/.spokerrc"

  mkdir -p "$HOME_DIR"
  touch "$spoker_profile_path"

  if ! grep -q '^export CLUSTER_KIND=' "$spoker_profile_path"; then
    echo 'export CLUSTER_KIND=eks' >> "$spoker_profile_path"
  fi

  if ! grep -q '^export SPOKER_VERSION=' "$spoker_profile_path"; then
    echo 'export SPOKER_VERSION=1' >> "$spoker_profile_path"
  fi

  export HOME="$HOME_DIR"
}

bootstrap_spoker_profile

run_controller() {
  local command_text="${1:?command is required}"
  read -r -a command_args <<< "$command_text"

  echo "[INFO] Running deployment command: ${command_text}"

  if is_dry_run; then
    echo "[DRY-RUN] Would run: ENVIRON=${TARGET_ENVIRONMENT} IMAGE_TAG=${TARGET_IMAGE_TAG} SKIP_VALIDATION=1 KUBECONFIG=${KUBECONFIG_PATH} bash ./baas_controller.sh ${command_text}"
    return
  fi

  (
    cd "$CONTROLLER_DIR"
    ENVIRON="$TARGET_ENVIRONMENT" \
    IMAGE_TAG="$TARGET_IMAGE_TAG" \
    SKIP_VALIDATION=1 \
    KUBECONFIG="$KUBECONFIG_PATH" \
    bash ./baas_controller.sh "${command_args[@]}"
  )
}

# One web-based-bots-v2 image, two pools — the same pair the monorepo's `web-based-bots`
# target rolls.
run_controller "web-based-bots-v2 upgrade"
run_controller "web-based-zoom-bots-v2 upgrade"

echo "[SUCCESS] Deployment completed for service: $SERVICE"
