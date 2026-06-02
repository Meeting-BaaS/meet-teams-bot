import type { BrowserContext, Cookie, Page } from "@playwright/test"

/**
 * Google Meet SAML SSO login flow — runs before joining a Meet meeting when
 * an authenticated bot is configured (meet_sso_config is present in the SQS message).
 *
 * Flow:
 *   1. Open a temp page in the existing browserContext (cookies will persist).
 *   2. Hit api-server's /v2/meet-sso/set-cookie URL — sets HttpOnly routing cookie.
 *   3. Navigate to Google's account chooser, type the assigned login email.
 *   4. Google's Workspace SSO config redirects to api-server's /v2/meet-sso/sign-in.
 *      api-server signs the SAML assertion and returns auto-POST HTML.
 *   5. The form submits to Google's ACS, which sets the auth cookies on .google.com.
 *   6. Wait until the auth cookies appear, then close the temp page. The cookies
 *      remain in the browserContext, so the subsequent meet.google.com navigation
 *      is automatically signed in.
 */

const GOOGLE_AUTH_COOKIE_NAMES = new Set([
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "__Secure-1PSID",
  "__Secure-3PSID",
  "__Secure-1PAPISID",
  "__Secure-3PAPISID",
  "SIDCC"
])

/**
 * Codes the bot can produce. Only two cases survive runtime classification:
 *
 *   - SAML_REJECTED: Google explicitly bounced our assertion (workspace cert
 *     mismatch). api-server flips the workspace to state=invalid.
 *   - TIMEOUT: ambiguous — could be transient network, a Google challenge page
 *     for a flagged user, account suspended, etc. Treated as transient; no
 *     auto-disable. Customer/operator investigates if it persists.
 *
 * USER_INVALID was originally a third bucket but was unreliable to detect from
 * the outside (Google's challenge URLs overlap with normal sign-in URLs), so
 * we collapsed it into TIMEOUT to avoid burning customers' workspaces on
 * misclassified single-user failures.
 */
export type SsoFailureCode = "MEET_LOGIN_FAILED_SAML_REJECTED" | "MEET_LOGIN_FAILED_TIMEOUT"

export class MeetSsoLoginError extends Error {
  constructor(
    public readonly code: SsoFailureCode,
    message: string
  ) {
    super(message)
    this.name = "MeetSsoLoginError"
  }
}

export interface MeetSsoConfig {
  session_id: string
  login_email: string
  set_cookie_url: string
  fallback: "fail" | "anonymous"
}

/**
 * Sign in to Google Workspace via SAML SSO using the assigned meet_login.
 * Sets Google auth cookies on the browserContext; subsequent meet.google.com
 * navigations will be authenticated as the bot user.
 *
 * Throws MeetSsoLoginError on any failure. Caller maps .code to a MeetingEndReason
 * reported back to api-server. Mapping there:
 *   - SAML_REJECTED → workspace-level auto-disable (every sibling login is
 *     equally broken because the cert is shared at the workspace level).
 *   - TIMEOUT → no auto-disable (treated as transient — could be network,
 *     Google challenge page, etc.).
 * See apps/api-server/src/services/meet-sso/invalidate.ts for the dispatch.
 */
export async function loginToGoogleMeetWithSso(
  browserContext: BrowserContext,
  config: MeetSsoConfig
): Promise<void> {
  // Inject previously saved cookies so Google sees a "known device" and skips
  // identity challenges (2FA prompts, "verify it's you" pages). We still run the
  // full SAML round-trip afterwards — injected cookies from a prior Playwright
  // session are not trusted by Google Meet as a live session in a new browser
  // instance, so we always need fresh ACS-issued cookies for this context.
  await injectSavedCookies(browserContext, config.set_cookie_url)

  const page = await browserContext.newPage()

  try {
    console.info(`[meet-sso] starting SSO login for ${config.login_email}`)

    // Force English locale so Google serves all sign-in pages in English.
    // Without this, Google geo-locates the bot IP.
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9"
    })

    // 1. Set the routing cookie BEFORE going to Google.
    //    A non-2xx response means the session_id is expired or unknown — fail fast.
    const cookieResponse = await page.goto(config.set_cookie_url, { waitUntil: "domcontentloaded", timeout: 15_000 })
    if (cookieResponse && !cookieResponse.ok()) {
      throw new MeetSsoLoginError(
        "MEET_LOGIN_FAILED_TIMEOUT",
        `set-cookie endpoint returned ${cookieResponse.status()} — session may be expired or invalid`
      )
    }

    // 2. Workspace-domain SSO entry: AccountChooser with hd= forces Google to
    //    treat this as a Workspace-managed login and apply our SSO redirect.
    const workspaceDomain = config.login_email.split("@")[1]
    if (!workspaceDomain) {
      // Schema validation upstream prevents this in practice — defensive only.
      throw new MeetSsoLoginError(
        "MEET_LOGIN_FAILED_TIMEOUT",
        `login_email '${config.login_email}' has no domain`
      )
    }

    const accountChooserUrl = `https://accounts.google.com/AccountChooser?hd=${encodeURIComponent(workspaceDomain)}`
    await page.goto(accountChooserUrl, { waitUntil: "domcontentloaded", timeout: 15_000 })
    const landedUrl = page.url()

    // 3. Type the bot user's email — but only if Google didn't already skip straight
    //    to the SSO round-trip. This happens when the browser context has existing
    //    Google cookies: AccountChooser immediately fires the SSO redirect without
    //    showing the email identifier page. Detect by checking whether we're still
    //    on a Google sign-in identifier URL.
    //    myaccount.google.com means the session is already active (injected cookies
    //    accepted by Google) — auth cookies are present, no email step needed.
    const onIdentifierPage = landedUrl.includes("accounts.google.com") &&
      (landedUrl.includes("/signin") || landedUrl.includes("/AccountChooser") || landedUrl.includes("ServiceLogin"))

    const sessionAlreadyActive = landedUrl.includes("myaccount.google.com")

    if (onIdentifierPage) {
      const emailInput = page.locator('input[type="email"], #identifierId').first()
      await emailInput.waitFor({ state: "visible", timeout: 15_000 })
      console.info(`[meet-sso] email input found, page URL: ${page.url()}`)
      await emailInput.fill(config.login_email)

      // Click Next — typically a button with "Next" or id="identifierNext".
      const nextButton = page
        .locator('#identifierNext button, button:has-text("Next"), button:has-text("Continue")')
        .first()
      await nextButton.click({ timeout: 10_000 })
    } else {
      console.info(`[meet-sso] AccountChooser already fired SSO redirect — skipping email input step`)
    }

    // 4. Only run email-submission diagnostics when we went through the email step.
    //    When AccountChooser fired SSO immediately (onIdentifierPage=false), we skip
    //    these checks — the browser is already in the middle of the SAML round-trip.
    if (onIdentifierPage) {
      const urlBeforeNext = page.url()
      try {
        await page.waitForFunction(
          (beforeUrl: string) =>
            window.location.href !== beforeUrl ||
            !!document.querySelector('input[type="password"]') ||
            !!document.querySelector('[data-error-code], [aria-live="assertive"] [jsname]'),
          urlBeforeNext,
          { timeout: 8_000 }
        )
      } catch {
      }

      const urlAfterNext = page.url()

      // Detect password page — means Google did not redirect to our IdP.
      const passwordInput = page.locator('input[type="password"]').first()
      const passwordVisible = await passwordInput.isVisible().catch(() => false)
      if (passwordVisible) {
        throw new MeetSsoLoginError(
          "MEET_LOGIN_FAILED_TIMEOUT",
          `Google showed a password prompt instead of redirecting to SSO (URL: ${urlAfterNext}). ` +
          "Check that the Legacy SSO profile is created and assigned to all users in Google Admin Console."
        )
      }

      // Detect "Couldn't find your Google Account" or similar error message.
      const pageText = await page.locator("body").innerText().catch(() => "")
      if (
        pageText.includes("Couldn't find your Google Account") ||
        pageText.includes("couldn't find your account") ||
        pageText.includes("No account found")
      ) {
        throw new MeetSsoLoginError(
          "MEET_LOGIN_FAILED_TIMEOUT",
          `Google could not find the account '${config.login_email}'. Verify the user exists in the Workspace. (URL: ${urlAfterNext})`
        )
      }

      // If URL still matches the identifier page after 8s, SSO redirect never fired.
      if (urlAfterNext === urlBeforeNext) {
        console.warn(
          `[meet-sso] URL unchanged after Next click — Legacy SSO may not be assigned to ${config.login_email}. ` +
          "Check Google Admin Console: Security → Authentication → SSO with third-party IdP → Manage SSO profile assignments."
        )
      }
    }

    // 5. From here Google redirects to api-server's /v2/meet-sso/sign-in, which
    //    returns the auto-POST form. The form submits to Google's ACS. Google may
    //    show a "samlconfirmaccount" speedbump before setting cookies — we watch
    //    for it concurrently and auto-click Continue so the bot never stalls.
    //    When the session is already active (myaccount.google.com), the SAML round-
    //    trip was skipped, so samlconfirmaccount will never appear — skip the watcher
    //    to avoid a 40-second silent timeout.
    if (sessionAlreadyActive) {
      console.info(`[meet-sso] session already active from injected cookies — skipping SAML watcher`)
      await waitForGoogleAuthCookies(browserContext, 45_000, page)
    } else {
      const confirmWatcher = watchAndClickSamlConfirm(page)
      await waitForGoogleAuthCookies(browserContext, 45_000, page)
      // Don't await: once auth cookies are present the SAML round-trip is done.
      // The watcher's 40-second waitForURL timeout would otherwise stall here
      // whenever samlconfirmaccount never appeared (the common fast path).
      void confirmWatcher
    }

    // Persist cookies so the next bot run for this login can skip SSO entirely
    // and Google won't treat it as a new device (avoiding identity challenges).
    await persistCookies(browserContext, config.set_cookie_url)

    console.info(`[meet-sso] SSO login successful for ${config.login_email}`)
  } catch (err) {
    if (err instanceof MeetSsoLoginError) {
      throw err
    }
    // Default to TIMEOUT — does NOT auto-disable the meet_login (treated as transient).
    // Only classify as SAML_REJECTED when the URL clearly points at Google's
    // "Server error" page emitted by /a/<workspace>/acs on a malformed assertion.
    // We deliberately don't try to detect USER_INVALID via URL substrings — Google's
    // challenge/suspended/disabled paths overlap and are too easy to misclassify;
    // misclassifying as SAML_REJECTED would burn a customer's login. Treat ambiguous
    // failures as transient TIMEOUT instead.
    const message = err instanceof Error ? err.message : String(err)
    const currentUrl = page.url()
    console.error(`[meet-sso] SSO login failed: ${message} (last URL: ${currentUrl})`)

    let code: SsoFailureCode = "MEET_LOGIN_FAILED_TIMEOUT"
    // Tight match: Google's ACS endpoint returning a Server error page.
    // Pattern: https://accounts.google.com/a/<workspace>/acs OR
    //          https://www.google.com/a/<workspace>/acs after a rejected POST.
    if (/^https:\/\/(?:accounts|www)\.google\.com\/a\/[^/]+\/acs(?:[?#]|$)/.test(currentUrl)) {
      code = "MEET_LOGIN_FAILED_SAML_REJECTED"
    }

    throw new MeetSsoLoginError(code, `${message} (last URL: ${currentUrl})`)
  } finally {
    await page.close().catch(() => { })
  }
}

/**
 * Watch for Google's "samlconfirmaccount" speedbump page and auto-click Continue.
 * Runs concurrently with waitForGoogleAuthCookies — resolves silently either way.
 */
async function watchAndClickSamlConfirm(page: Page): Promise<void> {
  try {
    // waitForURL waits for the NEXT navigation matching the pattern — it misses
    // the page if it's already loaded by the time we call it. Check current URL
    // first and skip the wait if we're already there.
    if (!page.url().includes("samlconfirmaccount")) {
      await page.waitForURL(/samlconfirmaccount/, { timeout: 40_000 })
    }

    await page.waitForLoadState("domcontentloaded")

    // Use page.evaluate() to click directly in the DOM — more reliable than
    // Playwright locators when Google renders buttons as non-standard elements
    // (Material Design divs, shadow DOM wrappers, etc.).
    const clicked = await page.evaluate((): boolean => {
      const all = Array.from(
        document.querySelectorAll<HTMLElement>('button, [role="button"], a[jsaction]')
      )
      // Prefer a button whose text contains "Continue" / "Devam" / "Proceed"
      const match = all.find((el) =>
        /continue|devam|proceed/i.test((el.innerText || el.textContent || "").trim())
      )
      const target = match ?? all[all.length - 1]
      if (target) {
        target.click()
        return true
      }
      return false
    })

    if (!clicked) {
      await page.keyboard.press("Enter")
    }

    console.info(`[meet-sso] Clicked Continue on SAML confirm page (evaluate=${clicked})`)
  } catch {
  }
}

async function waitForGoogleAuthCookies(
  browserContext: BrowserContext,
  timeoutMs: number,
  page?: Page
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    // Detect Google's "Verify it's you" / identity challenge page. This fires
    // when Google's risk model wants 2FA/phone verification after SSO — it cannot
    // be automated. The fix is in Google Admin Console (disable 2SV for the bot OU).
    if (page) {
      const url = page.url()
      if (url.includes("/signin/challenge") || url.includes("/v3/signin/challenge")) {
        throw new MeetSsoLoginError(
          "MEET_LOGIN_FAILED_TIMEOUT",
          `Google is requesting identity verification (2FA/phone) after SSO — URL: ${url}. ` +
          "Fix in Google Admin Console: Security → 2-Step Verification → turn OFF for the bot account's OU."
        )
      }
      // Detect Google's SAML rejection page immediately instead of waiting for the
      // 45-second auth-cookie timeout. rrk=21 = assertion verification failed (cert
      // mismatch or malformed assertion). Classify as SAML_REJECTED so the workspace
      // gets auto-disabled — all sibling logins share the same broken cert.
      if (url.includes("/v3/signin/rejected") || url.includes("rrk=")) {
        throw new MeetSsoLoginError(
          "MEET_LOGIN_FAILED_SAML_REJECTED",
          `Google rejected the SAML assertion (${url}). ` +
          "Verify the signing cert in your meet workspace matches the Verification certificate in Google Admin Console."
        )
      }
    }

    const cookies = await browserContext.cookies(["https://accounts.google.com", "https://google.com"])
    const present = new Set(cookies.map((c) => c.name))
    for (const required of GOOGLE_AUTH_COOKIE_NAMES) {
      if (present.has(required)) return
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  throw new Error(
    `Google auth cookies did not appear within ${timeoutMs}ms — SSO round-trip likely failed`
  )
}

// ---------------------------------------------------------------------------
// Cookie persistence via api-server (Redis-backed, shared across all pods).
// The cookies URL is derived from set_cookie_url — same host/session_id, just
// a different path segment.
// ---------------------------------------------------------------------------

function cookiesApiUrl(setCookieUrl: string): string {
  return setCookieUrl.replace("/set-cookie", "/cookies")
}

/**
 * Fetch previously stored Google cookies from api-server and inject the
 * non-auth subset into the browser context as a "known device" hint.
 *
 * We deliberately filter out the Google auth session cookies (SID, HSID, etc.).
 * Injecting those makes AccountChooser detect an "active session" and skip the
 * SAML round-trip entirely, landing on myaccount.google.com instead of going
 * through our IdP. Without a fresh ACS-issued assertion, navigations to
 * meet.google.com also redirect to myaccount.google.com.
 *
 * Device/preference cookies (GAPS, NID, 1P_JAR, etc.) are safe to inject —
 * they help Google recognise the device and suppress identity challenges (2FA,
 * "verify it's you" prompts) without establishing a session.
 */
async function injectSavedCookies(
  browserContext: BrowserContext,
  setCookieUrl: string
): Promise<void> {
  try {
    const res = await fetch(cookiesApiUrl(setCookieUrl))
    if (!res.ok) return

    const body = (await res.json()) as { cookies: Cookie[] }
    const nowSec = Date.now() / 1000
    // Filter out expired cookies AND auth session cookies that would bypass SAML.
    const hint = body.cookies.filter(
      (c) =>
        (!c.expires || c.expires === -1 || c.expires > nowSec) &&
        !GOOGLE_AUTH_COOKIE_NAMES.has(c.name)
    )
    if (hint.length === 0) return

    await browserContext.addCookies(hint)
    console.info(`[meet-sso] injected ${hint.length} non-auth cookies as known-device hint`)
  } catch {
    // Non-fatal — fall through to full SSO without cached cookies.
  }
}

/**
 * POST all browser context cookies to api-server so subsequent bot runs (on
 * any pod) can reuse them and skip the SSO flow + identity challenges.
 */
async function persistCookies(
  browserContext: BrowserContext,
  setCookieUrl: string
): Promise<void> {
  try {
    const cookies = await browserContext.cookies()
    const res = await fetch(cookiesApiUrl(setCookieUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true"
      },
      body: JSON.stringify({ cookies })
    })
    if (res.ok) {
      console.info(`[meet-sso] persisted ${cookies.length} cookies to api-server`)
    } else {
      console.warn(`[meet-sso] failed to persist cookies: ${res.status}`)
    }
  } catch (err) {
    console.warn(`[meet-sso] failed to persist cookies: ${err}`)
  }
}
