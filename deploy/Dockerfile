# ========================================
# MEET/TEAMS BOT IMAGE - MULTI-STAGE BUILD
# ========================================
# The image the cloud runs (web-based-bots-v2): this bot plus the @meeting-baas/sqs-consumer
# orchestrator from GitHub Packages. Build context is this repository's root:
#   docker buildx build -f deploy/Dockerfile --secret id=npm_token,env=NPM_TOKEN .
# The open-source serverless image is ./Dockerfile; this one is what .ci/ and the
# monorepo release build. Paths inside the image (/app/apps/meet-teams-bot,
# /app/bots-runtime, /app/apps/silence.opus) are what the orchestrator expects.

# Build arguments for platform support
ARG TARGETPLATFORM=linux/amd64
ARG BUILDPLATFORM=linux/amd64
ARG TARGETARCH=amd64

# Where the baked stealthfox Firefox comes from. Defaults to the prod registry,
# which every environment can read (the namespace is public — an unauthenticated
# local `docker build` resolves it via the registry's anonymous token flow), so
# prod, preprod and local all work with no override and no docker login.
# Preprod may point at its own copy to keep pulls in-namespace:
#   --build-arg STEALTHFOX_IMAGE=rg.fr-par.scw.cloud/baas-bots-preprod/stealthfox:firefox-16
ARG STEALTHFOX_IMAGE=rg.fr-par.scw.cloud/meeting-baas-prod-bots/stealthfox:firefox-16

# ========================================
# STAGE 0: STEALTHFOX BINARY
# ========================================
# Pinned to linux/amd64 because the patched Firefox is an x86-64 ELF and no other
# build exists — without this an arm64 host (Apple Silicon) fails to resolve the
# manifest. The binary is inert unless USE_STEALTHFOX=true, so an amd64 payload
# in an arm64 local image is harmless.
FROM --platform=linux/amd64 ${STEALTHFOX_IMAGE} AS stealthfox

# ========================================
# STAGE 1: DEPENDENCIES (meet-teams-bot)
# ========================================
FROM --platform=$BUILDPLATFORM node:22.16.0-slim AS deps

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

WORKDIR /app/apps/meet-teams-bot
COPY package.json pnpm-lock.yaml .npmrc ./

# The bot imports the bare `playwright` package (ScreenRecorder.ts, SyncSignal.ts) but
# only declares `@playwright/test`, which pulls playwright in transitively. The serverless
# image is built with npm (flat node_modules) where that resolves; pnpm's strict layout
# does not. Hoist playwright to the top level so tsc can resolve it (lockfile unchanged).
# engine-strict pins node <=24 for npm users; this image builds and runs on node 22.
RUN sed -i '/engine-strict/d' .npmrc \
    && printf 'public-hoist-pattern[]=playwright\npublic-hoist-pattern[]=playwright-core\n' >> .npmrc

RUN pnpm install --frozen-lockfile

# ========================================
# STAGE 2: BUILDER (meet-teams-bot)
# ========================================
FROM --platform=$BUILDPLATFORM node:22.16.0-slim AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

COPY . ./apps/meet-teams-bot/
COPY --from=deps /app/apps/meet-teams-bot/node_modules ./apps/meet-teams-bot/node_modules
COPY --from=deps /app/apps/meet-teams-bot/.npmrc ./apps/meet-teams-bot/.npmrc

WORKDIR /app/apps/meet-teams-bot
# Build network interceptor bundle (must be before TypeScript compilation)
RUN pnpm run build:bundle
# Compile TypeScript
RUN pnpm build
# Copy bundle directory to build output (TypeScript doesn't copy non-TS files)
RUN cp -r src/meeting/meet/network-interception/bundle build/src/meeting/meet/network-interception/
# CPU/memory profiler (bot #338): compiled to JS because the runtime image has no tsx
RUN ./node_modules/typescript/bin/tsc profiler/metric-collector.ts --outDir build/profiler \
    --target es2022 --module commonjs --types node --skipLibCheck
WORKDIR /app

# ========================================
# STAGE 3: RUNTIME
# ========================================
FROM --platform=$TARGETPLATFORM debian:13-slim AS runtime

# Set architecture-specific variables
ARG TARGETARCH
ENV TARGETARCH=${TARGETARCH}

# Install runtime dependencies
RUN apt-get update && \
    apt-get upgrade --yes && \
    apt-get --allow-downgrades --no-install-recommends --yes install \
    # Browser runtime dependencies
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2t64 \
    libatspi2.0-0 \
    libgtk-3-0 \
    libxss1 \
    libxtst6 \
    libxshmfence1 \
    # FFmpeg for video/audio processing
    ffmpeg \
    # System monitoring
    sysstat \
    procps \
    # PulseAudio
    pulseaudio pulseaudio-utils \
    # Fonts for rendering / fingerprint realism. The noto-emoji/freefont/unifont/
    # ipafont/wqy/tlwg set is CloakBrowser's recommended anti-bot canvas/emoji set
    # (it hashes emoji rendered on a hidden canvas — minimal Linux images fail it);
    # Liberation + Carlito + Caladea cover the Windows core families (Arial/Times/
    # Courier/Calibri/Cambria).
    #
    # These are also the SOURCE faces for the Windows-name clone step further
    # down. The note that used to sit here said Windows font enumeration was not
    # satisfied and that real Windows fonts were deliberately not shipped
    # (proprietary). Still true — we ship no Microsoft files. What changed is
    # that the gap now costs joins: Meet's flag rate went 22% -> 50% and
    # CloakBrowser warns "Incomplete Windows font set" on every launch. The clone
    # step closes it with OPEN faces re-emitted under the Windows names, so
    # nothing proprietary enters the image. See that script for the trade-off it
    # does NOT solve (advance-width comparison against real Windows metrics).
    fonts-liberation \
    fonts-crosextra-carlito \
    fonts-crosextra-caladea \
    fonts-dejavu-core \
    fonts-freefont-ttf \
    fonts-unifont \
    fonts-tlwg-loma-otf \
    fonts-noto-color-emoji \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    # X11 dependencies for headed browser mode
    xvfb \
    x11-utils \
    unclutter \
    # Node.js
    curl \
    wget \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22.x
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs

# ---- Windows core fonts, cloned from open faces -----------------------------
#
# The image claims Windows in its UA. A real Windows Chrome exposes Segoe UI,
# Tahoma, Consolas and the rest, and any page can enumerate them from JS by
# measuring text width against a generic fallback. We exposed 5 of 20.
# CloakBrowser warns about precisely this at every launch, and it is the
# MIXED-OS-TELL the fingerprint probe reports.
#
# Fontconfig aliases do NOT fix it. `fc-match "Segoe UI"` will happily report a
# substitute while Chromium's canvas still measures the font as absent —
# measured both ways. Only a real file carrying the family name works, which is
# what the script emits: an open face with its name table rewritten. No
# Microsoft files enter the image.
#
# The extra source faces are installed tolerantly. The set was verified on
# ubuntu:24.04 (the dev image's base); this stage is debian:13-slim and a name
# could differ, so a missing package must not fail the build. The script then
# refuses to clone from a family that is not installed and prints a WARNING
# naming every Windows font it could not produce — a partial set still beats
# none, and the log says exactly what is missing.
ARG WIN_FONT_SOURCES="fonts-open-sans fonts-cantarell fonts-lato fonts-comic-neue fonts-cascadia-code fonts-liberation-sans-narrow fonts-noto-core"
COPY scripts/make-windows-metric-clones.py /tmp/make-windows-metric-clones.py
RUN apt-get update \
    && (apt-get install -y --no-install-recommends $WIN_FONT_SOURCES \
        || for p in $WIN_FONT_SOURCES; do \
             apt-get install -y --no-install-recommends "$p" \
               || echo "[win-fonts] source package unavailable on this base: $p"; \
           done) \
    && apt-get install -y --no-install-recommends python3-fonttools fontconfig \
    && python3 /tmp/make-windows-metric-clones.py \
    && apt-get purge -y python3-fonttools \
    && rm -f /tmp/make-windows-metric-clones.py \
    && rm -rf /var/lib/apt/lists/*


# Update CA certificates and install kubectl (architecture-specific)
RUN update-ca-certificates && \
    ARCH=$(echo "$TARGETARCH" | sed 's/amd64/amd64/;s/arm64/arm64/') && \
    curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/${ARCH}/kubectl" && \
    chmod +x kubectl && \
    mv kubectl /usr/local/bin/

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

# Set working directory
WORKDIR /app

# Production dependencies of the bot
COPY package.json pnpm-lock.yaml ./apps/meet-teams-bot/
COPY --from=deps /app/apps/meet-teams-bot/.npmrc ./apps/meet-teams-bot/.npmrc
RUN cd apps/meet-teams-bot && pnpm install --frozen-lockfile --prod

# The orchestrator (@meeting-baas/sqs-consumer, which brings the voice-router sidecar)
# comes from GitHub Packages; deploy/bots-runtime/ pins it. NPM_TOKEN: a PAT with
# read:packages locally, the run's GITHUB_TOKEN in CI, mounted as a BuildKit secret.
COPY deploy/bots-runtime/.npmrc deploy/bots-runtime/package.json deploy/bots-runtime/pnpm-lock.yaml ./bots-runtime/
RUN --mount=type=secret,id=npm_token \
    cd bots-runtime && NPM_TOKEN="$(cat /run/secrets/npm_token)" pnpm install --frozen-lockfile --prod --ignore-workspace

# Copy pre-built meet-teams-bot from builder (path matches bot-launcher expectations: /app/apps/meet-teams-bot/build/src/main.js)
COPY --from=builder /app/apps/meet-teams-bot/build/ ./apps/meet-teams-bot/build/
COPY --from=builder /app/apps/meet-teams-bot/package*.json ./apps/meet-teams-bot/

# (Teams no longer needs a separate Google Chrome install — it uses CloakBrowser's
# stealth Chromium, baked below, the same as Meet.)

# Install CloakBrowser for Meet (stealth Chromium fork, baked to avoid per-pod download)
WORKDIR /app/apps/meet-teams-bot
RUN pnpm exec playwright install-deps chromium
ENV CLOAKBROWSER_CACHE_DIR=/opt/cloakbrowser
ENV CLOAKBROWSER_AUTO_UPDATE=false
# Free stealth-Chromium binary (no license). This produces a clean fingerprint
# (probe verdict=ok, no CDP leak, webdriver=false) at $0 — the paid Pro/148 binary
# is deliberately NOT used.
RUN pnpm exec cloakbrowser install

# stealthfox (invisible_playwright patched Firefox) — the USE_STEALTHFOX backend.
# Install Firefox's shared-lib deps, then bake in the patched binary so pods never
# fetch ~250MB at runtime. Inert unless USE_STEALTHFOX=true.
#
# Sourced from our own registry, NOT upstream: the author's GitHub account
# (feder-cr) was deleted, taking firefox_antidetect_patch, invisible_playwright
# and every release asset with it — the old fetch-stealthfox.sh download 404s and
# there is no mirror. This image was built by extracting /opt/stealthfox from
# web-based-bots-v2:2026-07-31-v2.4.2, the last image built before upstream
# vanished. It is the only surviving copy, so do not prune the tag.
#
# firefox binary sha256: 0efaf629fc4ecdf7ccd3f79a62fcd465c4a4c9701039a4cbfcab321e29e90e1a
# The source image is the STEALTHFOX_IMAGE build-arg declared at the top.
RUN pnpm exec playwright install-deps firefox
COPY --from=stealthfox /opt/stealthfox /opt/stealthfox
ENV STEALTHFOX_BINARY_PATH=/opt/stealthfox/firefox-16/firefox

WORKDIR /app

# Copy branding files and scripts
# The bot runs with cwd=/app/apps/meet-teams-bot/, so "../generate_custom_branding.sh" resolves to /app/apps/generate_custom_branding.sh
# The script does "cd .." so it will work from /app/apps/meet-teams-bot/ and create files in /app/apps/
COPY deploy/generate_custom_branding.sh ./apps/generate_custom_branding.sh
RUN chmod +x ./apps/generate_custom_branding.sh

# Pre-generate a black placeholder MJPEG with the same specs as real branding output.
# This is streamed to v4l2 immediately at startup so Google Meet sees a working camera
# before the real branding images finish downloading/converting.
RUN ffmpeg -y -f lavfi -i "color=c=black:s=1280x720:r=30:d=1" \
    -c:v mjpeg -q:v 5 -pix_fmt yuvj420p -strict -1 \
    -color_primaries bt709 -color_trc bt709 -color_range tv \
    ./apps/camera_warmup.mjpeg

# Copy audio files (used by media_context.ts)
# The bot runs with cwd=/app/apps/meet-teams-bot/, so "../silence.opus" resolves to /app/apps/silence.opus
COPY deploy/silence.opus ./apps/silence.opus

# Copy start script (WORKDIR is already /app)
COPY deploy/start.sh /start.sh
RUN chmod +x /start.sh

# Set the entrypoint to start.sh
CMD ["/start.sh"]
