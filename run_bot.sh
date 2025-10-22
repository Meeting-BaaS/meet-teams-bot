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

# Find available port pair for bot instances (main port + VNC port)
find_available_port_pair() {
    local base_main_port=${1:-3000}
    local base_vnc_port=${2:-5900}
    
    # Find available main port starting from base
    local main_port=$(find_available_port $base_main_port)
    if [ $? -ne 0 ]; then
        return 1
    fi
    
    # Find available VNC port, but ensure it's not the same as main port
    local vnc_port=$base_vnc_port
    while lsof -Pi :$vnc_port -sTCP:LISTEN -t >/dev/null 2>&1 || [ "$vnc_port" -eq "$main_port" ]; do
        if [ "$vnc_port" -ge 65535 ]; then
            print_error "No free VNC port found below 65535"
            return 1
        fi
        vnc_port=$((vnc_port + 1))
    done
    
    echo "$main_port $vnc_port"
}

# Create port lock file to reserve a port (atomic operation)
create_port_lock() {
    local port=$1
    local lock_dir="/tmp/baas_port_locks"
    local lock_file="$lock_dir/port_$port.lock"
    local temp_file="$lock_dir/port_$port.lock.tmp.$$"
    
    mkdir -p "$lock_dir"
    
    # Use atomic operation: write to temp file first, then move
    if echo "$$:$(date):$(basename $0)" > "$temp_file" 2>/dev/null; then
        # Try to create lock atomically using link/mv (atomic on most filesystems)
        if (set -C; echo "$$:$(date):$(basename $0)" > "$lock_file") 2>/dev/null; then
            rm -f "$temp_file"
            return 0  # Successfully created lock
        else
            rm -f "$temp_file"
            return 1  # Lock already exists
        fi
    else
        return 1  # Failed to create temp file
    fi
}

# Check if port is locked by another process
is_port_locked() {
    local port=$1
    local lock_dir="/tmp/baas_port_locks"
    local lock_file="$lock_dir/port_$port.lock"
    
    if [ -f "$lock_file" ]; then
        # Check if the process that created the lock is still running
        local lock_pid=$(head -n 1 "$lock_file" | cut -d: -f1)
        if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
            return 0  # Port is locked and process is still running
        else
            # Lock file exists but process is dead, remove stale lock
            rm -f "$lock_file"
            return 1  # Port is not locked
        fi
    fi
    return 1  # Port is not locked
}

# Release port lock
release_port_lock() {
    local port=$1
    local lock_dir="/tmp/baas_port_locks"
    local lock_file="$lock_dir/port_$port.lock"
    
    rm -f "$lock_file"
}

# Get next available bot instance ports with locking
get_next_bot_ports() {
    local base_main_port=3000
    local base_vnc_port=5900
    local main_port=$base_main_port
    local vnc_port=$base_vnc_port
    
    # Find available main port
    while true; do
        if [ "$main_port" -ge 65535 ]; then
            print_error "No free main port found below 65535"
            return 1
        fi
        
        # Check if port is in use by the system or locked by our script
        if ! lsof -Pi :$main_port -sTCP:LISTEN -t >/dev/null 2>&1 && ! is_port_locked $main_port; then
            # Try to create lock
            if create_port_lock $main_port; then
                break
            fi
        fi
        main_port=$((main_port + 1))
    done
    
    # Find available VNC port
    while true; do
        if [ "$vnc_port" -ge 65535 ]; then
            release_port_lock $main_port  # Release main port lock
            print_error "No free VNC port found below 65535"
            return 1
        fi
        
        # Check if port is in use by the system, locked by our script, or same as main port
        if [ "$vnc_port" -ne "$main_port" ] && 
           ! lsof -Pi :$vnc_port -sTCP:LISTEN -t >/dev/null 2>&1 && 
           ! is_port_locked $vnc_port; then
            # Try to create lock
            if create_port_lock $vnc_port; then
                break
            fi
        fi
        vnc_port=$((vnc_port + 1))
    done
    
    echo "$main_port $vnc_port"
}

# Clean up port locks on script exit
cleanup_port_locks() {
    if [ -n "$ALLOCATED_MAIN_PORT" ]; then
        release_port_lock "$ALLOCATED_MAIN_PORT"
    fi
    if [ -n "$ALLOCATED_VNC_PORT" ]; then
        release_port_lock "$ALLOCATED_VNC_PORT"
    fi
}

# Set trap to cleanup on exit
trap cleanup_port_locks EXIT INT TERM

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
        print_info "Please create a JSON configuration file. See params.json for example format."
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
    
    # Get available ports for this bot instance
    local port_info
    port_info=$(get_next_bot_ports)
    if [ $? -ne 0 ]; then
        print_error "Failed to allocate ports for bot instance"
        exit 1
    fi
    
    local main_port=$(echo $port_info | cut -d' ' -f1)
    local vnc_port=$(echo $port_info | cut -d' ' -f2)
    
    # Store allocated ports globally for cleanup
    export ALLOCATED_MAIN_PORT="$main_port"
    export ALLOCATED_VNC_PORT="$vnc_port"
    
    # Debug mode avec VNC
    local docker_args="-p $main_port:3000"
    if [ "$debug_mode" = "true" ]; then
        docker_args="-p $vnc_port:5900 -p $main_port:3000"
        print_info "🔍 DEBUG MODE: VNC enabled on port $vnc_port"
        print_info "💻 Connect with VNC viewer to: localhost:$vnc_port"
        print_info "📱 On Mac, you can use: open vnc://localhost:$vnc_port"
    fi
    
    print_info "📡 Bot will be accessible on port $main_port"
    
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
    echo "$processed_config" | docker run -i \
        $docker_args \
        -e RECORDING="$recording_mode" \
        $debug_env \
        -v "$(pwd)/$output_dir:/app/recordings" \
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
    
    # Get available ports for this bot instance
    local port_info
    port_info=$(get_next_bot_ports)
    if [ $? -ne 0 ]; then
        print_error "Failed to allocate ports for bot instance"
        exit 1
    fi
    
    local main_port=$(echo $port_info | cut -d' ' -f1)
    local vnc_port=$(echo $port_info | cut -d' ' -f2)
    
    # Store allocated ports globally for cleanup
    export ALLOCATED_MAIN_PORT="$main_port"
    export ALLOCATED_VNC_PORT="$vnc_port"
    
    print_info "Running Meet Teams Bot with configuration: $config_file"
    print_info "Recording enabled: $recording_mode"
    print_info "Recording mode: screen (direct capture)"
    print_info "Output directory: $output_dir"
    print_info "📡 Bot will be accessible on port $main_port"
    
    # Debug mode avec VNC
    local docker_args="-p $main_port:3000"
    if [ "$debug_mode" = "true" ]; then
        docker_args="-p $vnc_port:5900 -p $main_port:3000"
        print_info "🔍 DEBUG MODE: VNC enabled on port $vnc_port"
        print_info "💻 Connect with VNC viewer to: localhost:$vnc_port"
        print_info "📱 On Mac, you can use: open vnc://localhost:$vnc_port"
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
    echo "$processed_config" | docker run -i \
        $docker_args \
        -e RECORDING="$recording_mode" \
        $debug_env \
        -v "$(pwd)/$output_dir:/app/recordings" \
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
    
    # Get available ports for this bot instance
    local port_info
    port_info=$(get_next_bot_ports)
    if [ $? -ne 0 ]; then
        print_error "Failed to allocate ports for bot instance"
        exit 1
    fi
    
    local main_port=$(echo $port_info | cut -d' ' -f1)
    local vnc_port=$(echo $port_info | cut -d' ' -f2)
    
    # Store allocated ports globally for cleanup
    export ALLOCATED_MAIN_PORT="$main_port"
    export ALLOCATED_VNC_PORT="$vnc_port"
    
    print_info "Running Meet Teams Bot with provided JSON configuration"
    print_info "Recording enabled: $recording_mode"
    print_info "Recording mode: screen (direct capture)"
    print_info "Output directory: $output_dir"
    print_info "📡 Bot will be accessible on port $main_port"
    
    # Debug mode avec VNC
    local docker_args="-p $main_port:3000"
    if [ "$debug_mode" = "true" ]; then
        docker_args="-p $vnc_port:5900 -p $main_port:3000"
        print_info "🔍 DEBUG MODE: VNC enabled on port $vnc_port"
        print_info "💻 Connect with VNC viewer to: localhost:$vnc_port"
        print_info "📱 On Mac, you can use: open vnc://localhost:$vnc_port"
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
    
    echo "$processed_config" | docker run -i \
        $docker_args \
        -e RECORDING="$recording_mode" \
        $debug_env \
        -v "$(pwd)/$output_dir:/app/recordings" \
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

# Test recording system
test_recording() {
    local duration=${1:-30}  # Par défaut 30 secondes
    local debug_mode=${DEBUG:-false}  # Debug mode avec VNC
    
    print_info "🧪 Testing screen recording system"
    print_info "📅 Test duration: ${duration}s"
    print_info "📄 Using normal run command with params.json"
    if [ "$debug_mode" = "true" ]; then
        print_info "🔍 DEBUG MODE: VNC will be available on port 5900"
        print_info "💻 Connect with: open vnc://localhost:5900"
    fi
    
    # Vérifier que Docker est disponible
    check_docker
    
    # Vérifier que params.json existe
    if [ ! -f "params.json" ]; then
        print_error "params.json not found!"
        print_info "Please create params.json with your meeting configuration"
        return 1
    fi
    
    # Construire l'image si nécessaire
    if ! docker images | grep -q "$(get_docker_image | cut -d: -f1)"; then
        print_info "Docker image not found, building..."
        build_image
    fi
    
    print_info "🚀 Starting normal bot run with screen recording..."
    print_info "ℹ️ Will automatically stop after ${duration}s"
    
    # Créer un fichier temporaire pour les logs
    local log_file="/tmp/test-run-$(date +%s).log"
    
    # Fonction pour timeout compatible macOS/Linux
    run_with_timeout() {
        local timeout_duration=$1
        shift
        
        if command -v gtimeout &> /dev/null; then
            # macOS avec coreutils installé
            gtimeout "$timeout_duration" "$@"
        elif command -v timeout &> /dev/null; then
            # Linux
            timeout "$timeout_duration" "$@"
        else
            # Fallback pour macOS sans coreutils
            "$@" &
            local pid=$!
            (
                sleep "$timeout_duration"
                print_info "⏰ Test timeout reached (${timeout_duration}s), stopping..."
                kill -TERM "$pid" 2>/dev/null
                sleep 5
                kill -KILL "$pid" 2>/dev/null
            ) &
            wait "$pid" 2>/dev/null
        fi
    }
    
    # Lancer la commande run normale avec timeout
    local env_vars=""
    if [ "$debug_mode" = "true" ]; then
        env_vars="DEBUG=true"
    fi
    
    if run_with_timeout $((duration + 10)) \
        env $env_vars ./run_bot.sh run params.json > "$log_file" 2>&1; then
        print_success "✅ Test completed successfully"
    else
        print_info "ℹ️ Test stopped after timeout (this is expected)"
    fi
    
    # Analyser les logs
    print_info "📊 Analyzing test results..."
    
    # Afficher les lignes clés des logs
    print_info "🔍 Key system messages:"
    grep -E "Virtual display|PulseAudio|audio devices|ScreenRecorder|Screen recording|Application|Bot execution|Generated files" "$log_file" | head -10 || true
    
    # Compter les succès
    local success_count=0
    local total_tests=5
    
    # Test 1: Virtual display
    if grep -q "Virtual display started" "$log_file"; then
        print_success "✅ Virtual display working"
        ((success_count++))
    else
        print_warning "⚠️ Virtual display may have issues"
    fi
    
    # Test 2: PulseAudio
    if grep -q "PulseAudio started" "$log_file"; then
        print_success "✅ PulseAudio working"
        ((success_count++))
    else
        print_warning "⚠️ PulseAudio may have issues"
    fi
    
    # Test 3: Virtual audio devices
    if grep -q "Virtual audio devices created" "$log_file"; then
        print_success "✅ Audio devices created"
        ((success_count++))
    else
        print_warning "⚠️ Audio devices may have issues"
    fi
    
    # Test 4: Application started
    if grep -q "Starting application\|Running in serverless mode\|Running on http" "$log_file"; then
        print_success "✅ Application started"
        ((success_count++))
    else
        print_warning "⚠️ Application may not have started"
    fi
    
    # Test 5: Configuration parsed
    if ! grep -q "Failed to parse JSON from stdin" "$log_file"; then
        print_success "✅ Configuration parsed successfully"
        ((success_count++))
    else
        print_warning "⚠️ Configuration parsing failed"
    fi
    
    # Vérifier les fichiers générés
    local output_dir="./recordings"
    if [ -d "$output_dir" ] && [ "$(find $output_dir -name "*.mp4" -o -name "*.wav" | wc -l)" -gt 0 ]; then
        print_success "✅ Recording files were generated"
        print_info "Generated files:"
        find "$output_dir" -name "*.mp4" -o -name "*.wav" | head -5
    else
        print_info "ℹ️ No recording files (normal for short test)"
    fi
    
    # Compter les erreurs critiques
    local critical_errors=$(grep -i "error\|Error\|ERROR" "$log_file" | \
        grep -v "Console logger\|redis url\|Failed to parse JSON\|info.*error\|redis.*undefined" | wc -l | tr -d ' ')
    
    if [ "$critical_errors" -eq 0 ]; then
        print_success "✅ No critical errors detected"
    else
        print_warning "⚠️ $critical_errors critical error(s) found:"
        grep -i "error\|Error\|ERROR" "$log_file" | \
            grep -v "Console logger\|redis url\|Failed to parse JSON\|info.*error\|redis.*undefined" | head -3 || true
    fi
    
    # Résumé final
    local success_rate=$((success_count * 100 / total_tests))
    print_success "🎯 Test completed for screen recording"
    print_info "Duration: ${duration}s"
    print_info "Success rate: $success_count/$total_tests tests passed ($success_rate%)"
    print_info "Critical errors: $critical_errors"
    print_info "Full log available at: $log_file"
    
    if [ "$success_rate" -ge 80 ] && [ "$critical_errors" -eq 0 ]; then
        print_success "🎉 Test passed! Screen recording system is working correctly"
        return 0
    elif [ "$success_rate" -ge 60 ]; then
        print_warning "⚠️ Test passed with warnings. System mostly working."
        return 0
    else
        print_error "❌ Test failed. Multiple issues detected."
        print_info "Check the full log for details: $log_file"
        return 1
    fi
}

# Test API request stop functionality
test_api_request() {
    print_info "🧪 Testing API request stop functionality"
    print_info "🛑 Will send API stop request after 2 minutes"
    
    # Check if Docker is available
    check_docker
    
    # Check if bot.config.json exists
    if [ ! -f "bot.config.json" ]; then
        print_error "bot.config.json not found!"
        print_info "Please create bot.config.json with your meeting configuration"
        return 1
    fi
    
    # Build image if necessary
    if ! docker images | grep -q "$(get_docker_image | cut -d: -f1)"; then
        print_info "Docker image not found, building..."
        build_image
    fi
    
    local output_dir=$(create_output_dir)
    local config_json=$(cat "bot.config.json")
    local processed_config=$(process_config "$config_json")
    
    # Extract bot_uuid for API call
    local bot_uuid
    if command -v jq &> /dev/null; then
        bot_uuid=$(echo "$processed_config" | jq -r '.bot_uuid // empty')
    fi
    
    if [ -z "$bot_uuid" ]; then
        print_error "Could not extract bot_uuid from configuration"
        return 1
    fi
    
    # Get available ports for this bot instance
    local port_info
    port_info=$(get_next_bot_ports)
    if [ $? -ne 0 ]; then
        print_error "Failed to allocate ports for bot instance"
        return 1
    fi
    
    local main_port=$(echo $port_info | cut -d' ' -f1)
    local vnc_port=$(echo $port_info | cut -d' ' -f2)
    
    # Store allocated ports globally for cleanup
    export ALLOCATED_MAIN_PORT="$main_port"
    export ALLOCATED_VNC_PORT="$vnc_port"
    
    print_info "🤖 Bot UUID: ${bot_uuid:0:8}..."
    print_info "🚀 Starting bot..."
    print_info "📡 Bot API will be accessible on port $main_port"
    
    # Start the bot and capture logs
    local log_file="/tmp/api-test-$(date +%s).log"
    echo "$processed_config" | docker run -i \
        -p $main_port:8080 \
        -e RECORDING=true \
        -v "$(pwd)/$output_dir:/app/recordings" \
        "$(get_docker_image)" 2>&1 | tee "$log_file" &
    
    local docker_pid=$!
    
    # Wait 2 minutes before sending API stop request
    print_info "⏰ Waiting 2 minutes before sending API stop request..."
    sleep 120
    
    # Send API stop request
    print_info "🛑 Sending API stop request..."
    local api_response
    api_response=$(curl -s -X POST http://localhost:$main_port/stop_record \
        -H "Content-Type: application/json" \
        -d "{\"bot_id\": \"$bot_uuid\"}")
    
    print_info "📡 API Response: $api_response"
    
    # Wait for cleanup to complete (up to 5 minutes)
    print_info "⏳ Waiting for cleanup to complete (up to 5 minutes)..."
    local cleanup_timeout=300
    local cleanup_start=$(date +%s)
    
    while [ $(($(date +%s) - cleanup_start)) -lt $cleanup_timeout ]; do
        if ! kill -0 $docker_pid 2>/dev/null; then
            print_success "✅ Bot stopped successfully"
            break
        fi
        sleep 5
    done
    
    # Check if process is still running
    if kill -0 $docker_pid 2>/dev/null; then
        print_warning "⚠️ Bot still running after 5 minutes - merge/trim might still be in progress"
        print_info "📊 Checking logs for merge progress..."
        
        # Show recent logs
        print_info "🔍 Recent logs:"
        tail -20 "$log_file" | while IFS= read -r line; do
            if [[ $line == *"ScreenRecorder"* ]] || [[ $line == *"merge"* ]] || [[ $line == *"trim"* ]] || [[ $line == *"cleanup"* ]]; then
                echo "  $line"
            fi
        done
        
        # Force stop after showing logs
        print_info "🧹 Force stopping bot..."
        kill -9 $docker_pid 2>/dev/null
    else
        print_success "✅ Bot stopped within expected time"
    fi
    
    # Analyze results
    print_info "📊 Analyzing test results..."
    
    # Check for merge/trim logs
    if grep -q "Efficient sync and merge completed successfully" "$log_file"; then
        print_success "✅ ScreenRecorder merge/trim completed successfully"
    else
        print_warning "⚠️ No merge/trim completion log found"
    fi
    
    # Check for cleanup logs
    if grep -q "Cleanup completed successfully" "$log_file"; then
        print_success "✅ Cleanup completed successfully"
    else
        print_warning "⚠️ No cleanup completion log found"
    fi
    
    # Check for API request handling
    if grep -q "end meeting from api server" "$log_file"; then
        print_success "✅ API request received and handled"
    else
        print_warning "⚠️ No API request handling log found"
    fi
    
    # Check for generated files
    local bot_files_dir="$output_dir/$bot_uuid"
    if [ -d "$bot_files_dir" ] && [ "$(find "$bot_files_dir" -name "*.mp4" -o -name "*.wav" | wc -l)" -gt 0 ]; then
        print_success "✅ Recording files were generated"
    elif [ -d "$output_dir" ] && [ "$(find "$output_dir" -name "*.mp4" -o -name "*.wav" | wc -l)" -gt 0 ]; then
        print_success "✅ Recording files were generated"
    else
        print_info "ℹ️ No recording files (normal for short test)"
    fi
    
    print_success "🎯 API request test completed"
    
    # Show useful paths for the user
    if [ -n "$bot_uuid" ]; then
        echo -e "\n${GREEN} ✅ done, check out your recording and metadata for bot UUID in $bot_uuid${NC}"
        echo
        echo "./recordings/$bot_uuid/output.mp4"
        echo "./recordings/$bot_uuid/"  # folder for metadata and all files
    fi
    
    print_info "Full log available at: $log_file"
    
    # Cleanup
    rm -f "$log_file"
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
    echo "  $0 test [duration]           - Test screen recording system (duration in seconds)"
    echo "  $0 test-api-request              - Test API request stop functionality (2 minutes)"
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
    echo "  $0 run params.json"
    echo "  $0 debug params.json                            # Debug mode: speakers logs + VNC"
    echo "  $0 run params.json 'https://meet.google.com/new-meeting-url'"
    echo "  $0 debug params.json 'https://meet.google.com/new-url'  # Debug with URL override"
    echo "  RECORDING=false $0 run params.json  # Run without video recording"
    echo "  RECORDING=false $0 debug params.json  # Debug without video recording"
    echo "  DEBUG=true $0 run params.json       # Run with VNC debug access only"
    echo "  DEBUG_LOGS=true $0 run params.json  # Run with speakers debug logs only"
    echo "  $0 run-json '{\"meeting_url\":\"https://meet.google.com/abc-def-ghi\", \"bot_name\":\"RecordingBot\"}'"
    echo "  RECORDING=false $0 run-json '{...}'  # Run JSON config without recording"
    echo "  DEBUG=true $0 run-json '{...}'      # Run JSON config with VNC debug"
    echo "  $0 test 60  # Test screen recording for 60 seconds"
    echo "  DEBUG=true $0 test 60              # Test with VNC debug access"
    echo "  $0 test-api-request     # Test API request stop after 2 minutes"
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
    echo "  • Test recording system with different modes"
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
        "test")
            test_recording "${2:-30}"
            ;;
        "test-api-request")
            test_api_request
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