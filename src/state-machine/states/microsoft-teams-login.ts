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
    await logLoginState(page, "1-login-loaded")

    // 2. Email -> Next
    const emailInput = page.locator('input[type="email"], input[name="loginfmt"]').first()
    await emailInput.waitFor({ state: "visible", timeout: 15_000 })
    await emailInput.fill(email)
    await clickPrimary(page, ["Next"])
    await page.waitForTimeout(1_500)
    await logLoginState(page, "2-after-email-next")

    // 3. Password -> Sign in
    const passwordInput = page.locator('input[type="password"], input[name="passwd"]').first()
    await passwordInput.waitFor({ state: "visible", timeout: 20_000 })
    await passwordInput.fill(password)
    await clickPrimary(page, ["Sign in", "Sign In"])

    // 4. Give the response a moment, then classify credential / captcha / MFA errors.
    await page.waitForTimeout(2_000)
    await logLoginState(page, "3-after-signin")
    await detectLoginError(page)

    // 5. "Stay signed in?" (KMSI) — click Yes so the session persists.
    await dismissStaySignedIn(page)

    // 6. Confirm Microsoft auth cookies are present.
    await waitForMicrosoftAuthCookies(browserContext, page, 45_000)

    // Sign-in itself is DONE here (identity cookies present). Everything below is a
    // best-effort warm-up of the Teams v2 app session and MUST NOT fail the login.
    console.info(`[teams-login] sign-in successful for ${config.login_email}`)

    // 7. Bootstrap the Teams v2 (MSAL) app session — NON-FATAL. teams.microsoft.com
    // does a silent-SSO handoff via /v2/authv2 that stores MSAL tokens in localStorage;
    // warming it here means the later /meet/<code> join is authenticated instead of
    // anonymous. Wrapped in try/catch so a bootstrap failure never fails the sign-in.
    // Note: right after "Sign in"/KMSI the page is still auto-redirecting toward
    // m365.cloud.microsoft (OfficeHome); issuing page.goto() mid-redirect aborts with
    // net::ERR_ABORTED, so we settle first and retry on abort.
    try {
      console.info(`[teams-login] bootstrap: post-signin URL = ${page.url()}`)
      let navigated = false
      for (let attempt = 1; attempt <= 3 && !navigated; attempt++) {
        // Let the in-flight post-sign-in redirect chain settle before we navigate.
        await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {})
        console.info(
          `[teams-login] bootstrap: nav attempt ${attempt}, settled URL = ${page.url()}`
        )
        try {
          await page.goto("https://teams.microsoft.com/", {
            waitUntil: "domcontentloaded",
            timeout: 30_000
          })
          navigated = true
          console.info(`[teams-login] bootstrap: reached teams.com, URL = ${page.url()}`)
        } catch (navErr) {
          const m = navErr instanceof Error ? navErr.message : String(navErr)
          console.warn(`[teams-login] bootstrap: nav attempt ${attempt} failed — ${m}`)
          await page.waitForTimeout(2_000)
        }
      }
      if (navigated) {
        await settleTeamsAuth(browserContext, page, config, 30_000)
      } else {
        console.warn("[teams-login] bootstrap: could not reach teams.com after 3 attempts")
      }
    } catch (bootstrapErr) {
      const m = bootstrapErr instanceof Error ? bootstrapErr.message : String(bootstrapErr)
      console.warn(
        `[teams-login] Teams session bootstrap failed (non-fatal, sign-in still OK): ${m}`
      )
    }
  } catch (err) {
    // On failure, close the login page. On SUCCESS we deliberately DO NOT close it —
    // the meeting join reuses this authenticated page (see openMeetingPage) so it
    // inherits the live MSAL session instead of re-authenticating on a fresh page
    // (which loses the race and lands on the anonymous /light-meetings launcher).
    const currentUrl = page.url()
    await page.close().catch(() => {})
    if (err instanceof TeamsLoginError) throw err
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[teams-login] sign-in failed: ${message} (last URL: ${currentUrl})`)
    throw new TeamsLoginError("TEAMS_LOGIN_FAILED_TIMEOUT", `${message} (last URL: ${currentUrl})`)
  }
}

/** One-time fetch of the decrypted credentials for the assigned session. */
async function logLoginState(page: Page, label: string): Promise<void> {
  try {
    const info = await page.evaluate(() => {
      const clip = (s: string | null | undefined): string =>
        (s || "").replace(/\s+/g, " ").trim().slice(0, 70)
      const inputs = Array.from(document.querySelectorAll("input")).map(
        (i) => `${i.type || "?"}${i.name ? `[${i.name}]` : ""}${i.placeholder ? `(${i.placeholder})` : ""}`
      )
      const buttons = Array.from(document.querySelectorAll("button, input[type=submit]"))
        .map((b) =>
          clip((b as HTMLInputElement).value || b.textContent || b.getAttribute("aria-label"))
        )
        .filter((t) => t.length > 0)
        .slice(0, 8)
      const heading = clip(
        document.querySelector("h1, [role=heading], #loginHeader, .row-title")?.textContent
      )
      const errorEl = document.querySelector(
        '[role="alert"], .alert-error, #passwordError, [id*="error" i]'
      )
      return { title: document.title, heading, inputs, buttons, error: clip(errorEl?.textContent) }
    })
    console.info(`[teams-login][ui] ${label} url=${page.url()}`)
    console.info(
      `[teams-login][ui] ${label} title=${JSON.stringify(info.title)} heading=${JSON.stringify(info.heading)}`
    )
    console.info(
      `[teams-login][ui] ${label} inputs=${JSON.stringify(info.inputs)} buttons=${JSON.stringify(info.buttons)}`
    )
    if (info.error) console.info(`[teams-login][ui] ${label} error=${JSON.stringify(info.error)}`)
  } catch (e) {
    console.warn(`[teams-login][ui] ${label} failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function resolveCredentials(config: TeamsLoginConfig): Promise<ResolvedCredentials> {
  // LOCAL TESTING ONLY: if TEAMS_LOGIN_LOCAL_PASSWORD is set, skip the api-server
  // resolve-session fetch and sign in with login_email + this password directly.
  // Lets `run_bot.sh` drive an authenticated Teams bot without api-server/SQS.
  // NEVER set this in a deployed environment.
  const localPassword = process.env.TEAMS_LOGIN_LOCAL_PASSWORD
  if (localPassword) {
    console.warn(
      `[teams-login] TEAMS_LOGIN_LOCAL_PASSWORD set — LOCAL TEST MODE, using it for ${config.login_email} (skipping resolve-session)`
    )
    return { email: config.login_email, password: localPassword }
  }

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
  // DIAG: log the decrypted password LENGTH (never the value). If this does not match
  // the real password's length, the stored secret was encrypted under a different
  // TEAMS_LOGIN_ENCRYPTION_SECRET than this api-server decrypts with.
  console.info(
    `[teams-login] resolved credentials for ${body.email} (password length=${body.password.length})`
  )
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

/**
 * Wait for the Teams v2 (MSAL) silent-SSO handoff to complete after navigating to
 * teams.microsoft.com. Teams v2 keeps tokens in localStorage; the observable signals
 * are (a) the URL leaving the /v2/authv2 auth endpoint into the app, and (b) the
 * MSAL cookies (msal.cache.encryption / ringFinder) appearing. While waiting we
 * best-effort clear a "Stay signed in?" prompt and click our own account tile if an
 * account picker stalls /authv2. Non-fatal: if it doesn't settle we warn and proceed
 * (the meeting may then join anonymously per the fallback config).
 */
async function settleTeamsAuth(
  browserContext: BrowserContext,
  page: Page,
  config: TeamsLoginConfig,
  timeoutMs: number
): Promise<void> {
  // The signed-in app no longer lives only on teams.microsoft.com: the ocdiRedirect
  // migration bounces it to teams.cloud.microsoft. Match EVERY teams host — hardcoding
  // teams.microsoft.com made this loop wait forever on the new domain (observed: 60s
  // stuck on teams.cloud.microsoft/, authtoken never "seen" because it lived elsewhere).
  const TEAMS_APP_HOST = /(teams\.microsoft\.com|teams\.cloud\.microsoft|teams\.live\.com)/i
  const ON_AUTH = /\/authv2|login\.microsoftonline\.com|login\.live\.com/i
  const isTeamsCookieDomain = (domain: string): boolean =>
    /(teams\.microsoft\.com|teams\.cloud\.microsoft|cloud\.microsoft|teams\.live\.com)/i.test(domain)

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const url = page.url()
    const onAuthEndpoint = ON_AUTH.test(url)
    const onTeamsApp = TEAMS_APP_HOST.test(url) && !onAuthEndpoint
    const cookies = await browserContext.cookies()
    const teamsCookies = cookies.filter((c) => isTeamsCookieDomain(c.domain))
    const names = teamsCookies.map((c) => c.name)
    const hasAuthToken = names.includes("authtoken")
    const hasRingFinder = names.includes("ringFinder")
    console.info(
      `[teams-login][settle] t=${Math.round((Date.now() - start) / 1000)}s url=${url} ` +
        `onApp=${onTeamsApp} hasAuthToken=${hasAuthToken} hasRingFinder=${hasRingFinder} ` +
        `teamsCookies=[${names.join(", ")}]`
    )
    // Go the INSTANT the Teams identity is established — `ringFinder` carries the
    // signed-in oid/tid, `authtoken` is the full service token — as long as we're on
    // the Teams app (off the auth endpoints). We deliberately DON'T wait for the home
    // page to finish loading/settling: we navigate straight to the meeting next, so
    // any extra home-page time is pure latency the user sees as "stuck after sign-in".
    // The meeting page does its own silent SSO from the identity cookies set at sign-in.
    if ((hasAuthToken || hasRingFinder) && onTeamsApp) {
      console.info(
        `[teams-login] Teams identity established (${hasAuthToken ? "authtoken" : "ringFinder"}) — ` +
          "handing off to meeting join"
      )
      return
    }

    // Best-effort: progress an account picker or KMSI that can stall /authv2.
    await dismissStaySignedIn(page).catch(() => {})
    try {
      const tile = page
        .locator(
          `[aria-label*="${config.login_email}"], div[role="button"]:has-text("${config.login_email}")`
        )
        .first()
      if (await tile.isVisible({ timeout: 300 }).catch(() => false)) {
        console.info("[teams-login] account picker on /authv2 — selecting our account")
        await tile.click({ timeout: 2_000 }).catch(() => {})
      }
    } catch (_e) {
      /* no picker present */
    }

    await new Promise((r) => setTimeout(r, 500))
  }
  console.warn(
    `[teams-login] session did not fully settle within ${timeoutMs}ms — ` +
      "proceeding to the meeting join anyway (may fall back to anonymous)"
  )
}
