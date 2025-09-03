#!/bin/bash

# Meet Teams Bot - Serverless Runner
# This script provides an easy way to run the bot in serverless mode

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
ICON_FILE="📁"
ICON_BOT="🤖"
ICON_DISPLAY="🖥️"

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

# Build Docker image
build_image() {
    local image_name=${1:-meet-teams-bot}
    local date_tag
    date_tag=$(date +%Y%m%d-%H%M)
    local full_tag="${image_name}:${date_tag}"
    
    print_info "Building Meet Teams Bot Docker image..."
    print_info "Tagging as: ${full_tag}"
    docker build -t "${full_tag}" .
    print_success "Docker image built successfully: ${full_tag}"
    
    # Also tag as latest for convenience
    docker tag "${full_tag}" "${image_name}:latest"
    print_info "Also tagged as: ${image_name}:latest"
    
    # Update the image name for the rest of the script
    export DOCKER_IMAGE_NAME="${full_tag}"
}

# Create output directory
create_output_dir() {
    local output_dir="./recordings"
    mkdir -p "$output_dir"
    echo "$output_dir"
}

# Get the current Docker image name
get_docker_image() {
    local image_name=${DOCKER_IMAGE_NAME:-meet-teams-bot:latest}
    echo "$image_name"
}

# Find available port
find_available_port() {
    local start_port=${1:-8080}
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

# Mask sensitive information in JSON
mask_sensitive_json() {
    local json=$1
    # Mask API keys, tokens, and other sensitive fields
    echo "$json" | sed -E 's/("(api_key|token|secret|password|webhook|key)"[[:space:]]*:[[:space:]]*")[^"]*/\1********/g'
}

# Apply CLI overrides to JSON configuration
apply_overrides() {
    local json="$1"
    shift
    local overrides=("$@")
    
    for override in "${overrides[@]}"; do
        if [[ "$override" == *"="* ]]; then
            local key="${override%%=*}"
            local value="${override#*=}"
            
            # Use jq if available, otherwise skip overrides
            if command -v jq &> /dev/null; then
                json=$(echo "$json" | jq --arg key "$key" --arg value "$value" '.[$key] = $value')
            else
                print_warning "jq not available, skipping override: $override"
            fi
        else
            print_warning "Invalid override format: $override (must be key=value)"
        fi
    done
    
    echo "$json"
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
        print_warning "jq not found, falling back to sed for bot_uuid (may be fragile)"
        if echo "$config_json" | grep -q '"bot_uuid"[[:space:]]*:[[:space:]]*"[^\"]*"'; then
            echo "$config_json" | sed 's/"bot_uuid"[[:space:]]*:[[:space:]]*"[^\"]*"/"bot_uuid": "'$bot_uuid'"/g'
        else
            local clean_json=$(echo "$config_json" | tr -d '\n' | sed 's/[[:space:]]*$//')
            echo "$clean_json" | sed 's/\(.*\)}$/\1, "bot_uuid": "'$bot_uuid'"}/'
        fi
    fi
}

# Run bot with configuration file
run_with_config() {
    local config_file=$1
    local override_meeting_url=$2
    local recording_mode=${RECORDING:-true}  # Par défaut true
    local debug_mode=${DEBUG:-false}  # Debug mode avec VNC
    local debug_logs=${DEBUG_LOGS:-false}  # Debug logs mode
    
    if [ ! -f "$config_file" ]; then
        print_error "Configuration file '$config_file' not found"
        print_info "Please create a JSON configuration file. See bot.config.json for example format."
        exit 1
    fi
    
    local output_dir=$(create_output_dir)
    local config_json=$(cat "$config_file")
    
    # Override meeting URL if provided as argument
    if [ -n "$override_meeting_url" ]; then
        print_info "Overriding meeting URL with: $override_meeting_url"
        # Use jq if available, otherwise use sed
        if command -v jq &> /dev/null; then
            config_json=$(echo "$config_json" | jq --arg url "$override_meeting_url" '.meeting_url = $url')
        else
            print_error "jq not available, cannot override meeting URL"
            exit 1
        fi
    fi
    
    local processed_config=$(process_config "$config_json")
    
    print_info "Running Meet Teams Bot with configuration: $config_file"
    print_info "Recording enabled: $recording_mode"
    print_info "Recording mode: screen (direct capture)"
    if [ -n "$override_meeting_url" ]; then
        print_info "Meeting URL: $override_meeting_url"
    fi
    print_info "Output directory: $output_dir"
    
    # Debug mode avec VNC
    local docker_args="-p 8080:8080"
    if [ "$debug_mode" = "true" ]; then
        docker_args="-p 5900:5900 -p 8080:8080"
        print_info "🔍 DEBUG MODE: VNC enabled on port 5900"
        print_info "💻 Connect with VNC viewer to: localhost:5900"
        print_info "📱 On Mac, you can use: open vnc://localhost:5900"
    fi
    
    # Debug: Show what we're sending to Docker (first 200 chars)
    local preview=$(echo "$processed_config" | head -c 200)
    print_info "Config preview: ${preview}..."
    
    # Validate JSON is not empty
    if [ -z "$processed_config" ] || [ "$processed_config" = "{}" ]; then
        print_error "Invalid configuration format after processing."
        print_error "Original config_json: $config_json"
        print_error "Processed config: $processed_config"
        exit 1
    fi
    
    # Extract bot_uuid for summary message
    local bot_uuid
    if command -v jq &> /dev/null; then
        bot_uuid=$(echo "$processed_config" | jq -r '.bot_uuid // empty')
    fi
    
    # Add debug logs environment variable if enabled
    local debug_env=""
    if [ "$debug_logs" = "true" ]; then
        debug_env="-e DEBUG_LOGS=true"
        print_info "🐛 DEBUG logs enabled - verbose speakers logging activated"
    fi
    
    # Run the bot
    echo "$processed_config" | docker run --add-host=host.docker.internal:host-gateway -i \
        $docker_args \
        -e RECORDING="$recording_mode" \
        $debug_env \
        -v "$(pwd)/$output_dir:/app/data" \
        "$(get_docker_image)" 2>&1 | while IFS= read -r line; do
            if [[ $line == *"Starting virtual display"* ]]; then
                print_info "${ICON_DISPLAY} $line"
            elif [[ $line == *"Virtual display started"* ]]; then
                print_success "$line"
            else
                echo "$line"
            fi
        done
    
    # Check if the last command was successful
    if [ ${PIPESTATUS[0]} -eq 0 ]; then
        print_success "Bot session completed successfully"
        # List generated files with better formatting
        if [ -d "$output_dir" ] && [ "$(ls -A $output_dir)" ]; then
            echo
            print_success "Generated recordings:"
            find "$output_dir" -type f \( -name "*.mp4" -o -name "*.wav" \) -print0 | while IFS= read -r -d '' file; do
                size=$(du -h "$file" | cut -f1)
                filename=$(basename "$file")
                echo -e "  ${GREEN}${ICON_FILE} $filename${NC} (${size})"
            done
        fi
        if [ -n "$bot_uuid" ]; then
            echo -e "\n${GREEN}done, check out your recording and metadata for bot UUID in $bot_uuid${NC}"
            echo
            echo "./recordings/$bot_uuid/output.mp4"
            echo "./recordings/$bot_uuid/"  # folder for metadata and all files
        fi
    else
        print_error "Bot session failed"
        exit 1
    fi
}

# Run bot with configuration file and CLI overrides
run_with_config_and_overrides() {
    local config_file=$1
    shift
    local overrides=("$@")
    local config_json
    config_json=$(cat "$config_file")
    
    if [ ${#overrides[@]} -gt 0 ]; then
        config_json=$(apply_overrides "$config_json" "${overrides[@]}")
        print_info "Applied CLI overrides: ${overrides[*]}"
    fi
    
    local output_dir=$(create_output_dir)
    local processed_config=$(process_config "$config_json")
    local recording_mode=${RECORDING:-true}
    local debug_mode=${DEBUG:-false}
    local debug_logs=${DEBUG_LOGS:-false}
    
    print_info "Running Meet Teams Bot with configuration: $config_file"
    print_info "Recording enabled: $recording_mode"
    print_info "Recording mode: screen (direct capture)"
    print_info "Output directory: $output_dir"
    
    # Debug mode avec VNC
    local docker_args="-p 8080:8080"
    if [ "$debug_mode" = "true" ]; then
        docker_args="-p 5900:5900 -p 8080:8080"
        print_info "🔍 DEBUG MODE: VNC enabled on port 5900"
        print_info "💻 Connect with VNC viewer to: localhost:5900"
        print_info "📱 On Mac, you can use: open vnc://localhost:5900"
    fi
    
    # Debug: Show what we're sending to Docker (first 200 chars)
    local preview=$(echo "$processed_config" | head -c 200)
    print_info "Config preview: ${preview}..."
    
    # Validate JSON is not empty
    if [ -z "$processed_config" ] || [ "$processed_config" = "{}" ]; then
        print_error "Invalid configuration format after processing."
        print_error "Original config_json: $config_json"
        print_error "Processed config: $processed_config"
        exit 1
    fi
    
    # Extract bot_uuid for summary message
    local bot_uuid
    if command -v jq &> /dev/null; then
        bot_uuid=$(echo "$processed_config" | jq -r '.bot_uuid // empty')
    fi
    
    # Add debug logs environment variable if enabled
    local debug_env=""
    if [ "$debug_logs" = "true" ]; then
        debug_env="-e DEBUG_LOGS=true"
        print_info "🐛 DEBUG logs enabled - verbose speakers logging activated"
    fi
    
    # Run the bot
    echo "$processed_config" | docker run --add-host=host.docker.internal:host-gateway -i \
        $docker_args \
        -e RECORDING="$recording_mode" \
        $debug_env \
        -v "$(pwd)/$output_dir:/app/data" \
        "$(get_docker_image)" 2>&1 | while IFS= read -r line; do
            if [[ $line == *"Starting virtual display"* ]]; then
                print_info "${ICON_DISPLAY} $line"
            elif [[ $line == *"Virtual display started"* ]]; then
                print_success "$line"
            else
                echo "$line"
            fi
        done
    
    # Check if the last command was successful
    if [ ${PIPESTATUS[0]} -eq 0 ]; then
        print_success "Bot session completed successfully"
        # List generated files with better formatting
        if [ -d "$output_dir" ] && [ "$(ls -A $output_dir)" ]; then
            echo
            print_success "Generated recordings:"
            find "$output_dir" -type f \( -name "*.mp4" -o -name "*.wav" \) -print0 | while IFS= read -r -d '' file; do
                size=$(du -h "$file" | cut -f1)
                filename=$(basename "$file")
                echo -e "  ${GREEN}${ICON_FILE} $filename${NC} (${size})"
            done
        fi
        if [ -n "$bot_uuid" ]; then
            echo -e "\n${GREEN}done, check out your recording and metadata for bot UUID in $bot_uuid${NC}"
            echo
            echo "./recordings/$bot_uuid/output.mp4"
            echo "./recordings/$bot_uuid/"  # folder for metadata and all files
        fi
    else
        print_error "Bot session failed"
        exit 1
    fi
}

# Run bot in debug mode (enables debug logs + VNC)
run_debug() {
    local config_file=$1
    local override_meeting_url=$2
    
    print_info "🐛 Starting DEBUG mode - speakers debug logs + VNC enabled"
    
    # Force enable debug modes
    export DEBUG_LOGS=true
    export DEBUG=true
    
    # Call the regular run function with debug enabled
    run_with_config "$config_file" "$override_meeting_url"
}

# Run bot with JSON input
run_with_json() {
    local json_input=$1
    local recording_mode=${RECORDING:-true}  # Par défaut true
    local debug_mode=${DEBUG:-false}  # Debug mode avec VNC
    local debug_logs=${DEBUG_LOGS:-false}  # Debug logs mode
    local output_dir=$(create_output_dir)
    local processed_config=$(process_config "$json_input")
    
    print_info "Running Meet Teams Bot with provided JSON configuration"
    print_info "Recording enabled: $recording_mode"
    print_info "Recording mode: screen (direct capture)"
    print_info "Output directory: $output_dir"
    
    # Debug mode avec VNC
    local docker_args="-p 8080:8080"
    if [ "$debug_mode" = "true" ]; then
        docker_args="-p 5900:5900 -p 8080:8080 -p 3000:3000"
        print_info "🔍 DEBUG MODE: VNC enabled on port 5900"
        print_info "💻 Connect with VNC viewer to: localhost:5900"
        print_info "📱 On Mac, you can use: open vnc://localhost:5900"
    fi
    
    # Debug: Show what we're sending to Docker (first 200 chars)
    local preview=$(echo "$processed_config" | head -c 200)
    print_info "Config preview: ${preview}..."
    
    # Validate JSON is not empty
    if [ -z "$processed_config" ] || [ "$processed_config" = "{}" ]; then
        print_error "Processed configuration is empty or invalid"
        print_info "Original config: $json_input"
        exit 1
    fi
    
    # Add debug logs environment variable if enabled
    local debug_env=""
    if [ "$debug_logs" = "true" ]; then
        debug_env="-e DEBUG_LOGS=true"
        print_info "🐛 DEBUG logs enabled - verbose speakers logging activated"
    fi
    
    echo "$processed_config" | docker run --add-host=host.docker.internal:host-gateway -i \
        $docker_args \
        -e RECORDING="$recording_mode" \
        $debug_env \
        -v "$(pwd)/$output_dir:/app/data" \
        "$(get_docker_image)"
    
    print_success "Bot execution completed"
    print_info "Recordings saved to: $output_dir"
    
    # List generated files
    if [ -d "$output_dir" ] && [ "$(ls -A $output_dir)" ]; then
        print_success "Generated files:"
        find "$output_dir" -type f -name "*.mp4" -o -name "*.wav" | while read -r file; do
            size=$(du -h "$file" | cut -f1)
            echo -e "  ${GREEN}📁 $file${NC} (${size})"
        done
    fi
}

# Clean recordings directory
clean_recordings() {
    local output_dir="./recordings"
    if [ -d "$output_dir" ]; then
        print_warning "This will delete all files in $output_dir"
        read -p "Are you sure? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            rm -rf "$output_dir"/*
            print_success "Recordings directory cleaned"
        else
            print_info "Operation cancelled"
        fi
    else
        print_info "No recordings directory to clean"
    fi
}





# Show help
show_help() {
    echo -e "${BLUE}Meet Teams Bot - Serverless Runner${NC}"
    echo
    echo "Usage:"
    echo "  $0 build                     - Build the Docker image"
    echo "  $0 run <config_file> [url]   - Run bot with configuration file (optional meeting URL override)"
    echo "  $0 debug <config_file> [url] - Run bot in DEBUG mode (speakers logs + VNC enabled)"
    echo "  $0 run-json '<json>'         - Run bot with JSON configuration"
    echo "  $0 clean                     - Clean recordings directory"
    echo "  $0 help                      - Show this help message"
    echo
    echo "Environment Variables:"
    echo "  RECORDING=true|false         - Enable/disable video recording (default: true)"
    echo "  DEBUG=true|false            - Enable/disable debug mode with VNC (default: false)"
    echo "  DEBUG_LOGS=true|false       - Enable/disable speakers debug logs (default: false)"
    echo
    echo "Examples:"
    echo "  $0 build"
    echo "  $0 run bot.config.json"
    echo "  $0 debug bot.config.json                            # Debug mode: speakers logs + VNC"
    echo "  $0 run bot.config.json 'https://meet.google.com/new-meeting-url'"
    echo "  $0 debug bot.config.json 'https://meet.google.com/new-url'  # Debug with URL override"
    echo "  RECORDING=false $0 run bot.config.json  # Run without video recording"
    echo "  RECORDING=false $0 debug bot.config.json  # Debug without video recording"
    echo "  DEBUG=true $0 run bot.config.json       # Run with VNC debug access only"
    echo "  DEBUG_LOGS=true $0 run bot.config.json  # Run with speakers debug logs only"
    echo "  $0 run-json '{\"meeting_url\":\"https://meet.google.com/abc-def-ghi\", \"bot_name\":\"RecordingBot\"}'"
    echo "  RECORDING=false $0 run-json '{...}'  # Run JSON config without recording"
    echo "  DEBUG=true $0 run-json '{...}'      # Run JSON config with VNC debug"

    echo "  $0 clean"
    echo
    echo "Recording Modes:"
    echo "  • screen (default)    - Direct screen capture via FFmpeg (recommended)"
    echo
    echo "Features:"
    echo "  • Automatically generates bot_uuid if not provided"
    echo "  • Override meeting URL by passing it as last argument"
    echo "  • Control video recording with RECORDING environment variable"
    echo "  • DEBUG mode: One command to enable speakers debug logs + VNC access"
    echo "  • Debug logs: Show detailed speakers detection (DEBUG_LOGS=true)"
    echo "  • VNC access: View bot screen remotely (DEBUG=true) - localhost:5900"

    echo "  • Saves recordings to ./recordings directory (when recording enabled)"
    echo "  • Lists generated files after completion"
    echo
    echo "For configuration format, see bot.config.json"
}

# Main script logic
main() {
    case "${1:-}" in
        "build")
            check_docker
            build_image
            ;;
        "run")
            local default_config="bot.config.json"
            shift # remove 'run'
            # If first arg is a file, use it as config, else use default
            local config_file="$default_config"
            local overrides=()
            if [ -n "${1:-}" ] && [ -f "${1}" ]; then
                config_file="$1"
                shift
            fi
            # All remaining args are key=value overrides
            while [ -n "${1:-}" ]; do
                overrides+=("$1")
                shift
            done
            if [ ! -f "$config_file" ]; then
                print_error "Configuration file not found: $config_file"
                print_info "Please create $config_file or specify a config file."
                exit 1
            fi
            print_info "Using config file: $config_file"
            run_with_config_and_overrides "$config_file" "${overrides[@]}"
            ;;
        "debug")
            if [ -z "${2:-}" ]; then
                print_error "Please specify a configuration file"
                print_info "Usage: $0 debug <config_file> [meeting_url]"
                exit 1
            fi
            check_docker
            run_debug "$2" "$3"
            ;;
        "run-json")
            if [ -z "${2:-}" ]; then
                print_error "Please provide JSON configuration"
                print_info "Usage: $0 run-json '<json_config>'"
                exit 1
            fi
            check_docker
            run_with_json "$2"
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