#!/bin/bash
# ===================================================================
# This is the entrypoint for the Meet/Teams bot container.
# It sets up the virtual displays and audio devices for the pod,
# and starts the bot process.
# ===================================================================

set -e

# Create initial logs.txt file and redirect all output to it
touch $HOME/logs.txt
exec 1> >(tee -a $HOME/logs.txt)
exec 2> >(tee -a $HOME/logs.txt >&2)

echo "🖥️ Starting Meet/Teams bot container..."

# Verify pod UID environment variable is present
echo "🔍 Verifying pod UID configuration..."
if [ -z "$POD_UID" ]; then
    echo "❌ POD_UID is not set"
    exit 1
fi
echo "  ✅ POD_UID: $POD_UID"

# Setting dynamic ENV variables based on the pod UID
# Static variables are exposed by Kubernetes
# Generate a predictable "ordinal" from UID for compatibility
# Using UID hash modulo for smaller, more manageable display numbers
export POD_ORDINAL=$(( $(echo "$POD_UID" | cksum | cut -d' ' -f1) % 1000 ))

# Use POD_UID for device naming to ensure uniqueness across deployments
export VIRTUAL_SPEAKER="virtual_speaker_${POD_UID}"
export VIRTUAL_SPEAKER_MONITOR="virtual_speaker_${POD_UID}.monitor"
export VIRTUAL_MIC="virtual_mic_${POD_UID}"
export VIRTUAL_MIC_SOURCE="virtual_mic_source_${POD_UID}"

# Use generated POD_ORDINAL for numeric devices
export DISPLAY=":$((99 + $POD_ORDINAL))"
# VIDEO_DEVICE will be set from environment variable

# Set PulseAudio sink and source to the virtual devices
export PULSE_SINK=$VIRTUAL_SPEAKER
export PULSE_SOURCE=$VIRTUAL_MIC_SOURCE

echo "🎯 Pod (UID: $POD_UID, Ordinal: $POD_ORDINAL) using:"
echo "  - Display: $DISPLAY (will be checked for conflicts)"
echo "  - Video: $VIDEO_DEVICE"
echo "  - Audio Mic: $VIRTUAL_MIC"
echo "  - Audio Speaker: $VIRTUAL_SPEAKER"
echo "  - Audio Mic Source: $VIRTUAL_MIC_SOURCE"
echo "  - Environment: $ENVIRON"
echo "  - Node Name: $NODE_NAME"

# ===================================================================
# Section 1: Setup PulseAudio (Pure Pod Approach)
# ===================================================================
echo "🎵 Setting up PulseAudio for this pod..."

# Set PulseAudio runtime directory
export PULSE_RUNTIME_PATH=/root/.config/pulse
export XDG_RUNTIME_DIR=/root/.config/pulse

# Create PulseAudio runtime directory
mkdir -p $PULSE_RUNTIME_PATH

# Start PulseAudio daemon for this pod
echo "🎤 Starting PulseAudio daemon..."
pkill pulseaudio 2>/dev/null || true
sleep 2

if ! pulseaudio --daemonize --exit-idle-time=-1 --log-level=info --log-target=stderr --system=false --disallow-exit --no-cpu-limit; then
    echo "❌ Failed to start PulseAudio"
    exit 1
fi

# Wait for PulseAudio to be ready
echo "⏳ Waiting for PulseAudio to be ready..."
wait_for_pulseaudio() {
    local max_attempts=30
    local attempt=0
    
    while [ $attempt -lt $max_attempts ]; do
        if pulseaudio --check 2>/dev/null; then
            echo "  ✅ PulseAudio is ready"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
    
    echo "❌ PulseAudio failed to start within $max_attempts seconds"
    return 1
}

if ! wait_for_pulseaudio; then
    echo "❌ PulseAudio is not responding"
    exit 1
fi

# ===================================================================
# Section 2: Create Virtual Audio Devices (Pure Pod Approach)
# ===================================================================
echo "🎤 Creating virtual audio devices for this pod..."

# Create virtual microphone sink
if ! pactl list sinks short | grep -q "^[0-9]*[[:space:]]*${VIRTUAL_MIC}[[:space:]]"; then
    echo "🎤 Creating virtual microphone sink..."
    pactl load-module module-null-sink sink_name=$VIRTUAL_MIC rate=48000 sink_properties=device.description="Virtual_Mic_${POD_UID}" 2>/dev/null
    if [ $? -eq 0 ]; then
        echo "  ✅ Virtual microphone sink created"
    else
        echo "  ❌ Failed to create virtual microphone sink"
        exit 1
    fi
else
    echo "  ✅ Virtual microphone sink already exists"
fi

# Create virtual microphone source
if ! pactl list sources short | grep -q "^[0-9]*[[:space:]]*${VIRTUAL_MIC_SOURCE}[[:space:]]"; then
    echo "🎤 Creating virtual microphone source..."
    pactl load-module module-virtual-source source_name=$VIRTUAL_MIC_SOURCE master=$VIRTUAL_MIC.monitor source_properties=device.description="Virtual_Mic_Source_${POD_UID}" 2>/dev/null
    if [ $? -eq 0 ]; then
        echo "  ✅ Virtual microphone source created"
    else
        echo "  ❌ Failed to create virtual microphone source"
        exit 1
    fi
else
    echo "  ✅ Virtual microphone source already exists"
fi

# Create virtual speaker sink
if ! pactl list sinks short | grep -q "^[0-9]*[[:space:]]*${VIRTUAL_SPEAKER}[[:space:]]"; then
    echo "🔊 Creating virtual speaker sink..."
    pactl load-module module-null-sink sink_name=$VIRTUAL_SPEAKER rate=48000 sink_properties=device.description="Virtual_Speaker_${POD_UID}" 2>/dev/null
    if [ $? -eq 0 ]; then
        echo "  ✅ Virtual speaker sink created"
    else
        echo "  ❌ Failed to create virtual speaker sink"
        exit 1
    fi
else
    echo "  ✅ Virtual speaker sink already exists"
fi

# Route browser audio to the monitored sink. Chrome resolves its audio output via
# the PulseAudio *server* default sink; with no default set, PulseAudio picks it
# non-deterministically (often the first-loaded null-sink, virtual_mic), so the
# browser's audio can land off virtual_speaker and FFmpeg records silence from
# virtual_speaker.monitor. Setting the default explicitly (belt-and-suspenders with
# PULSE_SINK) keeps capture reliable. Matches start.local.sh / the standalone image.
if pactl set-default-sink $VIRTUAL_SPEAKER 2>/dev/null; then
    echo "  ✅ Default sink set to $VIRTUAL_SPEAKER"
else
    echo "  ⚠️ Failed to set default sink to $VIRTUAL_SPEAKER"
fi

# ===================================================================
# Section 3: Setup Virtual Display (Pure Pod Approach)
# ===================================================================
echo "🖥️ Setting up virtual display for this pod..."

# Function to find available display number
find_available_display() {
    local base_display=$1
    local max_attempts=50
    local attempt=0
    local current_display=$base_display
    
    while [ $attempt -lt $max_attempts ]; do
        # Check if display socket exists
        if [ ! -S "/tmp/.X11-unix/X${current_display#:}" ]; then
            echo "  ✅ Found available display: $current_display" >&2
            echo "$current_display"
            return 0
        fi
        
        # Generate random display number between 99 and 999 (smaller range)
        current_display=":$((99 + RANDOM % 900))"
        attempt=$((attempt + 1))
        echo "  🔄 Attempt $attempt: Display $base_display in use, trying $current_display..." >&2
    done
    
    echo "  ❌ Could not find available display after $max_attempts attempts" >&2
    return 1
}

# Find available display
echo "🔍 Checking for available display number..."
AVAILABLE_DISPLAY=$(find_available_display "$DISPLAY")

if [ $? -eq 0 ]; then
    export DISPLAY=$AVAILABLE_DISPLAY
    echo "🎯 Using display: $DISPLAY"
else
    echo "❌ Failed to find available display"
    exit 1
fi

# Start virtual display server
echo "🖥️ Starting virtual display server with Xvfb on display $DISPLAY..."
# Create X11 directory if it doesn't exist
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

# Determine resolution from RESOLUTION env var (default: 720p)
#
# TWO SIZES, DELIBERATELY DIFFERENT.
#
#   X11_* is the virtual MONITOR. It must be a resolution a real monitor has
#         ever shipped at, because the page reads it as screen.width/height and
#         CloakBrowser does not spoof it — its own source says "Screen and
#         window size come from the real display, not this flag". We used to
#         size the display to the browser window (1280x860 / 1920x1220). No
#         display has ever been 1280x860. One property read, and the Windows
#         persona is gone.
#
#   WINDOW_* is the browser window, unchanged. The recorder grabs
#         WINDOW_W x WINDOW_H from (0,0) and crops the top 140px of browser
#         chrome, so as long as the window stays at --window-position=0,0 the
#         captured pixels are byte-identical to before. The display is simply
#         larger than the window now, which is what a normal desktop looks like.
RESOLUTION=${RESOLUTION:-720}
if [ "$RESOLUTION" = "1080" ]; then
    WINDOW_WIDTH=1920
    WINDOW_HEIGHT=1220
    # 1920x1220 has to fit inside the monitor; 2560x1440 is the common one that does.
    X11_WIDTH=2560
    X11_HEIGHT=1440
    echo "📐 Using 1080p: window ${WINDOW_WIDTH}x${WINDOW_HEIGHT} on a ${X11_WIDTH}x${X11_HEIGHT} display"
else
    WINDOW_WIDTH=1280
    WINDOW_HEIGHT=860
    X11_WIDTH=1920
    X11_HEIGHT=1080
    echo "📐 Using 720p: window ${WINDOW_WIDTH}x${WINDOW_HEIGHT} on a ${X11_WIDTH}x${X11_HEIGHT} display"
fi

Xvfb $DISPLAY -screen 0 ${X11_WIDTH}x${X11_HEIGHT}x24 -ac +extension GLX +render -noreset -nocursor -nolisten tcp &
XVFB_PID=$!

# Wait for display server to be ready
echo "⏳ Waiting for virtual display to initialize..."
wait_for_xvfb() {
    local max_attempts=30
    local attempt=0
    
    while [ $attempt -lt $max_attempts ]; do
        # Check if Xvfb process is still running
        if ! kill -0 "$XVFB_PID" 2>/dev/null; then
            echo "  ❌ Xvfb process died"
            return 1
        fi
        
        # Check if display socket exists
        if [ -S "/tmp/.X11-unix/X${DISPLAY#:}" ]; then
            echo "  ✅ X11 display socket found"
            return 0
        fi
        
        attempt=$((attempt + 1))
        sleep 1
    done
    
    echo "  ❌ Xvfb failed to start within $max_attempts seconds"
    return 1
}

if ! wait_for_xvfb; then
    echo "❌ Failed to start Xvfb on display $DISPLAY"
    exit 1
fi

echo "  ✅ Virtual display server started successfully"

# Start unclutter to hide cursor
echo "🖱️ Starting unclutter to hide cursor..."
unclutter -display $DISPLAY -idle 0 -root >/dev/null 2>&1 &

# ===================================================================
# Debug: Print PulseAudio sinks and sources to verify they are running
# ===================================================================
echo "🔍 Debug: Checking PulseAudio sinks and sources..."
echo "📊 Available sinks:"
pactl list sinks short 2>/dev/null || echo "  ❌ Failed to list sinks"
echo "📊 Available sources:"
pactl list sources short 2>/dev/null || echo "  ❌ Failed to list sources"
echo "📊 Available modules:"
pactl list modules short 2>/dev/null | grep -E "(virtual|null)" || echo "  ❌ No virtual modules found"

# ===================================================================
# Test: Verify virtual microphone is working with ffmpeg
# ===================================================================
echo "🎤 Testing virtual microphone functionality..."

# Test 1: Verify virtual microphone sink exists and is accessible
echo "🔊 Testing virtual microphone sink accessibility..."
if ! ffmpeg -f lavfi -i "sine=frequency=1000:duration=1" -f pulse "pulse:${VIRTUAL_MIC}" -t 1 -f null - 2>/dev/null; then
    echo "  ❌ Virtual microphone sink test failed - sink may not be accessible"
    echo "  ❌ This is critical for bot functionality - exiting"
    exit 1
fi
echo "  ✅ Virtual microphone sink is accessible"

# ===================================================================
# Section 4: Start SQS consumer (which will launch bots) with signal handling
# ===================================================================
echo "🤖 Starting SQS consumer (will launch Meet/Teams bots on demand)..."

# Set up signal handling for graceful shutdown
cleanup() {
    echo "🛑 Received termination signal, starting cleanup..."
    
    # Cleanup PulseAudio virtual devices
    echo "🎵 Cleaning up PulseAudio virtual devices..."
    if pulseaudio --check 2>/dev/null; then
        # Find and unload our specific virtual devices
        echo "  🎤 Unloading virtual microphone source: $VIRTUAL_MIC_SOURCE"
        pactl unload-module $(pactl list modules short | grep "$VIRTUAL_MIC_SOURCE" | awk '{print $1}') 2>/dev/null || true
        
        echo "  🎤 Unloading virtual microphone sink: $VIRTUAL_MIC"
        pactl unload-module $(pactl list modules short | grep "$VIRTUAL_MIC" | awk '{print $1}') 2>/dev/null || true
        
        echo "  🔊 Unloading virtual speaker sink: $VIRTUAL_SPEAKER"
        pactl unload-module $(pactl list modules short | grep "$VIRTUAL_SPEAKER" | awk '{print $1}') 2>/dev/null || true
        
        echo "  ✅ PulseAudio virtual devices cleaned up"
    fi
    
    # Kill Xvfb process if it's running
    if [ -n "$XVFB_PID" ] && kill -0 "$XVFB_PID" 2>/dev/null; then
        echo "🖥️ Stopping virtual display server..."
        kill -TERM "$XVFB_PID" 2>/dev/null
    fi
    
    # Forward the signal to the orchestrator and give it time to finish or stop the bot it
    # is running: leaving right away would kill in-flight bot work with the container.
    # The wait is bounded (SHUTDOWN_GRACE_SECONDS, default 25) and must stay below the
    # pod's terminationGracePeriodSeconds, or Kubernetes SIGKILLs everything anyway.
    if [ -n "$SQS_CONSUMER_PID" ] && kill -0 "$SQS_CONSUMER_PID" 2>/dev/null; then
        echo "🛑 Forwarding signal to SQS consumer process (PID: $SQS_CONSUMER_PID)..."
        kill -TERM "$SQS_CONSUMER_PID" 2>/dev/null
        grace="${SHUTDOWN_GRACE_SECONDS:-25}"
        waited=0
        while kill -0 "$SQS_CONSUMER_PID" 2>/dev/null && [ "$waited" -lt "$grace" ]; do
            sleep 1
            waited=$((waited + 1))
        done
        if kill -0 "$SQS_CONSUMER_PID" 2>/dev/null; then
            echo "⚠️ SQS consumer still running after ${grace}s, exiting anyway"
        else
            echo "✅ SQS consumer exited after ${waited}s"
        fi
    fi
    
    echo "✅ Cleanup completed"
    exit 0
}

# Set up signal handlers
trap cleanup TERM INT

# Per-process CPU/memory profiler, always on; its failures never stop the pod
PROFILER_JS=/app/apps/meet-teams-bot/build/profiler/metric-collector.js
if [ -f "$PROFILER_JS" ]; then
    ( node "$PROFILER_JS" </dev/null || echo "📊 Profiler stopped" >&2 ) &
    echo "📊 Profiler started (pid $!, every ${PROFILER_INTERVAL_MS:-10000}ms)"
else
    echo "⚠️ Profiler skipped: $PROFILER_JS not found" >&2
fi

# Start SQS consumer in background and capture PID
# The orchestrator is the @meeting-baas/sqs-consumer package installed in /app/bots-runtime
# (see deploy/bots-runtime/package.json); it spawns the voice-router sidecar from the same install.
cd /app/bots-runtime
echo "🚀 Launching SQS consumer..."
node node_modules/@meeting-baas/sqs-consumer/dist/app.js &
SQS_CONSUMER_PID=$!

# Wait for SQS consumer to exit
wait "$SQS_CONSUMER_PID"
SQS_CONSUMER_EXIT_CODE=$?

echo "🤖 SQS consumer process exited with code: $SQS_CONSUMER_EXIT_CODE"

# Final cleanup before exit
echo "🧹 Performing final cleanup..."

# Cleanup PulseAudio virtual devices
if pulseaudio --check 2>/dev/null; then
    echo "🎵 Cleaning up PulseAudio virtual devices..."
    pactl unload-module $(pactl list modules short | grep "$VIRTUAL_MIC_SOURCE" | awk '{print $1}') 2>/dev/null || true
    pactl unload-module $(pactl list modules short | grep "$VIRTUAL_MIC" | awk '{print $1}') 2>/dev/null || true
    pactl unload-module $(pactl list modules short | grep "$VIRTUAL_SPEAKER" | awk '{print $1}') 2>/dev/null || true
fi

# Kill Xvfb process if it's still running
if [ -n "$XVFB_PID" ] && kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "🖥️ Stopping virtual display server..."
    kill -TERM "$XVFB_PID" 2>/dev/null
fi

sleep 2
exit $SQS_CONSUMER_EXIT_CODE

