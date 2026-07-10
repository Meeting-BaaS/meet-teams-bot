import type { BrowserContext, Page } from "@playwright/test"

/**
 * Microsoft Teams username/password login — runs before joining a Teams meeting
 * when an authenticated bot is configured (teams_login_config present in the SQS
 * message).
 *
 * Unlike Meet (SAML SSO with MeetingBaaS as IdP), Teams has no IdP path without
 * federation, so — like Recall/Attendee — the bot signs in with real credentials:
 *   1. Fetch the assigned account { email, password } once from api-server's
 *      /v2/teams-sso/resolve-session (keyed by the short-lived session id).
 *   2. Type them into login.microsoftonline.com (email -> Next, password -> Sign in).
 *   3. Handle the "Stay signed in?" (KMSI) prompt; detect bad creds / captcha / MFA.
 *   4. Confirm Microsoft auth cookies (ESTSAUTH*) are set on the browser context so
 *      the subsequent teams.microsoft.com navigation is authenticated.
 *
 * See docs/MICROSOFT_TEAMS_AUTHENTICATED_BOTS.md for full design context.
 */

const MICROSOFT_AUTH_COOKIE_NAMES = new Set([
  "ESTSAUTH",
  "ESTSAUTHPERSISTENT",
  "ESTSAUTHLIGHT",
  "SignInStateCookie"
])

/**
 * Codes the bot can produce. Mapped by the caller to a MeetingEndReason reported
 * back to api-server, which flips the teams_login to state=invalid for the
 * credential/MFA/captcha buckets (per-account, not shared like Meet's cert) and
 * treats TIMEOUT as transient (no auto-disable).
 */
export type TeamsLoginFailureCode =
  | "TEAMS_LOGIN_FAILED_INVALID_CREDENTIALS"
  | "TEAMS_LOGIN_FAILED_CAPTCHA"
  | "TEAMS_LOGIN_FAILED_MFA_REQUIRED"
  | "TEAMS_LOGIN_FAILED_TIMEOUT"

export class TeamsLoginError extends Error {
  constructor(
    public readonly code: TeamsLoginFailureCode,
    message: string
  ) {
    super(message)
    this.name = "TeamsLoginError"
  }
}

export interface TeamsLoginConfig {
  session_id: string
  login_email: string
  resolve_url: string // api-server endpoint returning { email, password } for this session
  fallback: "fail" | "anonymous"
}

interface ResolvedCredentials {
  email: string
  password: string
}

/**
 * Sign in to the assigned Microsoft account. Sets Microsoft auth cookies on the
 * browserContext; subsequent teams.microsoft.com navigations are authenticated.
 * Throws TeamsLoginError on any failure.
 */
export async function loginToTeamsWithCredentials(
  browserContext: BrowserContext,
  config: TeamsLoginConfig
): Promise<void> {
  const { email, password } = await resolveCredentials(config)
  const page = await browserContext.newPage()

  try {
    console.info(`[teams-login] starting sign-in for ${config.login_email}`)

    // Force English so Microsoft serves sign-in pages in a predictable language.
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" })

    // 1. Microsoft identity sign-in entry.
    await page.goto("https://login.microsoftonline.com/", {
      waitUntil: "domcontentloaded",
      timeout: 20_000
    })

    // 2. Email -> Next
    const emailInput = page.locator('input[type="email"], input[name="loginfmt"]').first()
    await emailInput.waitFor({ state: "visible", timeout: 15_000 })
    await emailInput.fill(email)
    await clickPrimary(page, ["Next"])

    // 3. Password -> Sign in
    const passwordInput = page.locator('input[type="password"], input[name="passwd"]').first()
    await passwordInput.waitFor({ state: "visible", timeout: 20_000 })
    await passwordInput.fill(password)
    await clickPrimary(page, ["Sign in", "Sign In"])

    // 4. Give the response a moment, then classify credential / captcha / MFA errors.
    await page.waitForTimeout(2_000)
    await detectLoginError(page)

    // 5. "Stay signed in?" (KMSI) — click Yes so the session persists.
    await dismissStaySignedIn(page)

    // 6. Confirm Microsoft auth cookies are present.
    await waitForMicrosoftAuthCookies(browserContext, page, 45_000)

    console.info(`[teams-login] sign-in successful for ${config.login_email}`)
  } catch (err) {
    if (err instanceof TeamsLoginError) throw err
    const message = err instanceof Error ? err.message : String(err)
    const currentUrl = page.url()
    console.error(`[teams-login] sign-in failed: ${message} (last URL: ${currentUrl})`)
    throw new TeamsLoginError("TEAMS_LOGIN_FAILED_TIMEOUT", `${message} (last URL: ${currentUrl})`)
  } finally {
    await page.close().catch(() => {})
  }
}

/** One-time fetch of the decrypted credentials for the assigned session. */
async function resolveCredentials(config: TeamsLoginConfig): Promise<ResolvedCredentials> {
  const res = await fetch(config.resolve_url, {
    headers: {
      "x-teams-session-id": config.session_id,
      "ngrok-skip-browser-warning": "true"
    }
  })
  if (!res.ok) {
    throw new TeamsLoginError(
      "TEAMS_LOGIN_FAILED_TIMEOUT",
      `resolve-session endpoint returned ${res.status} — session may be expired or invalid`
    )
  }
  const body = (await res.json()) as { email?: string; password?: string }
  if (!body.email || !body.password) {
    throw new TeamsLoginError("TEAMS_LOGIN_FAILED_TIMEOUT", "resolve-session returned no credentials")
  }
  return { email: body.email, password: body.password }
}

/** Click the primary submit button (Microsoft uses #idSIButton9) or a labelled fallback. */
async function clickPrimary(page: Page, labels: string[]): Promise<void> {
  const labelSelector = labels.map((l) => `button:has-text("${l}")`).join(", ")
  await page
    .locator(`#idSIButton9, input[type="submit"], ${labelSelector}`)
    .first()
    .click({ timeout: 10_000 })
}

/** Classify a login failure from the current page (bad creds, captcha, MFA). */
async function detectLoginError(page: Page): Promise<void> {
  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "")

  if (
    /your account or password is incorrect|that account doesn't exist|password is incorrect|couldn't (?:find|verify) your account/i.test(
      bodyText
    )
  ) {
    throw new TeamsLoginError(
      "TEAMS_LOGIN_FAILED_INVALID_CREDENTIALS",
      "Microsoft rejected the account email/password. Update the teams_login credentials."
    )
  }

  const captchaPresent = await page
    .locator('iframe[src*="hip"], iframe[title*="captcha" i], #arkoseFrame, [data-testid*="captcha" i]')
    .first()
    .isVisible()
    .catch(() => false)
  if (captchaPresent) {
    throw new TeamsLoginError(
      "TEAMS_LOGIN_FAILED_CAPTCHA",
      "Microsoft presented a captcha the bot cannot auto-solve. Provision the account so it is not challenged, or wire a captcha solver."
    )
  }

  if (/verify your identity|enter (?:the )?code|approve.*request|authenticator app/i.test(bodyText)) {
    throw new TeamsLoginError(
      "TEAMS_LOGIN_FAILED_MFA_REQUIRED",
      "Microsoft requested MFA/identity verification. The bot account must be provisioned without MFA."
    )
  }
}

/** "Stay signed in?" speedbump — click Yes so the session cookies persist. */
async function dismissStaySignedIn(page: Page): Promise<void> {
  try {
    const bodyText = await page
      .locator("body")
      .innerText()
      .catch(() => "")
    if (!/stay signed in|kmsi/i.test(bodyText)) return
    await page
      .locator('#idSIButton9, button:has-text("Yes")')
      .first()
      .click({ timeout: 8_000 })
  } catch {
    // Non-fatal.
  }
}

async function waitForMicrosoftAuthCookies(
  browserContext: BrowserContext,
  page: Page,
  timeoutMs: number
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    // Re-check for a decisive failure so we don't silently wait out the full timeout.
    await detectLoginError(page)

    const cookies = await browserContext.cookies([
      "https://login.microsoftonline.com",
      "https://teams.microsoft.com"
    ])
    const present = new Set(cookies.map((c) => c.name))
    for (const name of MICROSOFT_AUTH_COOKIE_NAMES) {
      if (present.has(name)) return
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  throw new TeamsLoginError(
    "TEAMS_LOGIN_FAILED_TIMEOUT",
    `Microsoft auth cookies did not appear within ${timeoutMs}ms — sign-in likely failed`
  )
}
