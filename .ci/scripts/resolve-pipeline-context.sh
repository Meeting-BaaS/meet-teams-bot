#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

source ".ci/scripts/detect-env.sh"

INPUT_ENVIRONMENT="${INPUT_ENVIRONMENT:-preprod}"
INPUT_SERVICE="${INPUT_SERVICE:-all}"
INPUT_IMAGE_TAG="${INPUT_IMAGE_TAG:-}"
EVENT_NAME="${GITHUB_EVENT_NAME:-push}"
REF_NAME="${GITHUB_REF_NAME:-}"
REF_TYPE="${GITHUB_REF_TYPE:-}"
MAIN_BRANCH_REF="${MAIN_BRANCH_REF:-}"

emit_output() {
  local key="${1:?key is required}"
  local value="${2-}"

  printf '%s=%s\n' "$key" "$value"
}

is_release_tag() {
  local ref_name="${1:-}"

  [[ "$ref_name" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

resolve_main_branch_ref() {
  if [[ -n "$MAIN_BRANCH_REF" ]]; then
    printf '%s\n' "$MAIN_BRANCH_REF"
    return
  fi

  local candidate_ref

  for candidate_ref in refs/remotes/origin/main refs/heads/main; do
    if git rev-parse --verify -q "$candidate_ref" >/dev/null; then
      printf '%s\n' "$candidate_ref"
      return
    fi
  done

  echo "[ERROR] Unable to resolve main branch ref for release tag validation." >&2
  exit 1
}

validate_release_tag_points_to_main_head() {
  local main_branch_ref
  local main_branch_sha
  local current_sha

  main_branch_ref="$(resolve_main_branch_ref)"
  main_branch_sha="$(git rev-parse "$main_branch_ref")"
  current_sha="$(git rev-parse HEAD)"

  if [[ "$current_sha" != "$main_branch_sha" ]]; then
    echo "[ERROR] Release tag '$REF_NAME' must point to the current HEAD of main." >&2
    exit 1
  fi
}

make_release_image_tag() {
  local release_tag="${1:?release_tag is required}"
  local date_tag

  date_tag="$(date -u +%Y-%m-%d)"

  printf '%s-%s\n' "$date_tag" "$release_tag"
}

environment=""
image_tag=""
build_matrix='[]'
deploy_target=""
should_run="false"
release_tag=""

if [[ "$EVENT_NAME" == "workflow_dispatch" ]]; then
  environment="$INPUT_ENVIRONMENT"

  if [[ "$environment" == "prod" ]]; then
    echo "[ERROR] Prod pipeline must be triggered by pushing to main with a release tag matching vX.X.X." >&2
    exit 1
  fi

  case "$INPUT_SERVICE" in
    all|meet-teams-bots)
      build_matrix='["meet-teams-bots"]'
      deploy_target="meet-teams-bots"
      ;;
    *)
      echo "[ERROR] Unsupported manual deploy service: ${INPUT_SERVICE} (this repository deploys only 'meet-teams-bots')" >&2
      exit 1
      ;;
  esac

  image_tag="${INPUT_IMAGE_TAG:-$(make_image_tag)}"
  should_run="true"
else
  if [[ "$REF_TYPE" == "tag" ]]; then
    # vX.Y.Z tags here are written by the monorepo's release (tag fan-out); the prod
    # image was already built there from v2-improvements. Nothing to do.
    echo "[ERROR] Tags do not deploy from this repository: prod is released by a vX.Y.Z tag on meeting-baas-v2 main." >&2
    exit 1
  else
    case "$REF_NAME" in
      preprod)
        environment="preprod"
        build_matrix='["meet-teams-bots"]'
        deploy_target="meet-teams-bots"
        image_tag="${INPUT_IMAGE_TAG:-$(make_image_tag)}"
        should_run="true"
        ;;
      *)
        echo "[ERROR] Unsupported branch for deployment: ${REF_NAME}" >&2
        exit 1
        ;;
    esac
  fi
fi

emit_output "environment" "$environment"
emit_output "image_tag" "$image_tag"
emit_output "build_matrix" "$build_matrix"
emit_output "deploy_target" "$deploy_target"
emit_output "should_run" "$should_run"
emit_output "release_tag" "$release_tag"