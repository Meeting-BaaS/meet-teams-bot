import { type BrowserContext, chromium } from "@playwright/test"
import { envVars } from "../config/env-vars"
import { GLOBAL } from "../singleton"
import { formatError } from "../utils/Logger"
import { getExitGeo } from "../proxy/toggle-proxy"

// Map the exit IP's country (from the residential-proxy probe) to a browser
// locale, so locale/Accept-Language match the proxied egress geo instead of a
// hardcoded en-US. Timezone comes straight from the probe. Unmapped → en-US.
const COUNTRY_LOCALE: Record<string, string> = {
  US: "en-US", GB: "en-GB", IE: "en-IE", CA: "en-CA", AU: "en-AU",
  FR: "fr-FR", DE: "de-DE", ES: "es-ES", IT: "it-IT", NL: "nl-NL",
  PL: "pl-PL", PT: "pt-PT", BR: "pt-BR", SE: "sv-SE", NO: "nb-NO",
  DK: "da-DK", FI: "fi-FI", BE: "fr-BE", CH: "de-CH", AT: "de-AT",
}

export async function openBrowser(proxyUrl?: string | null): Promise<{ browser: BrowserContext }> {
  // Resolution configuration from environment variable
  // Defaults to 720p if RESOLUTION is not set or invalid
  const resolution = envVars.RESOLUTION
  const { width, height } =
    resolution === "1080" ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }

  const windowWidth = width
  const windowHeight = resolution === "1080" ? 1220 : 860

  // Align locale + timezone with the residential exit IP's geo (set by the
  // proxy probe). Falls back to en-US / browser-default tz when unknown.
  const geo = getExitGeo()
  const locale = COUNTRY_LOCALE[geo?.country ?? ""] ?? "en-US"
  const lang = locale.split("-")[0]
  const timezoneId = geo?.timezone ?? undefined
  if (geo?.country || geo?.timezone) {
    console.log(`[Browser] Geo from exit IP: country=${geo?.country ?? "?"} tz=${geo?.timezone ?? "?"} → locale=${locale}`)
  }

  const sharedArgs = [
    // Window size and position - must match Xvfb display exactly
    `--window-size=${windowWidth},${windowHeight}`,
    "--window-position=0,0",

    // Security configurations
    "--no-sandbox",
    "--disable-setuid-sandbox",
    `--lang=${locale}`, // align UI language with exit-IP geo
    `--accept-lang=${locale},${lang}`, // align Accept-Language with exit-IP geo

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
        locale,
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
      locale, // align with exit-IP geo
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
