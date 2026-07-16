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
    // V8 heap cap for large meetings. Must be passed via --js-flags: a bare
    // --max_old_space_size argument is not a Chromium switch and is silently ignored.
    "--js-flags=--max-old-space-size=4096",
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

  const platform = GLOBAL.get().meeting_platform
  // Zoom Web renders via SwiftShader software-WebGL + a software video decoder;
  // vexa measured the standalone gpu-process at ~357% CPU. --in-process-gpu
  // folds that into the renderer and keeps per-bot demand bounded.
  //
  // Crucially we do NOT --disable-gpu for Zoom: that leaves the page with a null
  // WebGL context (webgl/webgl2 both null), which is a strong bot tell — no real
  // Chrome reports zero WebGL. Keeping SwiftShader alive lets CloakBrowser hand
  // the page a spoofed Windows GPU renderer instead. Meet/Teams don't
  // fingerprint WebGL as hard and want the CPU/stability of a disabled GPU, so
  // the disable stays scoped to them.
  const gpuArgs =
    platform === "zoom"
      ? ["--in-process-gpu"]
      : ["--disable-gpu", "--disable-software-rasterizer", "--disable-gpu-compositing"]

  // Zoom geometry coherence: our 720p capture window is 1280x720, but
  // CloakBrowser's seed spoofs a 1920x1080 screen — leaving screen >> viewport,
  // which reads as a shrunken/VM-ish window. Pin the spoofed screen to a common
  // 1440x900 laptop so the 1280x720 window looks like a near-maximized browser
  // on a real display. 1080p already fills a 1920-wide screen, so leave it.
  const zoomFingerprintArgs =
    platform === "zoom" && resolution !== "1080"
      ? ["--fingerprint-screen-width=1440", "--fingerprint-screen-height=900"]
      : []
  try {
    console.log(`Launching CloakBrowser persistent context (${platform})...`)

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
      args: [...sharedArgs, ...gpuArgs, ...zoomFingerprintArgs],
      contextOptions: {
        permissions: ["microphone", "camera"],
        ignoreHTTPSErrors: true,
        acceptDownloads: true,
        bypassCSP: true
      }
    })
    console.log(`✅ CloakBrowser launched (${platform})`)
    return { browser: context as unknown as BrowserContext }
  } catch (error) {
    console.error("Failed to open browser:", formatError(error))
    throw error
  }
}
