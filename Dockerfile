# Meeting Bot - Docker Image for Screen Recording
FROM ubuntu:24.04

# Install Node.js 20.x
RUN apt-get update && apt-get install -y curl ca-certificates gnupg
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
RUN apt-get install -y nodejs

# Install system dependencies
RUN apt-get update && \
    apt-get --allow-downgrades --no-install-recommends -y install \
    # Core browser dependencies
    libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libasound2t64 libatspi2.0-0 libgtk-3-0 libxss1 libxtst6 libxshmfence1 \
    # Virtual display and audio
    xvfb x11vnc x11-utils pulseaudio pulseaudio-utils unclutter \
    # Media processing
    ffmpeg \
    # System monitoring
    sysstat procps \
    # Fonts for rendering / fingerprint realism. crosextra = metric-compatible
    # Windows clones (Carlito=Calibri, Caladea=Cambria) so a Windows-spoofed UA
    # also exposes those font names on enumeration.
    fonts-liberation fonts-dejavu-core \
    fonts-freefont-ttf fonts-noto-color-emoji fonts-ipafont-gothic fonts-wqy-zenhei \
    fonts-crosextra-carlito fonts-crosextra-caladea fontconfig \
    # Utilities
    wget curl unzip \
    && rm -rf /var/lib/apt/lists/*

# Install AWS CLI v2
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
    && unzip awscliv2.zip && ./aws/install && rm -rf awscliv2.zip aws

# Application setup
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Teams (and any non-Meet) use official Playwright Chromium via
# /usr/bin/google-chrome; Meet uses CloakBrowser's own stealth Chromium fork
# (baked below). Both are installed so browser.ts can pick per provider.
RUN npx playwright install chromium && \
    find /root/.cache/ms-playwright -name chrome -type f -executable | head -1 | xargs -I {} ln -sf {} /usr/bin/google-chrome
# CloakBrowser (Meet): pin the cache dir + disable runtime auto-update so the
# baked binary is the one used; otherwise each ephemeral pod fetches ~200MB on
# first launch.
ENV CLOAKBROWSER_CACHE_DIR=/opt/cloakbrowser
ENV CLOAKBROWSER_AUTO_UPDATE=false
RUN npx cloakbrowser install

# Firefox shared-lib deps (gtk3, libX*, dbus, …) — REQUIRED: the stealthfox
# patched binary links against these. We deliberately do NOT run
# `playwright install firefox`: stealthfox is self-contained and loaded via
# executablePath, so Playwright's own bundled Firefox would be dead weight.
# (This retires the USE_FIREFOX stock-Firefox A/B path — stealthfox is the
# zoom default now.)
RUN npx playwright install-deps firefox

# stealthfox (invisible_playwright patched Firefox) — the USE_STEALTHFOX backend.
# Bake the SHA256-verified patched binary from its GitHub release so it's ready
# without a runtime fetch (~250MB). Copy just the fetch script first so this
# download layer caches across app-code changes. Inert unless USE_STEALTHFOX=true.
COPY scripts/fetch-stealthfox.sh /tmp/fetch-stealthfox.sh
RUN bash /tmp/fetch-stealthfox.sh -d /opt/stealthfox
ENV STEALTHFOX_BINARY_PATH=/opt/stealthfox/firefox-16/firefox

# Build application
COPY . .
# Build network interceptor bundle (must be before TypeScript compilation)
RUN npm run build:bundle
# Compile TypeScript
RUN npm run build
# Copy bundle directory to build output (TypeScript doesn't copy non-TS files)
RUN cp -r src/meeting/meet/network-interception/bundle build/src/meeting/meet/network-interception/

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
\n# Determine resolution from RESOLUTION env var (default: 720p)\n\
RESOLUTION=${RESOLUTION:-720}\n\
if [ "$RESOLUTION" = "1080" ]; then\n\
    X11_WIDTH=1920\n\
    X11_HEIGHT=1220\n\
    echo "📐 Using 1080p resolution: ${X11_WIDTH}x${X11_HEIGHT}"\n\
else\n\
    X11_WIDTH=1280\n\
    X11_HEIGHT=860\n\
    echo "📐 Using 720p resolution: ${X11_WIDTH}x${X11_HEIGHT}"\n\
fi\n\
\n# Start virtual display with enhanced cursor hiding\n\
Xvfb :99 -screen 0 ${X11_WIDTH}x${X11_HEIGHT}x24 -ac +extension GLX +render -noreset -nocursor -nolisten tcp &\n\
XVFB_PID=$!\n\
\n# Hide cursor completely at X11 level\n\
sleep 2\n\
unclutter -display :99 -idle 0 -root &\n\
\n# Start VNC server for debugging with cursor disabled\n\
x11vnc -display :99 -forever -passwd debug -listen 0.0.0.0 -rfbport 5900 \\\n    -shared -noxdamage -noxfixes -noscr -fixscreen 3 -bg -o /tmp/x11vnc.log \\\n    -nocursor -noxfixes -nomodtweak &\n\
VNC_PID=$!\n\
\n# Configure PulseAudio daemon before start: native 48 kHz matching the\n\
# ScreenRecorder's AUDIO_SAMPLE_RATE so FFmpeg does a passthrough (no\n\
# 44100->48000 non-integer resample that, combined with aresample=async=1,\n\
# warbles/clicks under capture jitter). Larger fragment count/size gives\n\
# PulseAudio headroom against xruns under x264 + Chromium load.\n\
mkdir -p /etc/pulse\n\
cat > /etc/pulse/daemon.conf <<'PULSECONF'\n\
default-sample-rate = 48000\n\
default-sample-format = s16le\n\
default-fragments = 8\n\
default-fragment-size-msec = 10\n\
resample-method = speex-float-3\n\
PULSECONF\n\
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
\n# Create virtual audio devices — rate=48000 so the monitor natively\n\
# delivers 48 kHz and matches AUDIO_SAMPLE_RATE in ScreenRecorder.ts.\n\
pactl load-module module-null-sink sink_name=virtual_speaker rate=48000 \\\n\
    sink_properties=device.description=Virtual_Speaker,device.class=sound\n\
pactl load-module module-virtual-source source_name=virtual_mic\n\
pactl set-default-sink virtual_speaker\n\
\n\
# Optimize audio quality and latency\n\
pactl set-sink-volume virtual_speaker 100%\n\
pactl set-sink-latency-offset virtual_speaker 0 2>/dev/null || true\n\
pactl set-source-latency-offset virtual_speaker.monitor 0 2>/dev/null || true\n\
\n\
# speex-float-3 balances quality and CPU (vs speex-float-10) — speech audio is\n\
# not perceptibly different and the lower CPU leaves headroom for x264 encoding.\n\
pactl set-sink-resample-method virtual_speaker speex-float-3 2>/dev/null || true\n\
\n# Verify critical audio device exists\n\
if ! pactl list sources short | grep -q "virtual_speaker.monitor"; then\n\
    echo "❌ virtual_speaker.monitor not found - audio setup failed"\n\
    exit 1\n\
fi\n\
\necho "✅ Virtual display and audio ready"\n\necho "🔍 VNC available at localhost:5900 (password: debug)"\n\n# Start application\ncd /app/\nnode build/src/main.js\n\n# Cleanup on exit\ntrap "kill $PULSE_PID $VNC_PID $XVFB_PID 2>/dev/null || true" EXIT\n' > /start.sh && chmod +x /start.sh

# Expose VNC port for debugging
EXPOSE 5900

ENTRYPOINT ["/start.sh"]
