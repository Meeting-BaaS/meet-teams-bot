#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

source ".ci/scripts/detect-env.sh"

EVENT_NAME="${GITHUB_EVENT_NAME:-local}"
BRANCH_NAME="${BRANCH_NAME:-}"
PR_BASE_BRANCH="${PR_BASE_BRANCH:-${GITHUB_BASE_REF:-}}"
REF_TYPE="${GITHUB_REF_TYPE:-}"

BRANCH_PATTERN='^(feature|fix|chore|feat|bugfix)/[a-z0-9]+(-[a-z0-9]+)*([+&][a-z0-9]+(-[a-z0-9]+)*)*$'
PREPROD_BRANCH='preprod'
# The stable branch releases are cut from (the monorepo builds it on a vX.Y.Z tag).
STABLE_BRANCH='v2-improvements'

resolve_branch_name() {
  if [[ -n "$BRANCH_NAME" ]]; then
    printf '%s\n' "$BRANCH_NAME"
    return
  fi

  if [[ "$EVENT_NAME" == "pull_request" && -n "${GITHUB_HEAD_REF:-}" ]]; then
    printf '%s\n' "$GITHUB_HEAD_REF"
    return
  fi

  if [[ -n "${GITHUB_REF_NAME:-}" ]]; then
    printf '%s\n' "$GITHUB_REF_NAME"
    return
  fi

  detect_branch
}

validate_branch_name() {
  local current_branch="${1:?branch is required}"

  case "$current_branch" in
    main|"$PREPROD_BRANCH"|"$STABLE_BRANCH")
      return
      ;;
  esac

  if [[ ! "$current_branch" =~ $BRANCH_PATTERN ]]; then
    echo "[ERROR] Branch name '$current_branch' is invalid." >&2
    echo "[ERROR] Use one of: feature/<kebab-case-description>, fix/<kebab-case-description>, chore/<kebab-case-description>, feat/<kebab-case-description>, or bugfix/<kebab-case-description>." >&2
    exit 1
  fi
}

validate_pull_request_target_policy() {
  local current_branch="${1:?branch is required}"
  local base_branch="${2:-}"

  if [[ "$EVENT_NAME" != "pull_request" || -z "$base_branch" ]]; then
    return
  fi

  case "$base_branch" in
    "$PREPROD_BRANCH")
      if [[ "$current_branch" =~ $BRANCH_PATTERN ]]; then
        return
      fi

      echo "[ERROR] PRs targeting '$base_branch' must come from a naming-convention branch." >&2
      echo "[ERROR] Allowed source branches: feature/<kebab-case-description>, fix/<kebab-case-description>, chore/<kebab-case-description>, feat/<kebab-case-description>, or bugfix/<kebab-case-description>." >&2
      exit 1
      ;;
    "$STABLE_BRANCH"|main)
      # Two long-lived branches only: preprod is promoted into v2-improvements, which the
      # monorepo's release (a vX.Y.Z tag on its main) builds and tags.
      if [[ "$current_branch" == "$PREPROD_BRANCH" ]]; then
        return
      fi

      echo "[ERROR] PRs targeting '$base_branch' must come from '$PREPROD_BRANCH'." >&2
      echo "[ERROR] Allowed source branch: $PREPROD_BRANCH." >&2
      exit 1
      ;;
  esac
}

if [[ "$EVENT_NAME" == "workflow_dispatch" ]]; then
  echo "[SUCCESS] Branch convention validation skipped for manual workflow dispatch."
  exit 0
fi

if [[ "$EVENT_NAME" == "push" && "$REF_TYPE" == "tag" ]]; then
  echo "[SUCCESS] Branch convention validation skipped for tag push."
  exit 0
fi

branch_name="$(resolve_branch_name)"
validate_branch_name "$branch_name"
validate_pull_request_target_policy "$branch_name" "$PR_BASE_BRANCH"

echo "[SUCCESS] Git branch convention is valid."