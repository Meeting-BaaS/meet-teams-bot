FROM node:18-bullseye

# Install system dependencies required for Playwright, Chrome extensions, Xvfb, FFmpeg, PulseAudio and AWS CLI
RUN apt-get update \
    && apt-get install -y \
        wget \
        gnupg \
        libnss3 \
        libatk-bridge2.0-0 \
        libdrm2 \
        libxkbcommon0 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libgbm1 \
        libxss1 \
        libasound2 \
        libxshmfence1 \
        xvfb \
        x11vnc \
        fluxbox \
        x11-utils \
        ffmpeg \
        curl \
        unzip \
        pulseaudio \
        pulseaudio-utils \
        pavucontrol \
        alsa-utils \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Optimize FFmpeg performance settings
ENV FFMPEG_THREAD_COUNT=0
ENV FFMPEG_PRESET=ultrafast

# Set CPU optimization flags
ENV NODE_OPTIONS="--max-old-space-size=2048"

# Configure PulseAudio for virtual audio
ENV PULSE_RUNTIME_PATH=/tmp/pulse
ENV XDG_RUNTIME_DIR=/tmp/pulse

# Install AWS CLI v2
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
    && unzip awscliv2.zip \
    && ./aws/install \
    && rm -rf awscliv2.zip aws/

# Create app directory
WORKDIR /app

# Copy dependency descriptors first for caching
COPY package.json package-lock.json ./
COPY chrome_extension/package.json chrome_extension/package-lock.json ./chrome_extension/

# Install dependencies for the server and the extension
RUN npm ci  \
    && npm ci --prefix chrome_extension

# Install Playwright browsers using the local version
RUN npx  playwright install --with-deps chromium

# Copy the rest of the application code
COPY . .

# Build the server and the Chrome extension
RUN npm run build  \
    && npm run build --prefix chrome_extension

# Verify extension build
RUN ls -la /app/chrome_extension/dist/ \
    && ls -la /app/chrome_extension/dist/js/

# Create startup script with audio support
RUN echo '#!/bin/bash\n\
echo "🖥️ Starting virtual display and audio..."\n\
export DISPLAY=:99\n\
export PULSE_RUNTIME_PATH=/tmp/pulse\n\
export XDG_RUNTIME_DIR=/tmp/pulse\n\
\n\
# Create pulse runtime directory\n\
mkdir -p $PULSE_RUNTIME_PATH\n\
\n\
# Start Xvfb\n\
Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset &\n\
XVFB_PID=$!\n\
echo "✅ Virtual display started (PID: $XVFB_PID)"\n\
\n\
# Start PulseAudio in system mode\n\
pulseaudio --system --disallow-exit --disallow-module-loading &\n\
PULSE_PID=$!\n\
echo "✅ PulseAudio started (PID: $PULSE_PID)"\n\
\n\
# Wait for display and audio to be ready\n\
sleep 3\n\
\n\
# Create a null audio sink for recording\n\
pactl load-module module-null-sink sink_name=virtual_speaker sink_properties=device.description=Virtual_Speaker\n\
\n\
# Create a virtual microphone source\n\
pactl load-module module-virtual-source source_name=virtual_mic\n\
\n\
echo "✅ Virtual audio devices created"\n\
\n\
echo "🚀 Starting application..."\n\
cd /app/\n\
node build/src/main.js\n\
\n\
# Cleanup\n\
kill $PULSE_PID 2>/dev/null || true\n\
kill $XVFB_PID 2>/dev/null || true\n\
' > /start.sh && chmod +x /start.sh

WORKDIR /app/

ENV SERVERLESS=true
ENV NODE_ENV=production
ENV DISPLAY=:99
ENV PULSE_RUNTIME_PATH=/tmp/pulse
ENV XDG_RUNTIME_DIR=/tmp/pulse

ENTRYPOINT ["/start.sh"]
