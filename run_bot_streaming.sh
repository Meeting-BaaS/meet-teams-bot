#!/bin/bash

# Meet Teams Bot - Streaming Runner
# This script runs the bot with audio streaming enabled to a local WebSocket
# Usage: ./run_bot_streaming.sh <websocket_url> [config_file] [meeting_url]

set -e

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
ICON_STREAM="📡"
ICON_BOT="🤖"

print_info()    { echo -e "${BLUE}${ICON_INFO}  $1${NC}" >&2; }
print_success() { echo -e "${GREEN}${ICON_SUCCESS} $1${NC}" >&2; }
print_warning() { echo -e "${YELLOW}${ICON_WARNING}  $1${NC}" >&2; }
print_error()   { echo -e "${RED}${ICON_ERROR} $1${NC}" >&2; }

# Show usage
show_usage() {
    echo -e "${BLUE}Meet Teams Bot - Streaming Runner${NC}"
    echo ""
    echo "Usage:"
    echo "  $0 <websocket_url> [config_file] [meeting_url]"
    echo ""
    echo "Arguments:"
    echo "  websocket_url    WebSocket URL to stream audio to (required)"
    echo "                   Example: ws://localhost:8765"
    echo "  config_file      JSON configuration file (default: params.json)"
    echo "  meeting_url      Optional meeting URL override"
    echo ""
    echo "Examples:"
    echo "  $0 ws://localhost:8765"
    echo "  $0 ws://localhost:8765 bot.config.json"
    echo "  $0 ws://localhost:8765 bot.config.json https://meet.google.com/xxx-xxxx-xxx"
    echo ""
    echo "Environment Variables:"
    echo "  RECORDING=true|false         - Enable/disable video recording (default: true)"
    echo "  DEBUG=true|false            - Enable/disable debug mode with VNC (default: false)"
    echo "  DEBUG_LOGS=true|false       - Enable/disable debug logs (default: false)"
    echo ""
    exit 1
}

# Check if websocket URL is provided
if [ -z "${1:-}" ]; then
    print_error "WebSocket URL is required"
    show_usage
fi

WEBSOCKET_URL="$1"
CONFIG_FILE="${2:-params.json}"
OVERRIDE_MEETING_URL="${3:-}"

# Validate WebSocket URL format
if [[ ! "$WEBSOCKET_URL" =~ ^ws:// ]] && [[ ! "$WEBSOCKET_URL" =~ ^wss:// ]]; then
    print_error "Invalid WebSocket URL format: $WEBSOCKET_URL"
    print_info "URL must start with ws:// or wss://"
    exit 1
fi

# Check if config file exists
if [ ! -f "$CONFIG_FILE" ]; then
    print_error "Configuration file '$CONFIG_FILE' not found"
    print_info "Please create a JSON configuration file"
    exit 1
fi

echo -e "${BLUE}${ICON_STREAM} Audio Streaming Mode${NC}"
echo -e "${BLUE}WebSocket: $WEBSOCKET_URL${NC}"
echo -e "${BLUE}Config: $CONFIG_FILE${NC}"
if [ -n "$OVERRIDE_MEETING_URL" ]; then
    echo -e "${BLUE}Meeting: $OVERRIDE_MEETING_URL${NC}"
fi
echo ""

# Source the main run_bot.sh functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check if Docker is available
if ! command -v docker &> /dev/null; then
    print_error "Docker is not installed or not in PATH"
    print_info "Please install Docker: https://docs.docker.com/get-docker/"
    exit 1
fi

# Get Docker image
get_docker_image() {
    local image_name=${DOCKER_IMAGE_NAME:-meet-teams-bot:latest}
    echo "$image_name"
}

# Generate UUID
generate_uuid() {
    if command -v uuidgen &> /dev/null; then
        uuidgen | tr '[:lower:]' '[:upper:]'
    elif command -v python3 &> /dev/null; then
        python3 -c "import uuid; print(str(uuid.uuid4()).upper())"
    elif command -v node &> /dev/null; then
        node -e "console.log(require('crypto').randomUUID().toUpperCase())"
    else
        date +%s | sha256sum | head -c 8 | tr '[:lower:]' '[:upper:]'
        echo "-$(date +%N | head -c 4 | tr '[:lower:]' '[:upper:]')-$(date +%N | tail -c 4 | tr '[:lower:]' '[:upper:]')-$(shuf -i 1000-9999 -n 1)-$(shuf -i 100000000000-999999999999 -n 1)"
    fi
}

# Process JSON configuration to add UUID if missing
process_config() {
    local config_json="$1"
    local bot_uuid
    bot_uuid=$(generate_uuid)
    print_info "${ICON_BOT} Generated bot session ID: ${bot_uuid:0:8}..."
    if command -v jq &> /dev/null; then
        echo "$config_json" | jq --arg bot_uuid "$bot_uuid" '.bot_uuid = $bot_uuid'
    else
        print_warning "jq not found, falling back to sed for bot_uuid"
        if echo "$config_json" | grep -q '"bot_uuid"[[:space:]]*:[[:space:]]*"[^\"]*"'; then
            echo "$config_json" | sed 's/"bot_uuid"[[:space:]]*:[[:space:]]*"[^\"]*/\"bot_uuid\": \"'$bot_uuid'\"/g'
        else
            local clean_json=$(echo "$config_json" | tr -d '\n' | sed 's/[[:space:]]*$//')
            echo "$clean_json" | sed 's/\(.*\)}$/\1, "bot_uuid": "'$bot_uuid'"}/'
        fi
    fi
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

# Main function to run the bot
run_bot() {
    print_info "${ICON_STREAM} Starting bot with audio streaming enabled..."
    print_info "📊 Audio will be streamed to: $WEBSOCKET_URL"
    echo ""

    # Read and process config
    local output_dir=$(create_output_dir)
    local config_json=$(cat "$CONFIG_FILE")

    # Override meeting URL if provided
    if [ -n "$OVERRIDE_MEETING_URL" ]; then
        print_info "Overriding meeting URL with: $OVERRIDE_MEETING_URL"
        if command -v jq &> /dev/null; then
            config_json=$(echo "$config_json" | jq --arg url "$OVERRIDE_MEETING_URL" '.meeting_url = $url')
        else
            print_error "jq not available, cannot override meeting URL"
            exit 1
        fi
    fi

    local processed_config=$(process_config "$config_json")

    # Get recording and debug settings
    local recording_mode=${RECORDING:-true}
    local debug_mode=${DEBUG:-false}
    local debug_logs=${DEBUG_LOGS:-false}

    print_info "Recording enabled: $recording_mode"
    print_info "Output directory: $output_dir"

    # Find available port for bot API
    local main_port=$(find_available_port 3000)
    if [ $? -ne 0 ]; then
        print_error "Failed to allocate port for bot instance"
        exit 1
    fi

    print_info "📡 Bot API will be accessible on port $main_port"

    # Setup Docker args
    local docker_args="-p $main_port:3000"
    if [ "$debug_mode" = "true" ]; then
        local vnc_port=$(find_available_port 5900)
        docker_args="-p $vnc_port:5900 -p $main_port:3000"
        print_info "🔍 DEBUG MODE: VNC enabled on port $vnc_port"
        print_info "💻 Connect with VNC viewer to: localhost:$vnc_port"
    fi

    # Add debug logs if enabled
    local debug_env=""
    if [ "$debug_logs" = "true" ]; then
        debug_env="-e DEBUG_LOGS=true"
        print_info "🐛 DEBUG logs enabled - verbose logging activated"
    fi

    # Validate config
    if [ -z "$processed_config" ] || [ "$processed_config" = "{}" ]; then
        print_error "Invalid configuration format after processing"
        exit 1
    fi

    # Extract bot_uuid for later use
    local bot_uuid
    if command -v jq &> /dev/null; then
        bot_uuid=$(echo "$processed_config" | jq -r '.bot_uuid // empty')
    fi

    # Convert local WebSocket URL for Docker container
    # If using localhost, convert to host.docker.internal for Docker
    DOCKER_WEBSOCKET_URL="$WEBSOCKET_URL"
    if [[ "$WEBSOCKET_URL" =~ localhost ]] || [[ "$WEBSOCKET_URL" =~ 127\.0\.0\.1 ]]; then
        DOCKER_WEBSOCKET_URL=$(echo "$WEBSOCKET_URL" | sed 's/localhost/host.docker.internal/g' | sed 's/127\.0\.0\.1/host.docker.internal/g')
        print_info "🔄 Converted WebSocket URL for Docker: $DOCKER_WEBSOCKET_URL"
    fi

    # Set streaming_output in config
    print_info "Setting streaming_output to: $DOCKER_WEBSOCKET_URL"
    if command -v jq &> /dev/null; then
        processed_config=$(echo "$processed_config" | jq --arg url "$DOCKER_WEBSOCKET_URL" '.streaming_output = $url')
    else
        print_error "jq not available, cannot set streaming_output"
        exit 1
    fi

    print_success "🚀 Starting bot with streaming to $DOCKER_WEBSOCKET_URL"
    echo ""

    # Run the bot with streaming enabled
    echo "$processed_config" | docker run -i \
        $docker_args \
        -e RECORDING="$recording_mode" \
        -e STREAMING_OUTPUT="$DOCKER_WEBSOCKET_URL" \
        $debug_env \
        -v "$(pwd)/$output_dir:/app/recordings" \
        "$(get_docker_image)" 2>&1 | while IFS= read -r line; do
            # Highlight streaming-related messages
            if [[ $line == *"WebSocket"* ]] || [[ $line == *"streaming"* ]] || [[ $line == *"Streaming"* ]]; then
                echo -e "${GREEN}${ICON_STREAM} $line${NC}"
            elif [[ $line == *"Starting virtual display"* ]]; then
                print_info "$line"
            elif [[ $line == *"Virtual display started"* ]]; then
                print_success "$line"
            else
                echo "$line"
            fi
        done

    # Check if the last command was successful
    if [ ${PIPESTATUS[0]} -eq 0 ]; then
        print_success "Bot session completed successfully"
        # List generated files
        if [ -d "$output_dir" ] && [ "$(ls -A $output_dir)" ]; then
            echo ""
            print_success "Generated recordings:"
            find "$output_dir" -type f \( -name "*.mp4" -o -name "*.wav" \) -print0 | while IFS= read -r -d '' file; do
                size=$(du -h "$file" | cut -f1)
                filename=$(basename "$file")
                echo -e "  ${GREEN}📁 $filename${NC} (${size})"
            done
        fi
        if [ -n "$bot_uuid" ]; then
            echo ""
            echo -e "${GREEN}done, check out your recording and metadata for bot UUID: $bot_uuid${NC}"
            echo ""
            echo "./recordings/$bot_uuid/output.mp4"
            echo "./recordings/$bot_uuid/"
        fi
    else
        print_error "Bot session failed"
        exit 1
    fi
}

# Run the bot
run_bot
