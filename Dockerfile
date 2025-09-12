# Meeting Bot - Docker Image for Screen Recording
FROM ubuntu:24.04

# Install Node.js 20.x
RUN apt-get update && apt-get install -y curl ca-certificates gnupg
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
RUN apt-get install -y nodejs

# Install system dependencies
RUN apt-get update && apt-get install -y \
    # Core browser dependencies
    wget libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxrandr2 libgbm1 libxss1 libxshmfence1 \
    # Virtual display and audio
    xvfb x11vnc x11-utils pulseaudio pulseaudio-utils unclutter \
    # Media processing
    ffmpeg \
    # Utilities
    curl unzip \
    && rm -rf /var/lib/apt/lists/*

# Install AWS CLI v2
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
    && unzip awscliv2.zip && ./aws/install && rm -rf awscliv2.zip aws

# Application setup
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Install Playwright's Chromium + create symlink for browser.ts compatibility
RUN npx playwright install chromium && \
    find /root/.cache/ms-playwright -name chrome -type f -executable | head -1 | xargs -I {} ln -sf {} /usr/bin/google-chrome

# Build application
COPY . .
RUN npm run build

# Make branding scripts executable
RUN chmod +x generate_branding.sh generate_custom_branding.sh

# Environment configuration
ENV NODE_OPTIONS="--max-old-space-size=2048"
ENV SERVERLESS=true
ENV NODE_ENV=production
ENV DISPLAY=:99
ENV PULSE_RUNTIME_PATH=/tmp/pulse
ENV XDG_RUNTIME_DIR=/tmp/pulse

# Create optimized startup script
RUN echo '#!/bin/bash\n\
set -e\n\
\necho "🖥️ Starting virtual display and audio..."\n\
export DISPLAY=:99\n\
export PULSE_RUNTIME_PATH=/tmp/pulse\n\
export XDG_RUNTIME_DIR=/tmp/pulse\n\
mkdir -p $PULSE_RUNTIME_PATH\n\
\n# Start virtual display with enhanced cursor hiding\n\
Xvfb :99 -screen 0 1280x880x24 -ac +extension GLX +render -noreset -nocursor -nolisten tcp &\n\
XVFB_PID=$!\n\
\n# Hide cursor completely at X11 level\n\
sleep 2\n\
unclutter -display :99 -idle 0 -root &\n\
\n# Start VNC server for debugging with cursor disabled\n\
x11vnc -display :99 -forever -passwd debug -listen 0.0.0.0 -rfbport 5900 \\\n    -shared -noxdamage -noxfixes -noscr -fixscreen 3 -bg -o /tmp/x11vnc.log \\\n    -nocursor -noxfixes -nomodtweak &\n\
VNC_PID=$!\n\
\n# Initialize PulseAudio\n\
pulseaudio --start --log-target=stderr --log-level=notice &\n\
PULSE_PID=$!\n\
sleep 4\n\
\n# Ensure PulseAudio is ready\n\
if ! pactl info >/dev/null 2>&1; then\n\
    pulseaudio --kill || true\n\
    sleep 2\n\
    pulseaudio --start --log-target=stderr --log-level=notice &\n\
    PULSE_PID=$!\n\
    sleep 3\n\
fi\n\
\n# Create virtual audio devices\n\
pactl load-module module-null-sink sink_name=virtual_speaker \\\n\
    sink_properties=device.description=Virtual_Speaker,device.class=sound\n\
pactl load-module module-virtual-source source_name=virtual_mic\n\
pactl set-default-sink virtual_speaker\n\
\n\
# Optimize audio quality and latency\n\
pactl set-sink-volume virtual_speaker 100%\n\
pactl set-sink-latency-offset virtual_speaker 0 2>/dev/null || true\n\
pactl set-source-latency-offset virtual_speaker.monitor 0 2>/dev/null || true\n\
\n\
# Set high quality audio parameters\n\
pactl set-sink-resample-method virtual_speaker speex-float-10 2>/dev/null || true\n\
\n# Verify critical audio device exists\n\
if ! pactl list sources short | grep -q "virtual_speaker.monitor"; then\n\
    echo "❌ virtual_speaker.monitor not found - audio setup failed"\n\
    exit 1\n\
fi\n\
\necho "✅ Virtual display and audio ready"\n\necho "🔍 VNC available at localhost:5900 (password: debug)"\n\n# Start application\ncd /app/\nnode build/src/main.js\n\n# Cleanup on exit\ntrap "kill $PULSE_PID $VNC_PID $XVFB_PID 2>/dev/null || true" EXIT\n' > /start.sh && chmod +x /start.sh

# Expose VNC port for debugging
EXPOSE 5900

ENTRYPOINT ["/start.sh"]
