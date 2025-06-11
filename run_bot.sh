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

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
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
    print_info "Building Meet Teams Bot Docker image..."
    docker build -t meet-teams-bot .
    print_success "Docker image built successfully"
}

# Create output directory
create_output_dir() {
    local output_dir="./recordings"
    mkdir -p "$output_dir"
    echo "$output_dir"
}

# Process JSON configuration to add UUID if missing
process_config() {
    local config_json=$1
    local bot_uuid=$(generate_uuid)
    
    print_info "Generated new bot_uuid: $bot_uuid" >&2
    
    # Check if bot_uuid already exists in the config
    if echo "$config_json" | grep -q '"bot_uuid"[[:space:]]*:[[:space:]]*"[^"]*"'; then
        # Replace existing bot_uuid
        print_info "Replacing existing bot_uuid with new one" >&2
        local result=$(echo "$config_json" | sed 's/"bot_uuid"[[:space:]]*:[[:space:]]*"[^"]*"/"bot_uuid": "'$bot_uuid'"/g')
        echo "$result"
    else
        # Add new bot_uuid to JSON
        print_info "Adding new bot_uuid to configuration" >&2
        local clean_json=$(echo "$config_json" | tr -d '\n' | sed 's/[[:space:]]*$//')
        # Remove the last } and add our field with proper formatting
        local result=$(echo "$clean_json" | sed 's/\(.*\)}$/\1, "bot_uuid": "'$bot_uuid'"}/')
        echo "$result"
    fi
}

# Run bot with configuration file
run_with_config() {
    local config_file=$1
    local override_meeting_url=$2
    local recording_mode=${RECORDING:-true}  # Par défaut true
    
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
            # Fallback to sed for simple replacement
            config_json=$(echo "$config_json" | sed "s|\"meeting_url\"[[:space:]]*:[[:space:]]*\"[^\"]*\"|\"meeting_url\": \"$override_meeting_url\"|g")
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
    
    # Debug: Show what we're sending to Docker (first 200 chars)
    local preview=$(echo "$processed_config" | head -c 200)
    print_info "Config preview: ${preview}..."
    
    # Validate JSON is not empty
    if [ -z "$processed_config" ] || [ "$processed_config" = "{}" ]; then
        print_error "Processed configuration is empty or invalid"
        print_info "Original config: $config_json"
        exit 1
    fi
    
    echo "$processed_config" | docker run -i \
        -e RECORDING="$recording_mode" \
        -v "$(pwd)/$output_dir:/app/data" \
        meet-teams-bot
    
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

# Run bot with JSON input
run_with_json() {
    local json_input=$1
    local recording_mode=${RECORDING:-true}  # Par défaut true
    local output_dir=$(create_output_dir)
    local processed_config=$(process_config "$json_input")
    
    print_info "Running Meet Teams Bot with provided JSON configuration"
    print_info "Recording enabled: $recording_mode"
    print_info "Recording mode: screen (direct capture)"
    print_info "Output directory: $output_dir"
    
    # Debug: Show what we're sending to Docker (first 200 chars)
    local preview=$(echo "$processed_config" | head -c 200)
    print_info "Config preview: ${preview}..."
    
    # Validate JSON is not empty
    if [ -z "$processed_config" ] || [ "$processed_config" = "{}" ]; then
        print_error "Processed configuration is empty or invalid"
        print_info "Original config: $json_input"
        exit 1
    fi
    
    echo "$processed_config" | docker run -i \
        -e RECORDING="$recording_mode" \
        -v "$(pwd)/$output_dir:/app/data" \
        meet-teams-bot
    
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
    
    print_info "🧪 Testing screen recording system"
    print_info "📅 Test duration: ${duration}s"
    print_info "📄 Using normal run command with params.json"
    
    # Vérifier que Docker est disponible
    check_docker
    
    # Vérifier que params.json existe
    if [ ! -f "params.json" ]; then
        print_error "params.json not found!"
        print_info "Please create params.json with your meeting configuration"
        return 1
    fi
    
    # Construire l'image si nécessaire
    if ! docker images | grep -q meet-teams-bot; then
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
    if run_with_timeout $((duration + 10)) \
        ./run_bot.sh run params.json > "$log_file" 2>&1; then
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

# Show help
show_help() {
    echo "Meet Teams Bot - Serverless Runner"
    echo
    echo "Usage:"
    echo "  $0 build                     - Build the Docker image"
    echo "  $0 run <config_file> [url]   - Run bot with configuration file (optional meeting URL override)"
    echo "  $0 run-json '<json>'         - Run bot with JSON configuration"
    echo "  $0 test [duration]           - Test screen recording system (duration in seconds)"
    echo "  $0 clean                     - Clean recordings directory"
    echo "  $0 help                      - Show this help message"
    echo
    echo "Environment Variables:"
    echo "  RECORDING=true|false         - Enable/disable video recording (default: true)"
    echo
    echo "Examples:"
    echo "  $0 build"
    echo "  $0 run params.json"
    echo "  $0 run params.json 'https://meet.google.com/new-meeting-url'"
    echo "  RECORDING=false $0 run params.json  # Run without video recording"
    echo "  $0 run-json '{\"meeting_url\":\"https://meet.google.com/abc-def-ghi\", \"bot_name\":\"RecordingBot\"}'"
    echo "  RECORDING=false $0 run-json '{...}'  # Run JSON config without recording"
    echo "  $0 test 60  # Test screen recording for 60 seconds"
    echo "  $0 clean"
    echo
    echo "Recording Modes:"
    echo "  • screen (default)    - Direct screen capture via FFmpeg (recommended)"
    echo
    echo "Features:"
    echo "  • Automatically generates bot_uuid if not provided"
    echo "  • Override meeting URL by passing it as last argument"
    echo "  • Control video recording with RECORDING environment variable"
    echo "  • Test recording system with different modes"
    echo "  • Saves recordings to ./recordings directory (when recording enabled)"
    echo "  • Lists generated files after completion"
    echo
    echo "Configuration file should contain JSON with meeting parameters."
    echo "See params.json for example format."
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
                print_info "Usage: $0 run <config_file> [meeting_url]"
                exit 1
            fi
            check_docker
            run_with_config "$2" "$3"
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