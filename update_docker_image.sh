#!/bin/bash
set -euo pipefail

# Load environment variables from .env file if it exists AND ENVIRON is not already set
if [ -z "${ENVIRON:-}" ]; then
  if [ -f "../../.env" ]; then
    echo "[DEBUG] Loading environment variables from ../../.env"
    source ../../.env
  elif [ -f "../.env" ]; then
    echo "[DEBUG] Loading environment variables from ../.env"
    source ../.env
  elif [ -f ".env" ]; then
    echo "[DEBUG] Loading environment variables from .env"
    source .env
  else
    echo "[DEBUG] No .env file found, using existing environment variables"
  fi
else
  echo "[DEBUG] ENVIRON already set to '$ENVIRON', skipping .env file loading"
fi

BEGIN_TS=$(date +%s)

IMAGE_NAME=recording-server

# Function to tag and upload the image
upload_image() {
  echo "[DEBUG] Checking Docker daemon..."
  if ! docker info > /dev/null 2>&1; then
    echo "[ERROR] Docker daemon is not running or not accessible. Please start Docker."
    exit 1
  fi

  # Determine namespace and latest tag based on environment
  if [ "${ENVIRON:-}" == "preprod" ]; then
    IMAGE_REPO=rg.fr-par.scw.cloud/baas-fargate
    REMOT_IMAGE_LATEST=$IMAGE_REPO/$IMAGE_NAME:preprod-latest
    echo "[DEBUG] Using PREPROD namespace: $IMAGE_REPO"
  elif [ "${ENVIRON:-}" == "prod" ]; then
    IMAGE_REPO=rg.fr-par.scw.cloud/baas-fargate
    REMOT_IMAGE_LATEST=$IMAGE_REPO/$IMAGE_NAME:latest
    echo "[DEBUG] Using PRODUCTION namespace: $IMAGE_REPO"
    echo "[WARNING] You are about to deploy to PRODUCTION!"
    if [[ "$AUTO_CONFIRM" == true ]]; then
      CONFIRM="yes"
    else
      read -rp "Are you sure you want to continue? (type 'yes' to confirm): " CONFIRM
    fi
    if [ "$CONFIRM" != "yes" ]; then
      echo "[INFO] Production deployment cancelled."
      exit 0
    fi
  else
    echo "[ERROR] ENVIRON must be either 'preprod' or 'prod'"
    exit 1
  fi

  # Check required Scaleway environment variables
  MISSING_VARS=()
  [ -z "${AWS_SECRET_ACCESS_KEY:-}" ] && MISSING_VARS+=(AWS_SECRET_ACCESS_KEY)
  [ -z "${AWS_ACCESS_KEY_ID:-}" ] && MISSING_VARS+=(AWS_ACCESS_KEY_ID)
  [ -z "${AWS_PROJECT_ID:-}" ] && MISSING_VARS+=(AWS_PROJECT_ID)
  if [ ${#MISSING_VARS[@]} -ne 0 ]; then
    echo "[ERROR] The following required environment variables are missing: ${MISSING_VARS[*]}"
    echo "Please source your Scaleway environment or set these variables before running this script."
    exit 1
  fi

  echo "[DEBUG] Using AWS_PROJECT_ID=$AWS_PROJECT_ID"
  echo "[DEBUG] Using AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:0:4}****"
  echo "[DEBUG] Using AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:0:4}****"

  # Get the git commit hash for tagging
  IMAGE_TAG=git-$(git rev-parse HEAD)
  echo "[DEBUG] Using git commit hash: $IMAGE_TAG"

  # Build the Docker image
  echo "[DEBUG] Building Docker image..."
  if ! docker build -f Dockerfile . --tag=$IMAGE_TAG; then
    echo "[ERROR] Docker build failed. Aborting."
    exit 1
  fi

  BUILD_TS=$(date +%s)

  # Tag for registry :latest
  docker tag $IMAGE_TAG $REMOT_IMAGE_LATEST

  # Tag with git commit hash
  REMOT_IMAGE_FULL=$IMAGE_REPO/$IMAGE_NAME:$IMAGE_TAG
  docker tag $IMAGE_TAG $REMOT_IMAGE_FULL

  # --- Push all tags ---
  echo "[DEBUG] Logging in to Scaleway Container Registry..."
  if ! echo "$AWS_SECRET_ACCESS_KEY" | docker login rg.fr-par.scw.cloud -u _token --password-stdin; then
    echo "[ERROR] Docker login to Scaleway Container Registry failed. Aborting."
    exit 1
  fi

  echo "[DEBUG] Pushing image to $REMOT_IMAGE_LATEST..."
  if ! docker push $REMOT_IMAGE_LATEST; then
    echo "[ERROR] Failed to push latest Docker image to Scaleway Container Registry. Aborting."
    exit 1
  fi

  echo "[DEBUG] Pushing image to $REMOT_IMAGE_FULL..."
  if ! docker push $REMOT_IMAGE_FULL; then
    echo "[ERROR] Failed to push git-tagged Docker image to Scaleway Container Registry. Aborting."
    exit 1
  fi
  echo "[DEBUG] Image pushed to $REMOT_IMAGE_FULL"

  TOTAL_TS=$(date +%s)

  echo "Build duration "$(($BUILD_TS - $BEGIN_TS))" seconds"
  echo "Push duration "$(($TOTAL_TS - $BUILD_TS))" seconds"
  echo "Total duration "$(($TOTAL_TS - $BEGIN_TS))" seconds"
  echo "[SUCCESS] All images pushed successfully!"
  echo "IMAGE_TAG=$IMAGE_TAG"
}

# Parse arguments
MODE=""
NON_INTERACTIVE=false
AUTO_CONFIRM=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build|--deploy)
      MODE="build"
      shift
      ;;
    --upload)
      MODE="upload"
      shift
      ;;
    --non-interactive)
      NON_INTERACTIVE=true
      shift
      ;;
    --yes)
      AUTO_CONFIRM=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$MODE" ]]; then
  if [[ "$NON_INTERACTIVE" == true ]]; then
    MODE="build"
  else
    echo "What do you want to do?"
    echo "A. Upload existing image (skip build)"
    echo "B. Build and upload image"
    echo "Q. Quit"
    read -rp "Enter choice [A/B/Q]: " CHOICE
    case "$CHOICE" in
      [Aa]) MODE="upload" ;;
      [Bb]) MODE="build" ;;
      [Qq]) echo "Quitting."; exit 0 ;;
      *) echo "Invalid choice."; exit 1 ;;
    esac
  fi
fi

if [[ "$MODE" == "build" ]]; then
  # Validate environment variable
  if [ -z "${ENVIRON:-}" ]; then
    echo "[ERROR] ENVIRON not specified"
    echo "Please set ENVIRON to either 'preprod' or 'prod'"
    echo "Example: ENVIRON=preprod bash ./update_docker_image.sh"
    exit 1
  fi

  # Build and upload
  upload_image
elif [[ "$MODE" == "upload" ]]; then
  # Validate environment variable
  if [ -z "${ENVIRON:-}" ]; then
    echo "[ERROR] ENVIRON not specified"
    echo "Please set ENVIRON to either 'preprod' or 'prod'"
    echo "Example: ENVIRON=preprod bash ./update_docker_image.sh"
    exit 1
  fi

  # Check if image exists locally
  IMAGE_TAG=git-$(git rev-parse HEAD)
  if ! docker images | grep -q "$IMAGE_TAG"; then
    echo "[ERROR] Docker image with tag $IMAGE_TAG not found locally."
    echo "Please build the image first or use --build mode."
    exit 1
  fi

  upload_image
fi
