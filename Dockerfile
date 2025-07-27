# Meeting Bot - Docker Image for Screen Recording
FROM ubuntu:24.04

# Install Node.js 20.x
RUN apt-get update && apt-get install -y curl ca-certificates gnupg
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
RUN apt-get install -y nodejs

# Install Rust and Cargo
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Install system dependencies
RUN apt-get update && apt-get install -y \
    # Core browser dependencies
    wget libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxrandr2 libgbm1 libxss1 libxshmfence1 \
    # Virtual display and audio
    xvfb x11vnc x11-utils pulseaudio pulseaudio-utils unclutter \
    # Media processing
    ffmpeg \
    # Build dependencies for Rust
    build-essential pkg-config libclang-dev \
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



# Environment configuration
ENV NODE_OPTIONS="--max-old-space-size=2048"
ENV SERVERLESS=true
ENV NODE_ENV=production
ENV DISPLAY=:99

# Create minimal startup script
RUN echo '#!/bin/bash\n\
set -e\n\
\n\
echo "🖥️ Starting virtual display..."\n\
export DISPLAY=:99\n\
\n\
# Start virtual display\n\
Xvfb :99 -screen 0 1280x880x24 -ac +extension GLX +render -noreset -nolisten tcp &\n\
XVFB_PID=$!\n\
sleep 2\n\
\n\
# Start VNC server\n\
unclutter -display :99 -idle 0 -root &\n\
x11vnc -display :99 -forever -passwd debug -listen 0.0.0.0 -rfbport 5900 -shared -bg -o /tmp/x11vnc.log -nocursor &\n\
VNC_PID=$!\n\
sleep 2\n\
\n\
echo "🔊 Starting PulseAudio..."\n\
pulseaudio --start --log-target=stderr --log-level=notice &\n\
PULSE_PID=$!\n\
sleep 3\n\
\n\
echo "🎤 Creating virtual audio devices..."\n\
pactl load-module module-null-sink sink_name=virtual_speaker sink_properties=device.description=Virtual_Speaker\n\
pactl load-module module-virtual-source source_name=virtual_mic\n\
pactl set-default-sink virtual_speaker\n\
\n\
echo "✅ Virtual display and audio ready"\n\
echo "📹 Fake camera will be provided by Chrome using test_logo.mjpeg"\n\
echo "🔍 VNC available at localhost:5900 (password: debug)"\n\
\n\
cd /app/\n\
node build/src/main.js\n\
\n\
# Cleanup on exit\ntrap "kill $PULSE_PID $VNC_PID $XVFB_PID 2>/dev/null || true" EXIT\n\
' > /start.sh && chmod +x /start.sh

# Expose VNC port for debugging
EXPOSE 5900

ENTRYPOINT ["/start.sh"]
