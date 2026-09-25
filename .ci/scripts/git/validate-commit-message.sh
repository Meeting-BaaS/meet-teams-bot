#!/usr/bin/env bash
set -euo pipefail

COMMIT_PATTERN='^(feat|fix|chore|docs|refactor|test|ci|build|perf|revert)(\([a-z0-9][a-z0-9._/-]*\))?!?: .+$'

normalize_subject() {
  local subject="${1:?subject is required}"

  subject="${subject#fixup! }"
  subject="${subject#squash! }"

  printf '%s\n' "$subject"
}

resolve_commit_subject() {
  if [[ -n "${COMMIT_SUBJECT:-}" ]]; then
    printf '%s\n' "$COMMIT_SUBJECT"
    return
  fi

  local commit_message_file="${1:-}"

  if [[ -z "$commit_message_file" ]]; then
    echo "[ERROR] Commit message file path is required." >&2
    exit 1
  fi

  if [[ ! -f "$commit_message_file" ]]; then
    echo "[ERROR] Commit message file not found: $commit_message_file" >&2
    exit 1
  fi

  sed -n '1p' "$commit_message_file"
}

subject="$(resolve_commit_subject "${1:-}")"

if [[ -z "${subject//[[:space:]]/}" ]]; then
  echo "[ERROR] Commit subject cannot be empty." >&2
  exit 1
fi

if [[ "$subject" =~ ^Merge[[:space:]] ]]; then
  echo "[SUCCESS] Merge commit subject is allowed."
  exit 0
fi

normalized_subject="$(normalize_subject "$subject")"

if [[ ! "$normalized_subject" =~ $COMMIT_PATTERN ]]; then
  echo "[ERROR] Invalid commit subject: $subject" >&2
  echo "[ERROR] Use conventional commits, for example: feat: add deploy guard or fix(ci): handle tagged prod release." >&2
  exit 1
fi

echo "[SUCCESS] Commit subject follows the convention."