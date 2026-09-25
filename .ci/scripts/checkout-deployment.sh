#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# Fetch the private deployment repo (charts, environment overrides, kubeconfig,
# and its nested helm-charts controller) into a gitignored folder for one deploy.
# This repository does not carry it as a submodule: the ref to deploy with is
# chosen here, so a chart change never needs a pointer bump on this side.
#
#   DEPLOYMENT_REPO  git@github.com:Meeting-BaaS/kubernetes-config-private.git
#   DEPLOYMENT_REF   branch or tag to check out (default: v2)
#   DEPLOYMENT_DIR   where to put it (default: .ci/deployment)
#   GITHUB_ACCESS_TOKEN  in CI: token for HTTPS clones of both private repos

DEPLOYMENT_REPO="${DEPLOYMENT_REPO:-git@github.com:Meeting-BaaS/kubernetes-config-private.git}"
DEPLOYMENT_REF="${DEPLOYMENT_REF:-v2}"
DEPLOYMENT_DIR="${DEPLOYMENT_DIR:-.ci/deployment}"

git_args=()
if [[ -n "${GITHUB_ACCESS_TOKEN:-}" ]]; then
  # Same auth as meeting-baas-v2's init-submodules.sh: an extraheader for
  # github.com and SSH URLs rewritten to HTTPS, passed as -c so they reach the
  # nested helm-charts clone too.
  token="$(printf '%s' "${GITHUB_ACCESS_TOKEN}" | tr -d '[:space:]')"
  # base64 wraps at 76 columns by default; a fine-grained token is long enough
  # to wrap, and a newline inside the header makes curl refuse the request.
  auth_header="$(printf 'x-access-token:%s' "${token}" | base64 | tr -d '\n')"
  git_args=(
    -c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth_header}"
    -c "url.https://github.com/.insteadOf=git@github.com:"
  )
fi

if [[ -d "$DEPLOYMENT_DIR/.git" ]]; then
  echo "[INFO] Updating deployment checkout in $DEPLOYMENT_DIR to $DEPLOYMENT_REF"
  git "${git_args[@]}" -C "$DEPLOYMENT_DIR" fetch --depth 1 origin "$DEPLOYMENT_REF"
  git "${git_args[@]}" -C "$DEPLOYMENT_DIR" checkout -q --detach FETCH_HEAD
else
  echo "[INFO] Cloning deployment repo ($DEPLOYMENT_REF) into $DEPLOYMENT_DIR"
  rm -rf "$DEPLOYMENT_DIR"
  git "${git_args[@]}" clone --quiet --depth 1 --branch "$DEPLOYMENT_REF" "$DEPLOYMENT_REPO" "$DEPLOYMENT_DIR"
fi

git "${git_args[@]}" -C "$DEPLOYMENT_DIR" submodule update --init --recursive --depth 1

echo "[SUCCESS] Deployment repo ready at $DEPLOYMENT_DIR ($(git -C "$DEPLOYMENT_DIR" rev-parse --short HEAD))"
