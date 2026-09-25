#!/usr/bin/env bash
set -euo pipefail

detect_ci_provider() {
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    echo "github"
  elif [[ "${GITLAB_CI:-}" == "true" ]]; then
    echo "gitlab"
  elif [[ -n "${CODEBUILD_BUILD_ID:-}" ]]; then
    echo "codebuild"
  elif [[ -n "${JENKINS_URL:-}" ]]; then
    echo "jenkins"
  else
    echo "local"
  fi
}

detect_git_sha() {
  if [[ -n "${GITHUB_SHA:-}" ]]; then
    echo "${GITHUB_SHA}"
  elif [[ -n "${CI_COMMIT_SHA:-}" ]]; then
    echo "${CI_COMMIT_SHA}"
  elif [[ -n "${CODEBUILD_RESOLVED_SOURCE_VERSION:-}" ]]; then
    echo "${CODEBUILD_RESOLVED_SOURCE_VERSION}"
  else
    git rev-parse HEAD
  fi
}

detect_branch() {
  if [[ -n "${GITHUB_REF_NAME:-}" ]]; then
    echo "${GITHUB_REF_NAME}"
  elif [[ -n "${CI_COMMIT_REF_NAME:-}" ]]; then
    echo "${CI_COMMIT_REF_NAME}"
  elif [[ -n "${CODEBUILD_WEBHOOK_HEAD_REF:-}" ]]; then
    echo "${CODEBUILD_WEBHOOK_HEAD_REF#refs/heads/}"
  else
    git rev-parse --abbrev-ref HEAD
  fi
}

make_image_tag() {
  local git_sha
  local short_sha
  local date_tag

  git_sha="$(detect_git_sha)"
  short_sha="${git_sha:0:12}"
  date_tag="$(date -u +%Y-%m-%d)"

  echo "${date_tag}-${short_sha}"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "CI_PROVIDER=$(detect_ci_provider)"
  echo "GIT_BRANCH=$(detect_branch)"
  echo "GIT_SHA=$(detect_git_sha)"
  echo "IMAGE_TAG=$(make_image_tag)"
fi