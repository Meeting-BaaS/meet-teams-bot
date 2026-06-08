import { type BrowserContext, chromium } from "@playwright/test"
import { envVars } from "../config/env-vars"
import { GLOBAL } from "../singleton"
import { formatError } from "../utils/Logger"
import { getExitGeo } from "../proxy/toggle-proxy"

export async function openBrowser(proxyUrl?: string | null): Promise<{ browser: BrowserContext }> {
  // Resolution configuration from environment variable
  // Defaults to 720p if RESOLUTION is not set or invalid
  const resolution = envVars.RESOLUTION
  const { width, height } =
    resolution === "1080" ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }

  const windowWidth = width
  const windowHeight = resolution === "1080" ? 1220 : 860

  // Align ONLY the timezone with the residential exit IP's geo. Locale and
  // Accept-Language stay en-US on purpose: the Meet/Teams join + UI-cleaning
  // logic matches English UI strings ("Ask to join", "Continue without audio",
  // "Turn off camera", …), so a non-English UI would break those selectors. A
  // UTC clock on a non-UTC egress IP is the stronger bot tell anyway.
  const timezoneId = getExitGeo()?.timezone ?? undefined
  if (timezoneId) console.log(`[Browser] Aligning timezone with exit IP: ${timezoneId}`)

  const sharedArgs = [
    // Window size and position - must match Xvfb display exactly
    `--window-size=${windowWidth},${windowHeight}`,
    "--window-position=0,0",

    // Security configurations
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--lang=en-US", // English UI — the bot matches English selectors (do not localize)
    "--accept-lang=en-US,en",

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

    // Suppress Chrome's "Sign in to Chrome?" / "Turn on sync" dialogs that
    // appear when a Workspace account authenticates. These are native Chrome UI
    // dialogs unreachable by Playwright automation.
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-component-update",
    // SigninInterception = DICE web sign-in intercept bubble ("Sign in to Chrome?")
    // IdentityConsistency = browser auto-linking cookie-jar identity to a Chrome profile
    // --disable-signin = fully disables browser sign-in at the policy level
    "--disable-signin",
    "--disable-features=SigninInterception,IdentityConsistency,ChromeBrowserCloudManagement,SignInPromo,ChromeWhatsNewUI,AccountConsistency",

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
  ]

  // ─── Google Meet: CloakBrowser (stealth Chromium + humanized input) ───────
  // Meet's reCAPTCHA-Enterprise-style join scoring blocks plain Chromium/CDP
  // input. dehumanize() restores native Playwright methods once the bot is
  // admitted (see WaitingRoomState).
  if (GLOBAL.get().meeting_platform === "meet") {
    try {
      console.log("Launching CloakBrowser persistent context (Meet)...")

      // esbuild converts import() to require() under "module: commonjs", which breaks
      // ESM-only packages. The Function constructor prevents that transpilation.
      const dynamicImport = new Function("specifier", "return import(specifier)")
      const { launchPersistentContext } = await dynamicImport("cloakbrowser")
      const context = await launchPersistentContext({
        userDataDir: "",
        headless: false,
        viewport: { width, height },
        locale: "en-US",
        ...(timezoneId ? { timezoneId } : {}),
        humanize: true,
        ...(proxyUrl ? { proxy: proxyUrl } : {}),
        args: [
          ...sharedArgs,
          "--disable-gpu",
          "--disable-software-rasterizer",
          "--disable-gpu-compositing"
        ],
        contextOptions: {
          permissions: ["microphone", "camera"],
          ignoreHTTPSErrors: true,
          acceptDownloads: true,
          bypassCSP: true
        }
      })
      console.log("✅ CloakBrowser launched (Meet)")
      return { browser: context as unknown as BrowserContext }
    } catch (error) {
      console.error("Failed to open browser:", formatError(error))
      throw error
    }
  }

  // ─── Teams / everything else: official Chrome (pre-CloakBrowser path) ─────
  // Exact same launch as before CloakBrowser was introduced — no CloakBrowser,
  // no humanize. Teams has no anti-bot join scoring that requires stealth.
  try {
    console.log("Launching persistent context with exact extension args...")

    // Get Chrome path from environment variable or use default
    const chromePath = envVars.CHROME_PATH
    console.log(`🔍 Using Chrome path: ${chromePath}`)

    const context = await chromium.launchPersistentContext("", {
      headless: false,
      viewport: { width, height },
      executablePath: chromePath,
      locale: "en-US", // English UI — the bot matches English selectors (do not localize)
      ...(timezoneId ? { timezoneId } : {}),
      args: sharedArgs,
      permissions: ["microphone", "camera"],
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
      bypassCSP: true,
      timeout: 120000
    })

    console.log("✅ Chrome launched with PulseAudio configuration")
    return { browser: context }
  } catch (error) {
    console.error("Failed to open browser:", formatError(error))
    throw error
  }
}
