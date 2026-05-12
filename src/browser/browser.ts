import type { BrowserContext } from "@playwright/test"
// rebrowser-playwright is a drop-in for playwright/chromium with anti-detect
// patches applied (navigator.webdriver hidden, CDP runtime indicators removed,
// other Playwright tells stripped). We only swap the runtime entry point —
// types continue to come from @playwright/test so the rest of the codebase
// is untouched.
import { chromium } from "rebrowser-playwright"
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

        // Disable the Blink feature that exposes navigator.webdriver=true.
        // rebrowser-playwright DOES NOT remove --enable-automation from
        // Playwright's default args and DOES NOT patch navigator.webdriver
        // (verified in rebrowser-playwright-core@1.52: chromiumSwitches.js:87
        // still lists --enable-automation; no webdriver references in lib/).
        // Its main patch is hiding CDP Runtime.enable — a separate detection
        // surface. We still need this flag to keep navigator.webdriver hidden.
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

        // Audio debugging — dev-only. In prod these stderr fingerprints are a
        // bot tell that scoring scripts can probe for, so they're gated off
        // outside development.
        ...(envVars.NODE_ENV === "development"
          ? ["--enable-logging=stderr", "--log-level=1", "--vmodule=*audio*=3"]
          : []),

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
    // rebrowser-playwright pins to 1.52 while @playwright/test resolves to a
    // newer minor. The runtime BrowserContext is the same playwright-core
    // class — the cast through unknown is only because the two .d.ts trees
    // live in different node_modules paths and TS treats them as distinct.
    //
    // What this hides: any 1.56-only API we start calling against this
    // context will throw at runtime, not at compile time. When bumping
    // @playwright/test, check rebrowser-playwright's release tags
    // (https://github.com/rebrowser/rebrowser-patches) and bump rebrowser
    // to match, OR limit usage in this file to 1.52-era surface.
    return { browser: context as unknown as BrowserContext }
  } catch (error) {
    console.error("Failed to open browser:", formatError(error))
    throw error
  }
}
