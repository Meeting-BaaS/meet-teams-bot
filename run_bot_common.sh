#!/bin/bash

# Meet Teams Bot - Common Functions Library
# Shared functions used by run_bot.sh and run_bot_streaming.sh

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Emoji icons
ICON_INFO="ℹ️"
ICON_SUCCESS="✅"
ICON_WARNING="⚠️"
ICON_ERROR="❌"
ICON_FILE="📁"
ICON_BOT="🤖"
ICON_DISPLAY="🖥️"
ICON_STREAM="📡"

# Print functions
print_info()    { echo -e "${BLUE}${ICON_INFO}  $1${NC}" >&2; }
print_success() { echo -e "${GREEN}${ICON_SUCCESS} $1${NC}" >&2; }
print_warning() { echo -e "${YELLOW}${ICON_WARNING}  $1${NC}" >&2; }
print_error()   { echo -e "${RED}${ICON_ERROR} $1${NC}" >&2; }

# Generate UUID
generate_uuid() {
    if command -v uuidgen &> /dev/null; then
        uuidgen | tr '[:lower:]' '[:upper:]'
    elif command -v python3 &> /dev/null; then
        python3 -c "import uuid; print(str(uuid.uuid4()).upper())"
    elif command -v node &> /dev/null; then
        node -e "console.log(require('crypto').randomUUID().toUpperCase())"
    else
        # Fallback: generate a pseudo-UUID using date and random
        date +%s | sha256sum | head -c 8 | tr '[:lower:]' '[:upper:]'
        echo "-$(date +%N | head -c 4 | tr '[:lower:]' '[:upper:]')-$(date +%N | tail -c 4 | tr '[:lower:]' '[:upper:]')-$(shuf -i 1000-9999 -n 1)-$(shuf -i 100000000000-999999999999 -n 1)"
    fi
}

# Check if Docker is available
check_docker() {
    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed or not in PATH"
        print_info "Please install Docker: https://docs.docker.com/get-docker/"
        exit 1
    fi
}

# Get the current Docker image name
get_docker_image() {
    local image_name=${DOCKER_IMAGE_NAME:-meet-teams-bot:latest}
    echo "$image_name"
}

# Find available port
find_available_port() {
    local start_port=${1:-3000}
    local port=$start_port
    while lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; do
        if [ "$port" -ge 65535 ]; then
            print_error "No free TCP port found below 65535"
            return 1
        fi
        port=$((port + 1))
    done
    echo "$port"
}

# Create output directory
create_output_dir() {
    local output_dir="./recordings"
    mkdir -p "$output_dir"
    echo "$output_dir"
}

# Process JSON configuration to add UUID and streaming params if missing
process_config() {
    local config_json="$1"
    local bot_uuid
    bot_uuid=$(generate_uuid)
    print_info "${ICON_BOT} Generated bot session ID: ${bot_uuid:0:8}..."

    if command -v jq &> /dev/null; then
        # Build jq command to update bot_uuid and optionally streaming params
        local jq_cmd='.bot_uuid = $bot_uuid'

        if [ -n "$STREAMING_OUTPUT" ]; then
            print_info "Injecting STREAMING_OUTPUT from env: $STREAMING_OUTPUT"
            jq_cmd="$jq_cmd | .streaming_output = \"$STREAMING_OUTPUT\""
        fi

        if [ -n "$STREAMING_INPUT" ]; then
            print_info "Injecting STREAMING_INPUT from env: $STREAMING_INPUT"
            jq_cmd="$jq_cmd | .streaming_input = \"$STREAMING_INPUT\""
        fi

        if [ -n "$STREAMING_AUDIO_FREQUENCY" ]; then
            print_info "Injecting STREAMING_AUDIO_FREQUENCY from env: $STREAMING_AUDIO_FREQUENCY"
            jq_cmd="$jq_cmd | .streaming_audio_frequency = ($STREAMING_AUDIO_FREQUENCY | tonumber)"
        fi

        echo "$config_json" | jq --arg bot_uuid "$bot_uuid" "$jq_cmd"
    else
        print_warning "jq not found, falling back to sed for bot_uuid (streaming params injection skipped)"
        if echo "$config_json" | grep -q '"bot_uuid"[[:space:]]*:[[:space:]]*"[^\"]*"'; then
            echo "$config_json" | sed 's/"bot_uuid"[[:space:]]*:[[:space:]]*"[^\"]*"/"bot_uuid": "'$bot_uuid'"/g'
        else
            local clean_json=$(echo "$config_json" | tr -d '\n' | sed 's/[[:space:]]*$//')
            echo "$clean_json" | sed 's/\(.*\)}$/\1, "bot_uuid": "'$bot_uuid'"}/'
        fi
    fi
}
