#!/bin/bash

# Meet Teams Bot - Streaming Runner
# This script runs the bot with audio streaming enabled to a local WebSocket
# Usage: ./run_bot_streaming.sh <websocket_url> [config_file] [meeting_url]

set -e

# Source common functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/run_bot_common.sh"

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

# Check if Docker is available
check_docker

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

    # On Linux, use host network mode for simpler localhost access
    # No URL conversion needed - container shares host's network namespace
    DOCKER_WEBSOCKET_URL="$WEBSOCKET_URL"
    USE_HOST_NETWORK=true

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
    # Use host network for direct localhost access on Linux
    local network_args=""
    if [ "$USE_HOST_NETWORK" = "true" ]; then
        network_args="--network=host"
        print_info "🌐 Using host network mode for localhost WebSocket access"
    fi

    echo "$processed_config" | docker run -i \
        $network_args \
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
