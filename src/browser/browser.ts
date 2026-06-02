import { type BrowserContext, chromium } from "@playwright/test"
import { envVars } from "../config/env-vars"
import { formatError } from "../utils/Logger"

export async function openBrowser(proxyUrl?: string | null): Promise<{ browser: BrowserContext }> {
  // Resolution configuration from environment variable
  // Defaults to 720p if RESOLUTION is not set or invalid
  const resolution = envVars.RESOLUTION
  const { width, height } =
    resolution === "1080" ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }

  // Window size must match Xvfb display size (includes browser UI ~140px)
  // Xvfb is 1280x860 for 720p or 1920x1220 for 1080p
  const windowWidth = width
  const windowHeight = resolution === "1080" ? 1220 : 860

  try {
    console.log("Launching persistent context with exact extension args...")

    // Get Chrome path from environment variable or use default
    const chromePath = envVars.CHROME_PATH
    console.log(`🔍 Using Chrome path: ${chromePath}`)

    const context = await chromium.launchPersistentContext("", {
      headless: false,
      viewport: { width, height },
      executablePath: chromePath,
      locale: "en-US", // Set locale for Playwright context
      args: [
        // Window size and position - must match Xvfb display exactly
        `--window-size=${windowWidth},${windowHeight}`,
        "--window-position=0,0",

        // ========================================
        // CLOAKBROWSER STEALTH (only honoured by the CloakBrowser binary)
        // ========================================
        // The binary is stealthy with zero flags — it auto-generates a coherent
        // random fingerprint seed at startup (canvas, WebGL, audio, GPU, screen).
        // We only force the platform: a Linux binary reports Linux+NVIDIA by
        // default; present as a Windows desktop instead — the most common
        // fingerprint, harder to cluster, and what real Meet attendees look like.
        // NOTE: deliberately NOT spoofing the WebRTC ICE IP — meeting capture uses
        // WebRTC for media, so rewriting the ICE candidate could break recording.
        // On stock Chromium these flags are ignored (no-ops), so this stays safe
        // if CHROME_PATH ever points back at plain chromium.
        "--fingerprint-platform=windows",

        // Disable per-frame canvas/WebGL/audio noise injection. That noise is the
        // expensive part of CloakBrowser (hooks every fingerprint read) and on a
        // CPU-capped pod it saturates cores -> throttling -> delayed UI + jittery
        // video. Google Meet doesn't canvas-fingerprint the bot the way
        // Cloudflare/FingerprintJS do, so we keep the cheap, high-value spoofs
        // (platform/UA/webdriver/GPU/hardware) and drop the costly noise. Per
        // CloakBrowser docs this also *prevents* FPJS tampering detection.
        "--fingerprint-noise=false",

        // Disable the GPU/WebGL/compositing path. CloakBrowser strips
        // --enable-unsafe-swiftshader and injects --ignore-gpu-blocklist in headed
        // mode (browser.py:991) to force WebGL onto SwiftShader for a realistic GPU
        // fingerprint. On a GPU-less node (Xvfb / k8s pod) that runs GPU work in a
        // CPU rasterizer — the dominant cost (~1.3 cores/bot in-call, measured) and
        // the cause of throttling on a 4-core cap (jittery video, delayed UI).
        // Meet doesn't fingerprint the WebGL renderer, so forcing software
        // compositing here is safe and far cheaper.
        "--disable-gpu",

        // Security configurations
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--lang=en-US", // Force English language with region code
        "--accept-lang=en-US,en", // Accept English for HTTP requests

        // ========================================
        // AUDIO CONFIGURATION FOR PULSEAUDIO
        // ========================================
        "--use-pulseaudio", // Force Chromium to use PulseAudio
        "--enable-audio-service-sandbox=false", // Disable audio service sandbox for virtual devices
        "--audio-buffer-size=2048", // Set buffer size for better audio handling
        "--disable-features=AudioServiceSandbox", // Additional sandbox disable
        "--autoplay-policy=no-user-gesture-required", // Allow autoplay for meeting platforms

        // WebRTC optimizations (required for meeting audio/video capture)
        "--disable-rtc-smoothness-algorithm",
        "--disable-webrtc-hw-decoding",
        "--disable-webrtc-hw-encoding",
        "--enable-webrtc-capture-audio", // Ensure WebRTC can capture audio
        "--force-webrtc-ip-handling-policy=default", // Better WebRTC handling

        // Performance and resource management optimizations
        "--disable-blink-features=AutomationControlled",
        "--disable-background-timer-throttling",
        "--enable-features=SharedArrayBuffer",
        "--memory-pressure-off", // Disable memory pressure handling for consistent performance
        "--max_old_space_size=4096", // Increase V8 heap size to 4GB for large meetings
        "--disable-background-networking", // Reduce background network activity
        "--disable-features=TranslateUI", // Disable translation features to save resources
        "--disable-features=AutofillServerCommunication", // Disable autofill to reduce network usage
        "--disable-component-extensions-with-background-pages", // Reduce background extension overhead
        "--disable-default-apps", // Disable default Chrome apps
        "--renderer-process-limit=4", // Limit renderer processes to prevent resource exhaustion
        "--disable-ipc-flooding-protection", // Improve IPC performance for high-frequency operations
        "--aggressive-cache-discard", // Enable aggressive cache management for memory efficiency
        "--disable-features=MediaRouter", // Disable media router for reduced overhead

        // Certificate and security optimizations for meeting platforms
        "--ignore-certificate-errors",
        "--allow-insecure-localhost",
        "--disable-blink-features=TrustedDOMTypes",
        "--disable-features=TrustedScriptTypes",
        "--disable-features=TrustedHTML",

        // Additional audio debugging (remove in production)
        "--enable-logging=stderr",
        "--log-level=1",
        "--vmodule=*audio*=3", // Enable audio debug logging

        // Proxy configuration (added dynamically if proxy is active)
        ...(proxyUrl ? [`--proxy-server=${proxyUrl}`] : [])
      ],
      permissions: ["microphone", "camera"],
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
      bypassCSP: true,
      timeout: 120000
    })

    console.log("✅ Chromium launched with PulseAudio configuration")
    return { browser: context }
  } catch (error) {
    console.error("Failed to open browser:", formatError(error))
    throw error
  }
}
