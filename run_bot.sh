#!/bin/bash

# Meet Teams Bot - Serverless Runner
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_info()    { echo -e "${BLUE}ℹ️  $1${NC}" >&2; }
print_success() { echo -e "${GREEN}✅ $1${NC}" >&2; }
print_error()   { echo -e "${RED}❌ $1${NC}" >&2; }

# Generate UUID
generate_uuid() {
    if command -v uuidgen &> /dev/null; then
        uuidgen | tr '[:lower:]' '[:upper:]'
    elif command -v python3 &> /dev/null; then
        python3 -c "import uuid; print(str(uuid.uuid4()).upper())"
    else
        date +%s | sha256sum | head -c 32 | tr '[:lower:]' '[:upper:]'
    fi
}

# Check Docker
check_docker() {
    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed"
        exit 1
    fi
}

# Build Docker image
build_image() {
    local image_name=${1:-meet-teams-bot}
    local date_tag=$(date +%Y%m%d-%H%M)
    local full_tag="${image_name}:${date_tag}"
    
    print_info "Building Docker image: ${full_tag}"
    docker build -t "${full_tag}" .
    docker tag "${full_tag}" "${image_name}:latest"
    export DOCKER_IMAGE_NAME="${full_tag}"
    print_success "Image built: ${full_tag}"
}

# Get Docker image name
get_docker_image() {
    echo "${DOCKER_IMAGE_NAME:-meet-teams-bot:latest}"
}

# Find available port
find_port() {
    local port=${1:-3000}
    while lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; do
        [ "$port" -ge 65535 ] && { print_error "No free port found"; exit 1; }
        port=$((port + 1))
    done
    echo $port
}

# Process config JSON (add UUID if missing)
process_config() {
    local config_json="$1"
    local bot_uuid=$(generate_uuid)
    print_info "Generated bot UUID: ${bot_uuid:0:8}..."
    
    if command -v jq &> /dev/null; then
        echo "$config_json" | jq --arg bot_uuid "$bot_uuid" '.bot_uuid = $bot_uuid'
    else
        print_error "jq is required. Install it: brew install jq"
        exit 1
    fi
}

# Run bot
run_bot() {
    local config_file="$1"
    local override_url="$2"
    local recording_mode=${RECORDING:-true}
    local debug_mode=${DEBUG:-false}
    local debug_logs=${DEBUG_LOGS:-false}
    local resolution=${RESOLUTION:-720}
    
    [ ! -f "$config_file" ] && { print_error "Config file not found: $config_file"; exit 1; }
    
    local output_dir="./recordings"
    mkdir -p "$output_dir"
    
    local config_json=$(cat "$config_file")
    
    # Override meeting URL if provided
    if [ -n "$override_url" ]; then
        config_json=$(echo "$config_json" | jq --arg url "$override_url" '.meeting_url = $url')
        print_info "Overriding meeting URL: $override_url"
    fi
    
    local processed_config=$(process_config "$config_json")
    local main_port=$(find_port 3000)
    local docker_args="-p $main_port:3000"
    
    # Debug mode: add VNC port
    if [ "$debug_mode" = "true" ]; then
        local vnc_port=$(find_port 5900)
        docker_args="-p $vnc_port:5900 -p $main_port:3000"
        print_info "🔍 DEBUG MODE: VNC on port $vnc_port"
    fi
    
    print_info "Running bot (port: $main_port, resolution: ${resolution}p)"
    
    # Build env vars
    local env_vars="-e RECORDING=$recording_mode -e RESOLUTION=$resolution"
    [ "$debug_logs" = "true" ] && env_vars="$env_vars -e DEBUG_LOGS=true"
    
    # Run Docker
    echo "$processed_config" | docker run -i \
        $docker_args \
        $env_vars \
        -v "$(pwd)/$output_dir:/app/recordings" \
        "$(get_docker_image)" 2>&1 | while IFS= read -r line; do
            [[ $line == *"Virtual display"* ]] && print_info "$line" || echo "$line"
        done
    
    [ ${PIPESTATUS[0]} -eq 0 ] && print_success "Bot completed" || { print_error "Bot failed"; exit 1; }
    
    # Show results
    local bot_uuid=$(echo "$processed_config" | jq -r '.bot_uuid // empty')
    if [ -n "$bot_uuid" ] && [ -d "$output_dir/$bot_uuid" ]; then
        echo -e "\n${GREEN}✅ Done! Check recordings:${NC}"
        echo "./recordings/$bot_uuid/"
    fi
}

# Debug mode
run_debug() {
    export DEBUG=true
    export DEBUG_LOGS=true
    print_info "🐛 DEBUG MODE: VNC + debug logs enabled"
    run_bot "$1" "$2"
}

# Clean recordings
clean_recordings() {
    local output_dir="./recordings"
    [ ! -d "$output_dir" ] && { print_info "No recordings directory"; return; }
    read -p "Delete all recordings? (y/N): " -n 1 -r
    echo
    [[ $REPLY =~ ^[Yy]$ ]] && { rm -rf "$output_dir"/*; print_success "Cleaned"; } || print_info "Cancelled"
}

# Show help
show_help() {
    echo -e "${BLUE}Meet Teams Bot - Serverless Runner${NC}"
    echo
    echo "Usage:"
    echo "  $0 build                    - Build Docker image"
    echo "  $0 run <config> [url]       - Run bot"
    echo "  $0 debug <config> [url]     - Run in DEBUG mode (VNC + logs)"
    echo "  $0 clean                    - Clean recordings"
    echo
    echo "Environment Variables:"
    echo "  RESOLUTION=720|1080         - Video resolution (default: 720)"
    echo "  RECORDING=true|false        - Enable recording (default: true)"
    echo "  DEBUG=true                  - Enable VNC debug access"
    echo "  DEBUG_LOGS=true            - Enable verbose logs"
    echo
    echo "Examples:"
    echo "  $0 run bot.config.json"
    echo "  $0 debug bot.config.json"
    echo "  RESOLUTION=1080 $0 run bot.config.json"
    echo "  $0 run bot.config.json 'https://meet.google.com/abc-def'"
}

# Main
main() {
    case "${1:-}" in
        "build")
            check_docker
            build_image
            ;;
        "run")
            check_docker
            [ -z "${2:-}" ] && { print_error "Config file required"; show_help; exit 1; }
            run_bot "$2" "${3:-}"
            ;;
        "debug")
            check_docker
            [ -z "${2:-}" ] && { print_error "Config file required"; show_help; exit 1; }
            run_debug "$2" "${3:-}"
            ;;
        "clean")
            clean_recordings
            ;;
        "help"|"-h"|"--help"|"")
            show_help
            ;;
        *)
            print_error "Unknown command: $1"
            show_help
            exit 1
            ;;
    esac
}

main "$@"
