#!/bin/bash

# Compatible with Smart Rabbit

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_info()    { echo -e "${BLUE}ℹ️  $1${NC}" >&2; }
print_success() { echo -e "${GREEN}✅ $1${NC}" >&2; }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}" >&2; }
print_error()   { echo -e "${RED}❌ $1${NC}" >&2; }

# Generate UUID
generate_uuid() {
    if command -v uuidgen &> /dev/null; then
        uuidgen | tr '[:lower:]' '[:upper:]'
    else
        # Fallback: generate a pseudo-UUID
        date +%s | sha256sum | head -c 8 | tr '[:lower:]' '[:upper:]'
        echo "-$(date +%N | head -c 4 | tr '[:lower:]' '[:upper:]')-$(date +%N | tail -c 4 | tr '[:lower:]' '[:upper:]')-$(shuf -i 1000-9999 -n 1)-$(shuf -i 100000000000-999999999999 -n 1)"
    fi
}

# Check if Docker is available
check_docker() {
    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed or not in PATH"
        exit 1
    fi
}

# Build Docker image
build_image() {
    local image_name=${1:-meet-teams-bot}
    local date_tag=$(date +%Y%m%d-%H%M)
    local full_tag="${image_name}:${date_tag}"
    
    print_info "Building Meet Teams Bot Docker image..."
    docker build -t "${full_tag}" .
    docker tag "${full_tag}" "${image_name}:latest"
    print_success "Docker image built: ${full_tag} and latest"
}

# Create output directory
create_output_dir() {
    local output_dir="./output"
    mkdir -p "$output_dir"
    echo "$output_dir"
}

# Process JSON configuration to add UUID if missing or empty
process_config() {
    local config_json="$1"
    local bot_uuid=$(generate_uuid)
    print_info "🤖 Generated bot session ID: ${bot_uuid:0:8}..."
    
    # Check if bot_uuid exists and is not empty
    if echo "$config_json" | grep -q '"bot_uuid"[[:space:]]*:[[:space:]]*"[^"]*"'; then
        # Check if bot_uuid is empty ("" or just whitespace)
        if echo "$config_json" | grep -q '"bot_uuid"[[:space:]]*:[[:space:]]*""'; then
            # Replace empty bot_uuid with generated one
            echo "$config_json" | sed 's/"bot_uuid"[[:space:]]*:[[:space:]]*""/"bot_uuid": "'$bot_uuid'"/g'
        else
            # bot_uuid exists and is not empty, keep original
            echo "$config_json"
        fi
    else
        # Add bot_uuid to JSON
        local clean_json=$(echo "$config_json" | tr -d '\n' | sed 's/[[:space:]]*$//')
        echo "$clean_json" | sed 's/\(.*\)}$/\1, "bot_uuid": "'$bot_uuid'"}/'
    fi
}

# Cleanup function for Docker containers
cleanup_docker() {
    if [ -n "${CONTAINER_ID:-}" ]; then
        print_info "🧹 Cleaning up Docker container: ${CONTAINER_ID:0:12}..."
        docker stop "$CONTAINER_ID" >/dev/null 2>&1 || true
        docker rm "$CONTAINER_ID" >/dev/null 2>&1 || true
        unset CONTAINER_ID
    fi
}

# Signal handler for graceful shutdown
handle_signal() {
    print_warning "🛑 Received interrupt signal, shutting down gracefully..."
    cleanup_docker
    exit 130
}

# Run bot with configuration
run_bot() {
    local config_file=$1
    local debug_mode=${DEBUG:-false}
    local debug_logs=${DEBUG_LOGS:-false}
    
    if [ ! -f "$config_file" ]; then
        print_error "Configuration file '$config_file' not found"
        exit 1
    fi
    
    # Set up signal handlers
    trap handle_signal SIGINT SIGTERM
    
    local output_dir=$(create_output_dir)
    local config_json=$(cat "$config_file")
    local processed_config=$(process_config "$config_json")
    
    print_info "Running Meet Teams Bot with configuration: $config_file"
    print_info "Output directory: $output_dir"
    
    # Docker arguments
    local docker_args="-p 8080:8080"
    if [ "$debug_mode" = "true" ]; then
        docker_args="-p 5900:5900 -p 8080:8080"
        print_info "🔍 DEBUG MODE: VNC enabled on port 5900"
    fi
    
    # Add debug logs environment variable if enabled
    local debug_env=""
    if [ "$debug_logs" = "true" ]; then
        debug_env="-e DEBUG_LOGS=true"
        print_info "🐛 DEBUG logs enabled"
    fi
    
    # Generate unique container name
    local container_name="meet-teams-bot-$(date +%s)-$$"
    
    # Run the bot with explicit container name and auto-remove
    echo "$processed_config" | docker run --name "$container_name" \
        --add-host=host.docker.internal:host-gateway \
        --rm \
        -i \
        $docker_args \
        -e HOST_USER_ID=$(id -u) \
        -e HOST_GROUP_ID=$(id -g) \
        $debug_env \
        -v "$(pwd)/$output_dir:/app/data" \
        meet-teams-bot:latest &
    
    # Store container name for cleanup
    CONTAINER_ID="$container_name"
    local docker_pid=$!
    
    # Wait for the container to finish with timeout
    local timeout_duration=${TIMEOUT:-3600}  # Default 1 hour timeout
    local start_time=$(date +%s)
    
    while kill -0 $docker_pid 2>/dev/null; do
        local current_time=$(date +%s)
        local elapsed=$((current_time - start_time))
        
        if [ $elapsed -gt $timeout_duration ]; then
            print_warning "⏰ Timeout reached (${timeout_duration}s), stopping container..."
            cleanup_docker
            kill $docker_pid 2>/dev/null || true
            print_error "Bot session timed out"
            exit 1
        fi
        
        sleep 1
    done
    
    # Wait for the process to complete
    wait $docker_pid
    local exit_code=$?
    
    # Clean up container (should be automatic with --rm, but just in case)
    cleanup_docker
    
    if [ $exit_code -eq 0 ]; then
        print_success "Bot session completed successfully"
        if [ -d "$output_dir" ] && [ "$(ls -A $output_dir)" ]; then
            print_success "Generated recordings:"
            find "$output_dir" -type f \( -name "*.mp4" -o -name "*.wav" \) -exec ls -lh {} \;
        fi
    else
        print_error "Bot session failed with exit code: $exit_code"
        exit $exit_code
    fi
}

# Show help
show_help() {
    echo -e "${BLUE}Meet Teams Bot - Simplified Runner${NC}"
    echo
    echo "Usage:"
    echo "  $0 build                    - Build the Docker image"
    echo "  $0 run <config_file>        - Run bot with configuration file"
    echo "  $0 help                     - Show this help message"
    echo
    echo "Environment Variables:"
    echo "  DEBUG=true|false           - Enable/disable debug mode with VNC (default: false)"
    echo "  DEBUG_LOGS=true|false      - Enable/disable speakers debug logs (default: false)"
    echo "  TIMEOUT=seconds            - Set timeout for bot session (default: 3600)"
    echo
    echo "Examples:"
    echo "  $0 build"
    echo "  $0 run bot.config.json"
    echo "  DEBUG=true $0 run bot.config.json       # Run with VNC debug access"
    echo "  DEBUG_LOGS=true $0 run bot.config.json  # Run with speakers debug logs"
    echo "  TIMEOUT=1800 $0 run bot.config.json     # Run with 30min timeout"
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
            if [ -z "${2:-}" ]; then
                print_error "Please specify a configuration file"
                print_info "Usage: $0 run <config_file>"
                exit 1
            fi
            check_docker
            run_bot "$2"
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