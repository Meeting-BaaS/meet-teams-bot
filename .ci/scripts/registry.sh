#!/usr/bin/env bash
set -euo pipefail

# The bot image (web-based-bots-v2) lives in the bots registry namespace of each
# environment, the same one the monorepo pipeline pushes to, so the Helm charts'
# imagePullSecret and the on-cluster allowlists need nothing new.
get_image_repo() {
  local service="${1:?service is required}"

  if [[ "$service" != "meet-teams-bots" ]]; then
    echo "[ERROR] Unknown service: $service (this repository builds only 'meet-teams-bots')" >&2
    exit 1
  fi

  case "${ENVIRON:-}" in
    preprod)
      echo "rg.fr-par.scw.cloud/baas-bots-preprod"
      ;;
    prod)
      echo "rg.fr-par.scw.cloud/meeting-baas-prod-bots"
      ;;
    *)
      echo "[ERROR] ENVIRON must be either 'preprod' or 'prod'. Current: '${ENVIRON:-empty}'" >&2
      exit 1
      ;;
  esac
}
