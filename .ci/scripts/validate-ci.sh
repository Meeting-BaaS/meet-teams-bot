#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# Dry-run the provider-agnostic scripts so a broken pipeline is caught on the
# PR, not on the first push to preprod. Mirrors meeting-baas-v2's validate-ci.sh
# for the one service this repository ships (both browser-bot pools, preprod only).

echo "[INFO] Validating CI scripts..."

echo "[INFO] Checking shell syntax..."
for script in .ci/scripts/*.sh .ci/scripts/git/*.sh .githooks/*; do
  bash -n "$script"
done

echo "[INFO] Testing preprod push context..."
preprod_context="$(GITHUB_EVENT_NAME=push GITHUB_REF_NAME=preprod GITHUB_REF_TYPE=branch .ci/scripts/resolve-pipeline-context.sh)"
printf '%s\n' "$preprod_context" | grep -Fqx 'environment=preprod'
printf '%s\n' "$preprod_context" | grep -Fqx 'build_matrix=["web-based-bots"]'
printf '%s\n' "$preprod_context" | grep -Fqx 'deploy_target=web-based-bots'
printf '%s\n' "$preprod_context" | grep -Fqx 'should_run=true'

echo "[INFO] Testing manual dispatch context..."
dispatch_context="$(GITHUB_EVENT_NAME=workflow_dispatch INPUT_ENVIRONMENT=preprod INPUT_SERVICE=web-based-bots INPUT_IMAGE_TAG=manual-tag .ci/scripts/resolve-pipeline-context.sh)"
printf '%s\n' "$dispatch_context" | grep -Fqx 'image_tag=manual-tag'
printf '%s\n' "$dispatch_context" | grep -Fqx 'deploy_target=web-based-bots'

echo "[INFO] Rejecting a release tag (prod is released from the monorepo)..."
if GITHUB_EVENT_NAME=push GITHUB_REF_NAME=v9.9.9 GITHUB_REF_TYPE=tag .ci/scripts/resolve-pipeline-context.sh >/dev/null 2>&1; then
  echo "[ERROR] A release tag must not deploy from this repository" >&2
  exit 1
fi

echo "[INFO] Rejecting a manual prod dispatch..."
if GITHUB_EVENT_NAME=workflow_dispatch INPUT_ENVIRONMENT=prod INPUT_SERVICE=web-based-bots .ci/scripts/resolve-pipeline-context.sh >/dev/null 2>&1; then
  echo "[ERROR] Manual prod dispatch should be rejected" >&2
  exit 1
fi

echo "[INFO] Testing build and push dry-run..."
DRY_RUN=true ENVIRON=preprod .ci/scripts/build-and-push.sh --service web-based-bots --image-tag dry-run-tag >/dev/null
rm -f .ci/web-based-bots.local-image .ci/web-based-bots.remote-image

echo "[INFO] Testing deploy dry-run..."
FAKE_DEPLOYMENT=".ci/tmp-validate"
rm -rf "$FAKE_DEPLOYMENT"
mkdir -p "$FAKE_DEPLOYMENT/deployment/helm-charts"
touch "$FAKE_DEPLOYMENT/deployment/helm-charts/baas_controller.sh" "$FAKE_DEPLOYMENT/deployment/kubeconfig.yaml"
deploy_output="$(DRY_RUN=true HOME="$ROOT_DIR/$FAKE_DEPLOYMENT/home" .ci/scripts/deploy.sh --service web-based-bots --environment preprod --image-tag dry-run-tag --deployment-dir "$FAKE_DEPLOYMENT/deployment")"
rm -rf "$FAKE_DEPLOYMENT"
printf '%s\n' "$deploy_output" | grep -Fq 'web-based-bots-v2 upgrade'
if DRY_RUN=true .ci/scripts/deploy.sh --service web-based-bots --environment prod --image-tag dry-run-tag >/dev/null 2>&1; then
  echo "[ERROR] A prod deploy must be rejected here" >&2
  exit 1
fi

echo "[INFO] Testing branch name and PR target policy..."
BRANCH_NAME=preprod PR_BASE_BRANCH=v2-improvements GITHUB_EVENT_NAME=pull_request bash .ci/scripts/git/validate-branch-name.sh >/dev/null
BRANCH_NAME=feat/x PR_BASE_BRANCH=preprod GITHUB_EVENT_NAME=pull_request bash .ci/scripts/git/validate-branch-name.sh >/dev/null
if BRANCH_NAME=feat/x PR_BASE_BRANCH=v2-improvements GITHUB_EVENT_NAME=pull_request bash .ci/scripts/git/validate-branch-name.sh >/dev/null 2>&1; then
  echo "[ERROR] A feature branch must not target v2-improvements directly" >&2
  exit 1
fi
BRANCH_NAME=feat/valid-branch GITHUB_EVENT_NAME=push GITHUB_REF_TYPE=branch bash .ci/scripts/git/validate-branch-name.sh >/dev/null
if BRANCH_NAME=Bad_Branch GITHUB_EVENT_NAME=push GITHUB_REF_TYPE=branch bash .ci/scripts/git/validate-branch-name.sh >/dev/null 2>&1; then
  echo "[ERROR] Invalid branch name should be rejected" >&2
  exit 1
fi

echo "[SUCCESS] CI scripts validated"
