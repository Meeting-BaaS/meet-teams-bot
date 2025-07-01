{
  description = "Meet Teams Bot Development Environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/release-24.11";
    flake-utils.url = "github:numtide/flake-utils";
    playwright.url = "github:pietdevries94/playwright-web-flake/1.52.0";
    # Import the parent flake as an input to access shared configuration
    # We use an absolute path because this is a git submodule, and relative paths
    # don't work reliably when Nix copies sources to the store. The parent flake
    # exports shared-config which we can import without relative path issues.
    parent.url = "path:/home/lazrossi/code/BOT-CLEAN/meeting_bot";
  };

  outputs = { self, nixpkgs, flake-utils, playwright, parent }:
    flake-utils.lib.eachDefaultSystem (system:
        let
        overlay = final: prev: {
          inherit (playwright.packages.${system}) playwright-test playwright-driver;
        };
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ overlay ];
        };
        
        # Import shared configuration from parent flake
        # This avoids the git submodule + relative path problem by using the flake input system.
        # We use parent + "/shared-config.nix" to get the direct path to the file.
        shared = import (parent + "/shared-config.nix") { inherit pkgs; };
      in
      {
        devShells.default = pkgs.mkShell {
          name = "meet-teams-bot-dev";
          
          # Use shared build inputs plus TypeScript
          buildInputs = shared.commonBuildInputs ++ [ pkgs.nodePackages.typescript ];
          
          # Set environment variables for TypeScript and Jest
          env = {
            TYPESCRIPT_TYPES_ROOT = "${pkgs.nodePackages.typescript}/lib/node_modules/typescript/lib:${pkgs.nodePackages.typescript}/lib/node_modules/typescript/lib/@types";
            PLAYWRIGHT_TYPES = "${playwright.packages.${system}.playwright-test}/lib/node_modules/@playwright/test";
            NODE_PATH = "${pkgs.nodePackages.typescript}/lib/node_modules";
          };

          shellHook = ''
            ${shared.commonShellHook}
            
            # Set up shared virtual audio
            ${shared.setupVirtualAudio}
            
            # Set up shared virtual display
            ${shared.setupVirtualDisplay}

	    export RECORDING=true

            # Always run the custom install script to ensure all deps (including native/image) are handled
            #if [ -f ./install-server-deps.sh ]; then
            #    print_info "Running custom install-server-deps.sh for native/image deps..."
            #    bash ./install-server-deps.sh
            #    print_success "Custom install-server-deps.sh completed"
            #fi

            # Create a unique ID for this bot instance
            BOT_ID=$(date +%s)-$RANDOM
            export BOT_RUNTIME_DIR="/tmp/meet-teams-bot-$BOT_ID"
            export BOT_DISPLAY=$((${toString shared.config.display.number}))
            export BOT_CAMERA_NUM=${toString shared.config.cameras.default_num}  # Use the first virtual camera created by NixOS
            
            # Create isolated runtime directory for this bot instance
            mkdir -p "$BOT_RUNTIME_DIR"
            mkdir -p "$BOT_RUNTIME_DIR/x11"
            
            # Set up isolated environment variables
            export XAUTHORITY="$BOT_RUNTIME_DIR/x11/xauthority"
            export DISPLAY=":$BOT_DISPLAY"
            export SERVERLESS=false
            export NODE_ENV=${shared.config.app.node_env}
            
            # Ensure we use the system PulseAudio, not custom paths
            unset PULSE_SERVER
            unset PULSE_RUNTIME_PATH
            unset XDG_RUNTIME_DIR
            
            # Set correct PulseAudio environment for user session
            export XDG_RUNTIME_DIR="/run/user/${toString shared.config.user_id}"
            export PULSE_SERVER="${shared.config.pulse.server}"
            
            # Ensure virtual audio devices are active and set correct defaults for recording
            print_info "Configuring virtual audio for bot instance..."
            
            # Set virtual_speaker.monitor as the default source for recording
            pactl set-default-source ${shared.config.audio.speaker_sink}.monitor 2>/dev/null || true
            
            # Set PulseAudio environment variables for Node.js processes
            export PULSE_SERVER="${shared.config.pulse.server}"
            export PULSE_RUNTIME_PATH="${shared.config.pulse.runtime_path}"
            export PULSE_COOKIE="${shared.config.pulse.cookie}"
            
            # Verify the source is active
            source_status=$(pactl list sources short 2>/dev/null | grep "${shared.config.audio.speaker_sink}.monitor" | awk '{print $5}')
            if [ "$source_status" = "RUNNING" ] || [ "$source_status" = "IDLE" ]; then
                print_success "${shared.config.audio.speaker_sink}.monitor source is active and ready for recording"
            else
                print_warning "${shared.config.audio.speaker_sink}.monitor source status: $source_status - trying to wake it up..."
                # Try to wake up the source by playing audio to the sink
                timeout 2 speaker-test -D ${shared.config.audio.speaker_sink} -c 2 -t sine -f 1000 >/dev/null 2>&1 || true
                sleep 1
                
                # Check status again
                source_status=$(pactl list sources short 2>/dev/null | grep "${shared.config.audio.speaker_sink}.monitor" | awk '{print $5}')
                if [ "$source_status" = "RUNNING" ] || [ "$source_status" = "IDLE" ]; then
                    print_success "${shared.config.audio.speaker_sink}.monitor source is now active"
                else
                    print_error "Failed to wake up ${shared.config.audio.speaker_sink}.monitor source - status: $source_status"
                fi
            fi

            # Use existing virtual camera (created by NixOS)
            print_info "Setting up virtual camera..."
            
            # Check for existing virtual cameras
            camera_found=false
            ${pkgs.lib.concatStringsSep "\n" (map (num: ''
            if [ "$camera_found" = "false" ] && [ -e "/dev/video${toString num}" ]; then
                export BOT_CAMERA_NUM=${toString num}
                print_success "Using existing virtual camera at /dev/video$BOT_CAMERA_NUM"
                camera_found=true
            fi'') (pkgs.lib.range shared.config.cameras.start_num shared.config.cameras.end_num))}
            
            if [ "$camera_found" = "false" ]; then
                print_warning "No existing virtual cameras found - trying to create new one"
                
                # Try to create a new virtual camera
                if ! lsmod | grep -q v4l2loopback; then
                    print_info "Loading v4l2loopback module..."
                    modprobe v4l2loopback devices=1 video_nr=$BOT_CAMERA_NUM max_buffers=2 exclusive_caps=1 card_label="Default WebCam" 2>/dev/null
                    if [ $? -ne 0 ]; then
                        print_warning "Failed to load v4l2loopback module - trying with sudo"
                        sudo modprobe v4l2loopback devices=1 video_nr=$BOT_CAMERA_NUM max_buffers=2 exclusive_caps=1 card_label="Default WebCam" 2>/dev/null || true
                    fi
                fi
                
                # Try to find an available video device
                for i in {${toString shared.config.cameras.start_num}..99}; do
                    if [ ! -e "/dev/video$i" ]; then
                        print_info "Trying to create camera at /dev/video$i"
                        modprobe v4l2loopback devices=1 video_nr=$i max_buffers=2 exclusive_caps=1 card_label="Default WebCam" 2>/dev/null || true
                        if [ -e "/dev/video$i" ]; then
                            export BOT_CAMERA_NUM=$i
                            print_success "Virtual camera created at /dev/video$BOT_CAMERA_NUM"
                            break
                        fi
                    fi
                done
                
                if [ ! -e "/dev/video$BOT_CAMERA_NUM" ]; then
                    print_error "Failed to create virtual camera - check v4l2loopback module and permissions"
                fi
            fi

            # Print environment information
            print_bot "Bot instance $BOT_ID ready"
            echo "  Display: :$BOT_DISPLAY"
            echo "  Camera: /dev/video$BOT_CAMERA_NUM"
            echo "  Runtime: $BOT_RUNTIME_DIR"
            echo "  Mode: Redis (non-serverless)"
            echo ""
            echo "=== Development Environment ==="
            echo "Node version: $(node --version)"
            echo "NPM version: $(npm --version)"
            echo "TypeScript version: $(tsc --version)"
            echo "VIPS version: $(vips --version)"
            echo "GLib version: $(pkg-config --modversion glib-2.0)"
            echo ""
            echo "TypeScript type definitions:"
            echo "  TypeScript lib: ${pkgs.nodePackages.typescript}/lib/node_modules/typescript/lib"
            echo "  Local types: $PWD/node_modules/@types"
            echo "  Playwright types: $PLAYWRIGHT_TYPES"
            echo ""
            echo "Sharp build environment:"
            echo "  Using system libvips: $(pkg-config --modversion vips)"
            echo "  Build from source: true"
            echo "  Force install: true"
            echo ""
            echo "Playwright configuration:"
            echo "  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: $PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"
            echo "  PLAYWRIGHT_BROWSERS_PATH: $PLAYWRIGHT_BROWSERS_PATH"
            echo "  PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: $PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS"
            echo ""
            
            ${shared.reportStatus}
            
            echo ""
            echo "To install dependencies, run: ./install-deps.sh"
            echo "============================"
            
            # Function to launch multiple bot instances
            launch-bots() {
                local count="''${1:-1}"
                local prefix="''${2:-Bot}"
                
                print_info "Launching $count bot instance(s) with prefix '$prefix'"
                
                for i in $(seq 1 $count); do
                    local bot_name="$prefix-$i"
                    print_info "Starting $bot_name..."
                    
                    # Create logs directory for this instance first
                    local log_dir="logs/$bot_name-$(date +%s)"
                    mkdir -p "$log_dir"
                    
                    # Create a new independent process for this bot instance
                    (
                        # Set up per-instance environment
                        export BOT_INSTANCE_NAME="$bot_name"
                        export BOT_INSTANCE_NUM="$i"
                        export BOT_LOG_DIR="$log_dir"
                        
                        # Use a different camera for each instance
                        case $i in
                            ${pkgs.lib.concatStringsSep "\n                            " (map (num: "${toString num}) export BOT_CAMERA_NUM=${toString num} ;;") (pkgs.lib.range shared.config.cameras.start_num shared.config.cameras.end_num))}
                            *) export BOT_CAMERA_NUM=$((${toString shared.config.cameras.start_num} + $i - 1)) ;;
                        esac
                        
                        # Verify camera is available for this instance
                        if [ -e "/dev/video$BOT_CAMERA_NUM" ]; then
                            print_success "Camera /dev/video$BOT_CAMERA_NUM available for $bot_name"
                        else
                            print_warning "Camera /dev/video$BOT_CAMERA_NUM not available for $bot_name"
                        fi
                        
                        # Log instance startup
                        echo "$(date): $bot_name instance started" >> "$log_dir/instance.log"
                        echo "  Camera: /dev/video$BOT_CAMERA_NUM" >> "$log_dir/instance.log"
                        echo "  Log directory: $log_dir" >> "$log_dir/instance.log"
                        echo "  Parent PID: $$" >> "$log_dir/instance.log"
                        
                        # Keep this process alive and independent
                        print_success "$bot_name instance ready (logs: $log_dir)"
                        print_info "$bot_name is now running independently"
                        
                        # Set up cleanup trap
                        trap 'echo "$(date): $bot_name instance stopped" >> "$log_dir/instance.log"; exit 0' TERM INT
                        
                        # Keep the process alive
                        while true; do
                            sleep 10
                            # Just keep the process alive - no branding management
                        done
                    ) > "$log_dir/process.log" 2>&1 &
                    
                    local bot_pid=$!
                    echo "$(date): $bot_name launched with PID $bot_pid" >> "logs/bot_pids.log"
                    
                    sleep 1
                done
                
                print_success "Launched $count bot instance(s)"
                print_info "Bot instances are now running independently"
                print_info "Use 'list-bots' to see running instances"
                print_info "Use 'stop-bots' to stop all instances"
            }
            
            # Function to stop all bot instances
            stop-bots() {
                print_info "Stopping all bot instances..."
                
                # Stop bot instance processes
                if [ -f "logs/bot_pids.log" ]; then
                    while read -r line; do
                        if [[ $line =~ launched\ with\ PID\ ([0-9]+) ]]; then
                            local pid="''${BASH_REMATCH[1]}"
                            if kill -0 "$pid" 2>/dev/null; then
                                print_info "Stopping bot process PID $pid"
                                kill "$pid" 2>/dev/null || true
                            fi
                        fi
                    done < "logs/bot_pids.log"
                fi
                
                # Clean up PID log
                rm -f "logs/bot_pids.log"
                
                print_success "All bot instances stopped"
            }
            
            # Function to list running bot instances
            list-bots() {
                print_info "Running bot instances:"
                
                # Check PID log
                if [ -f "logs/bot_pids.log" ]; then
                    while read -r line; do
                        if [[ $line =~ launched\ with\ PID\ ([0-9]+) ]]; then
                            local pid="''${BASH_REMATCH[1]}"
                            if kill -0 "$pid" 2>/dev/null; then
                                echo "  PID $pid: Running"
                            else
                                echo "  PID $pid: Stopped"
                            fi
                        fi
                    done < "logs/bot_pids.log"
                else
                    echo "  No bot instances found"
                fi
                

                
                # Show recent log directories
                print_info "Recent log directories:"
                if [ -d "logs" ]; then
                    find logs -maxdepth 1 -type d -name "*Bot*" -printf "  %p\n" | head -5
                else
                    echo "  No logs directory found"
                fi
            }
            
            # Function to view bot logs
            view-logs() {
                local bot_name="''${1:-all}"
                
                if [ "$bot_name" = "all" ]; then
                    print_info "Available bot logs:"
                    if [ -d "logs" ]; then
                        for log_dir in logs/*; do
                            if [ -d "$log_dir" ]; then
                                echo "  $log_dir"
                                if [ -f "$log_dir/instance.log" ]; then
                                    echo "    Instance log: $(tail -1 "$log_dir/instance.log" 2>/dev/null || echo "No log data")"
                                fi
                            fi
                        done
                    else
                        echo "  No logs directory found"
                    fi
                else
                    local log_dir="logs/$bot_name-*"
                    if ls $log_dir >/dev/null 2>&1; then
                        local latest_log=$(ls -td $log_dir | head -1)
                        print_info "Latest logs for $bot_name:"
                        echo "  Log directory: $latest_log"
                        echo ""
                        if [ -f "$latest_log/instance.log" ]; then
                            echo "=== Instance Log ==="
                            cat "$latest_log/instance.log"
                            echo ""
                        fi
                    else
                        print_warning "No logs found for $bot_name"
                    fi
                fi
            }
            
            # Function to follow logs in real-time
            follow-logs() {
                local bot_name="''${1:-all}"
                
                if [ "$bot_name" = "all" ]; then
                    print_info "Following all bot logs (Ctrl+C to stop)..."
                    if [ -d "logs" ]; then
                        tail -f logs/*/instance.log 2>/dev/null || true
                    else
                        echo "No logs to follow"
                    fi
                else
                    local log_dir="logs/$bot_name-*"
                    if ls $log_dir >/dev/null 2>&1; then
                        local latest_log=$(ls -td $log_dir | head -1)
                        print_info "Following logs for $bot_name (Ctrl+C to stop)..."
                        tail -f "$latest_log"/instance.log 2>/dev/null || true
                    else
                        print_warning "No logs found for $bot_name"
                    fi
                fi
            }
            
            # Function to clean old logs
            clean-logs() {
                local days="''${1:-7}"
                print_info "Cleaning logs older than $days days..."
                find logs -type d -mtime +$days -exec rm -rf {} \; 2>/dev/null || true
                print_success "Old logs cleaned"
            }
            
            echo ""
            echo "Camera management functions:"
            echo "  launch-bots [count] [prefix]  - Prepare multiple camera instances"
            echo "  list-bots                     - List running camera instances"
            echo "  stop-bots                     - Stop all camera instances"
            echo "  view-logs [bot_name]            - View camera instance logs"
            echo "  follow-logs [bot_name]          - Follow camera instance logs in real-time"
            echo "  clean-logs [days]               - Clean old logs"
            echo ""
            echo "Examples:"
            echo "  launch-bots 2 MeetingBot      - Prepare 2 camera instances named MeetingBot-1, MeetingBot-2"
            echo "  launch-bots 4                 - Prepare 4 camera instances named Bot-1, Bot-2, Bot-3, Bot-4"
            echo "  view-logs                     - View all available camera instance logs"
            echo "  view-logs MeetingBot-1        - View logs for specific camera instance"
            echo "  follow-logs MeetingBot-1      - Follow logs for specific camera instance in real-time"
            echo "  follow-logs                   - Follow all camera instance logs in real-time"
            echo "  clean-logs 3                  - Clean logs older than 3 days"
          '';
        };
      });
} 
