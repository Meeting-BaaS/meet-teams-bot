import type { BrowserContext } from "@playwright/test"

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
  const page = await browserContext.newPage()

  try {
    console.info(`[meet-sso] starting SSO login for ${config.login_email}`)

    // 1. Set the routing cookie BEFORE going to Google.
    await page.goto(config.set_cookie_url, { waitUntil: "domcontentloaded", timeout: 15_000 })

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

    // 3. Type the bot user's email. Google's email input is identifier#identifierId.
    //    We use a robust selector matching either input[type="email"] or that ID.
    const emailInput = page.locator('input[type="email"], #identifierId').first()
    await emailInput.waitFor({ state: "visible", timeout: 15_000 })
    await emailInput.fill(config.login_email)

    // Click Next — typically a button with "Next" or id="identifierNext".
    const nextButton = page
      .locator('#identifierNext button, button:has-text("Next"), button:has-text("Continue")')
      .first()
    await nextButton.click({ timeout: 10_000 })

    // 4. From here Google redirects to api-server's /v2/meet-sso/sign-in, which
    //    returns the auto-POST form. The form submits to Google's ACS. We don't
    //    interact with these intermediate pages — just wait for the Google auth
    //    cookies to appear.
    await waitForGoogleAuthCookies(browserContext, 30_000)

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
    await page.close().catch(() => {})
  }
}

async function waitForGoogleAuthCookies(
  browserContext: BrowserContext,
  timeoutMs: number
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const cookies = await browserContext.cookies(["https://accounts.google.com", "https://google.com"])
    const present = new Set(cookies.map((c) => c.name))
    let foundAny = false
    for (const required of GOOGLE_AUTH_COOKIE_NAMES) {
      if (present.has(required)) {
        foundAny = true
        break
      }
    }
    if (foundAny) return
    await new Promise((r) => setTimeout(r, 500))
  }

  throw new Error(
    `Google auth cookies did not appear within ${timeoutMs}ms — SSO round-trip likely failed`
  )
}
