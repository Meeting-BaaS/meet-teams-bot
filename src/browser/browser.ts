import { type BrowserContext, chromium, firefox } from "@playwright/test"
import { envVars } from "../config/env-vars"
import { GLOBAL } from "../singleton"
import { formatError } from "../utils/Logger"
import { getExitGeo } from "../proxy/toggle-proxy"

export async function openBrowser(proxyUrl?: string | null): Promise<{ browser: BrowserContext }> {
  const platform = GLOBAL.get().meeting_platform

  // stealthfox (patched anti-detect Firefox) is the default for the platforms in
  // STEALTHFOX_PLATFORMS (zoom by default); USE_STEALTHFOX forces it everywhere.
  // Both need the baked binary — without it we fall through to CloakBrowser, so
  // meet/teams and any binary-less env keep working unchanged.
  if (shouldUseStealthfox(platform)) {
    console.log(`[Browser] stealthfox enabled (platform=${platform}) - patched Firefox binary`)
    return openStealthfoxBrowser(proxyUrl)
  }

  // Stock Playwright Firefox A/B path (fingerprint- vs IP-block testing).
  if (envVars.USE_FIREFOX) {
    console.log("[Browser] Firefox mode enabled - using Firefox instead of CloakBrowser")
    return openFirefoxBrowser(proxyUrl)
  }

  return openCloakBrowser(proxyUrl)
}

// Whether this platform should launch stealthfox. Requires the baked binary
// (STEALTHFOX_BINARY_PATH). USE_STEALTHFOX=true forces it for all platforms;
// otherwise it's the STEALTHFOX_PLATFORMS allowlist (default "zoom", "all" = every
// platform), so widening to meet/teams is a single config change.
function shouldUseStealthfox(platform: string): boolean {
  if (!envVars.STEALTHFOX_BINARY_PATH) return false
  if (envVars.USE_STEALTHFOX) return true
  const allow = envVars.STEALTHFOX_PLATFORMS.split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
  return allow.includes("all") || allow.includes(platform.toLowerCase())
}

// Shared Firefox launch geometry/args/prefs, reused by both the stock-Firefox
// and stealthfox paths. Keeping ONE source of truth means the arg fix (no
// `--width/--height/-headless=false` — they hang launchPersistentContext) and
// the software-render prefs apply to stealthfox too.
function buildFirefoxLaunchConfig(): {
  width: number
  height: number
  timezoneId: string | undefined
  firefoxArgs: string[]
  firefoxPrefs: Record<string, string | number | boolean>
} {
  const resolution = envVars.RESOLUTION
  const { width, height } =
    resolution === "1080" ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }

  const timezoneId = getExitGeo()?.timezone ?? undefined

  const firefoxArgs = [
    // Security configurations
    "-no-remote",
    "-new-instance",
    // Performance optimizations
    "-purgecaches"
    // NOTE: do NOT add `--width`/`--height` or `-headless=false` here. Window
    // size is set via the `viewport` option below, and headed mode via
    // `headless: false`. Passing them as raw Firefox CLI flags makes
    // launchPersistentContext HANG (bisected): `--width/--height` aren't valid
    // Firefox flags, and `-headless=false` conflicts with Playwright's own
    // headed handling — Firefox never signals ready and the launch times out.
  ]

  const firefoxPrefs = {
    // Language and locale
    "intl.accept_languages": "en-US,en",
    "intl.locale.requested": "en-US",

    // Media/Audio permissions
    "media.navigator.permission.disabled": true,
    // Local dev has no v4l2loopback camera (/dev/video10), so Firefox's real
    // camera fails and the bot joins with no video. On ENVIRON=local only, let
    // Firefox synthesize a FAKE camera/mic so the bot has a working video tile to
    // test with. Stays false in preprod/prod, which use the real branding feed —
    // so this must never be enabled off-local (it would drop the real branding).
    "media.navigator.streams.fake": envVars.ENVIRON === "local",
    "permissions.default.microphone": 1,
    "permissions.default.camera": 1,

    // WebRTC
    "media.peerconnection.enabled": true,
    "media.navigator.enabled": true,

    // Autoplay
    "media.autoplay.default": 0, // Allow audio and video
    "media.autoplay.blocking_policy": 0,

    // Disable privacy features that might interfere
    "privacy.resistFingerprinting": false,
    "privacy.trackingprotection.enabled": false,

    // Security
    "security.ssl.enable_ocsp_stapling": false,
    "security.cert_pinning.enforcement_level": 0,

    // Performance
    "browser.cache.disk.enable": false,
    "browser.cache.memory.enable": true,
    "browser.sessionhistory.max_total_viewers": 0,

    // Disable updates and sync
    "app.update.enabled": false,
    "browser.shell.checkDefaultBrowser": false,
    "services.sync.engine.prefs": false,

    // WebGL (important for Zoom)
    "webgl.disabled": false,
    "webgl.force-enabled": true,
    // Spoof the WebGL renderer/vendor away from "llvmpipe" — the software
    // rasteriser string on a headless Xvfb pod, which is a dead datacenter/bot
    // tell that no real user reports. These are NATIVE Firefox prefs (not a JS
    // override, so there's nothing to catch via Proxy/toString), making the
    // browser itself report a coherent consumer GPU. Kept a Linux Mesa/Intel GPU
    // so it stays consistent with the Linux platform the browser presents.
    "webgl.renderer-string-override": "Mesa Intel(R) UHD Graphics 630 (CML GT2)",
    "webgl.vendor-string-override": "Intel",

    // Software rendering. A headed Firefox on a GL-less Xvfb hangs during
    // launchPersistentContext trying to init hardware GL/WebRender. Force the
    // software WebRender + disable layer acceleration so it renders (and gives a
    // software WebGL context) without any display GL. Pair with
    // LIBGL_ALWAYS_SOFTWARE=1 in the service env.
    "gfx.webrender.software": true,
    "gfx.webrender.all": true,
    "layers.acceleration.disabled": true
  }

  return { width, height, timezoneId, firefoxArgs, firefoxPrefs }
}

async function openStealthfoxBrowser(proxyUrl?: string | null): Promise<{ browser: BrowserContext }> {
  const binaryPath = envVars.STEALTHFOX_BINARY_PATH
  if (!binaryPath) {
    throw new Error(
      "USE_STEALTHFOX=true but STEALTHFOX_BINARY_PATH is empty. Fetch the binary with " +
        "`python -m invisible_playwright fetch` and set STEALTHFOX_BINARY_PATH to the output " +
        "of `python -m invisible_playwright path`."
    )
  }

  const { width, height, timezoneId, firefoxArgs, firefoxPrefs } = buildFirefoxLaunchConfig()
  if (timezoneId) console.log(`[Browser] Aligning timezone with exit IP: ${timezoneId}`)

  // Enable the patched binary's humanized (Bezier) mouse paths. The Juggler in
  // stealthfox gates this on the `stealthfox.humanize` pref; stock Firefox
  // ignores the unknown pref, so it's harmless if the wrong binary is pointed at.
  const stealthPrefs: Record<string, string | number | boolean> = {
    ...firefoxPrefs,
    "stealthfox.humanize": true
  }

  // Playwright REPLACES the browser env when `env` is set, so start from the
  // current process env (keeps PATH, nix-ld/LD_LIBRARY_PATH wiring the Firefox
  // libs need, DISPLAY, PulseAudio vars). Then layer TZ so glibc's clock matches
  // the exit IP (Intl/Date). STEALTHFOX_WEBRTC_* pass through untouched.
  const stealthEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") stealthEnv[key] = value
  }
  if (timezoneId) stealthEnv.TZ = timezoneId

  try {
    console.log(`Launching stealthfox persistent context (binary: ${binaryPath})...`)

    const context = await firefox.launchPersistentContext("", {
      headless: false,
      executablePath: binaryPath,
      env: stealthEnv,
      viewport: { width, height },
      locale: "en-US",
      ...(timezoneId ? { timezoneId } : {}),
      ...(proxyUrl ? {
        proxy: {
          server: proxyUrl
        }
      } : {}),
      args: firefoxArgs,
      firefoxUserPrefs: stealthPrefs,
      // Same as openFirefoxBrowser: mic/camera come from the
      // permissions.default.* prefs, not a Playwright permissions array.
      // NOTE: do NOT set `ignoreHTTPSErrors` here. The stealthfox anti-detect
      // patch removes nsICertOverrideService.setDisableAllSecurityChecks…, so
      // Playwright's setIgnoreHTTPSErrors call fails the launch with
      // NS_ERROR_NOT_AVAILABLE (bisected). Stock Firefox keeps it; stealthfox
      // drops it deliberately (a real browser has no such override).
      acceptDownloads: true,
      bypassCSP: true
    })

    console.log(`✅ stealthfox launched`)
    return { browser: context }
  } catch (error) {
    console.error("Failed to open stealthfox browser:", formatError(error))
    throw error
  }
}

async function openFirefoxBrowser(proxyUrl?: string | null): Promise<{ browser: BrowserContext }> {
  const { width, height, timezoneId, firefoxArgs, firefoxPrefs } = buildFirefoxLaunchConfig()
  if (timezoneId) console.log(`[Browser] Aligning timezone with exit IP: ${timezoneId}`)

  try {
    console.log(`Launching Firefox persistent context...`)

    const context = await firefox.launchPersistentContext("", {
      headless: false,
      viewport: { width, height },
      locale: "en-US",
      ...(timezoneId ? { timezoneId } : {}),
      ...(proxyUrl ? {
        proxy: {
          server: proxyUrl
        }
      } : {}),
      args: firefoxArgs,
      firefoxUserPrefs: firefoxPrefs,
      // NOTE: no `permissions` array here — Playwright Firefox rejects
      // "microphone" ("Unknown permission"). Firefox grants mic+camera via the
      // `permissions.default.microphone/camera = 1` firefoxUserPrefs above.
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
      bypassCSP: true
    })

    console.log(`✅ Firefox launched`)
    return { browser: context }
  } catch (error) {
    console.error("Failed to open Firefox browser:", formatError(error))
    throw error
  }
}

async function openCloakBrowser(proxyUrl?: string | null): Promise<{ browser: BrowserContext }> {
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
    "--audio-buffer-size=8192", // ~170ms at 48kHz — absorbs CPU contention xruns
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
  // the standalone gpu-process measured ~357% CPU. --in-process-gpu
  // folds that into the renderer and drops per-bot demand from ~4.4 cores to
  // ~115%. Meet/Teams don't need it, so scope it to Zoom.
  const gpuArgs =
    platform === "zoom"
      ? [
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-gpu-compositing",
        "--in-process-gpu"
      ]
      : ["--disable-gpu", "--disable-software-rasterizer", "--disable-gpu-compositing"]

  // Local dev (e.g. macOS) has no PulseAudio/v4l2loopback virtual devices, so
  // Chromium finds no real mic/camera and Teams gets stuck on its pre-join
  // device-permission page. On ENVIRON=local or macOS, synthesize a fake mic+camera
  // and auto-accept the getUserMedia prompt so the join proceeds — the Chromium
  // analog of the Firefox `media.navigator.streams.fake` local behavior. Never
  // off-local: prod uses the real branding feed via the virtual devices.
  const localMediaArgs =
    envVars.ENVIRON === "local" || process.platform === "darwin"
      ? ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
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
      args: [...sharedArgs, ...gpuArgs, ...localMediaArgs],
      contextOptions: {
        permissions: ["microphone", "camera"],
        ignoreHTTPSErrors: true,
        acceptDownloads: true,
        bypassCSP: true
      }
    })
    // LOCAL DEV (tsx/esbuild): esbuild's keepNames wraps named functions passed to
    // page.evaluate() with a __name(...) helper that does not exist in the browser, so
    // every evaluate throws "ReferenceError: __name is not defined" under tsx. Polyfill
    // it as identity on every document (harmless when compiled — __name is then unused).
    await (context as unknown as BrowserContext).addInitScript(
      "globalThis.__name = globalThis.__name || function (f) { return f }"
    )
    console.log(`✅ CloakBrowser launched (${platform})`)
    return { browser: context as unknown as BrowserContext }
  } catch (error) {
    console.error("Failed to open browser:", formatError(error))
    throw error
  }
}
