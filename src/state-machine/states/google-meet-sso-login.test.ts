/**
 * Google Meet SSO login — entry-point and diagnostics tests.
 *
 * Regression context: the flow used to enter via AccountChooser?hd=<domain>. With an
 * empty cookie jar (a freshly added meet_login whose server-side cookie cache is still
 * empty) Google has no account to choose and bounces to www.google.com. The old
 * landing-page check read that as "SSO redirect already fired", skipped typing the
 * email, and then burned the full 45s auth-cookie wait — and every diagnostic sat
 * behind the same check, so the one broken path produced no signal.
 *
 * Playwright is faked: a scripted router maps each goto() to a landing URL.
 */

import { loginToGoogleMeetWithSso, MeetSsoLoginError, type MeetSsoConfig } from "./google-meet-sso-login"

const LOGIN_EMAIL = "bot1@bots.acme.com"
const DOMAIN = "bots.acme.com"
const SET_COOKIE_URL = "https://api.meetingbaas.com/v2/meet-sso/set-cookie?session_id=abc-123"

const CONFIG: MeetSsoConfig = {
  session_id: "abc-123",
  login_email: LOGIN_EMAIL,
  set_cookie_url: SET_COOKIE_URL,
  fallback: "anonymous"
}

const AUTH_COOKIES = [{ name: "SID", value: "x", domain: ".google.com", path: "/" }]

interface Scenario {
  /** Maps a requested URL to the URL the browser ends up on. */
  route: (requested: string) => string
  /** URL after the Next button is clicked. Defaults to a post-SSO Meet URL. */
  afterNext?: string
  /** Body text served once the email has been submitted. */
  pageTextAfterNext?: string
  passwordVisibleAfterNext?: boolean
  /** Cookies visible to the context. Defaults to the auth cookies (happy path). */
  cookies?: Array<Record<string, unknown>>
  setCookieStatus?: number
}

interface Harness {
  context: any
  gotos: string[]
  filled: string[]
  nextClicks: number
}

function buildHarness(scenario: Scenario): Harness {
  const gotos: string[] = []
  const filled: string[] = []
  let nextClicks = 0
  let currentUrl = "about:blank"
  let submitted = false

  const page: any = {
    setExtraHTTPHeaders: jest.fn(async () => {}),
    url: () => currentUrl,
    goto: jest.fn(async (url: string) => {
      gotos.push(url)
      if (url === SET_COOKIE_URL) {
        currentUrl = url
        const status = scenario.setCookieStatus ?? 200
        return { ok: () => status >= 200 && status < 300, status: () => status }
      }
      currentUrl = scenario.route(url)
      return { ok: () => true, status: () => 200 }
    }),
    waitForFunction: jest.fn(async () => true),
    waitForURL: jest.fn(async () => {
      throw new Error("no samlconfirmaccount")
    }),
    waitForLoadState: jest.fn(async () => {}),
    evaluate: jest.fn(async () => true),
    keyboard: { press: jest.fn(async () => {}) },
    close: jest.fn(async () => {}),
    locator: (selector: string) => {
      const node: any = {
        first: () => node,
        waitFor: jest.fn(async () => {}),
        fill: jest.fn(async (value: string) => {
          filled.push(value)
        }),
        click: jest.fn(async () => {
          nextClicks += 1
          submitted = true
          currentUrl = scenario.afterNext ?? "https://meet.google.com/landing"
        }),
        isVisible: jest.fn(async () =>
          selector.includes("password") ? Boolean(submitted && scenario.passwordVisibleAfterNext) : true
        ),
        innerText: jest.fn(async () => (submitted ? (scenario.pageTextAfterNext ?? "") : ""))
      }
      return node
    }
  }

  const context: any = {
    newPage: jest.fn(async () => page),
    addCookies: jest.fn(async () => {}),
    cookies: jest.fn(async () => scenario.cookies ?? AUTH_COOKIES)
  }

  return {
    context,
    gotos,
    filled,
    get nextClicks() {
      return nextClicks
    }
  } as Harness
}

/** Serves the sign-in form for ServiceLogin, nothing else. */
const serviceLoginWorks = (requested: string) =>
  requested.includes("ServiceLogin")
    ? "https://accounts.google.com/v3/signin/identifier?hd=bots.acme.com"
    : "https://www.google.com/"

beforeEach(() => {
  // injectSavedCookies / persistCookies both go through fetch.
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ cookies: [] })
  })) as unknown as typeof fetch
  jest.spyOn(console, "info").mockImplementation(() => {})
  jest.spyOn(console, "warn").mockImplementation(() => {})
  jest.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("entry point", () => {
  it("hits set-cookie before Google, then enters via ServiceLogin with the domain hint", async () => {
    const h = buildHarness({ route: serviceLoginWorks })

    await loginToGoogleMeetWithSso(h.context, CONFIG)

    expect(h.gotos[0]).toBe(SET_COOKIE_URL)
    expect(h.gotos[1]).toContain("accounts.google.com/ServiceLogin")
    expect(h.gotos[1]).toContain(`hd=${encodeURIComponent(DOMAIN)}`)
    expect(h.filled).toEqual([LOGIN_EMAIL])
  })

  it("falls back to AccountChooser when ServiceLogin bounces", async () => {
    const h = buildHarness({
      route: (requested) =>
        requested.includes("AccountChooser")
          ? "https://accounts.google.com/v3/signin/identifier?hd=bots.acme.com"
          : "https://www.google.com/"
    })

    await loginToGoogleMeetWithSso(h.context, CONFIG)

    expect(h.gotos.some((u) => u.includes("ServiceLogin"))).toBe(true)
    expect(h.gotos.some((u) => u.includes("AccountChooser"))).toBe(true)
    expect(h.filled).toEqual([LOGIN_EMAIL])
  })

  it("REGRESSION: bouncing to www.google.com fails fast instead of waiting for auth cookies", async () => {
    // The empty-cookie-jar case that broke every newly added credential.
    const h = buildHarness({ route: () => "https://www.google.com/", cookies: [] })

    const started = Date.now()
    await expect(loginToGoogleMeetWithSso(h.context, CONFIG)).rejects.toThrow(MeetSsoLoginError)
    const elapsed = Date.now() - started

    // The old code sat in waitForGoogleAuthCookies for 45s here.
    expect(elapsed).toBeLessThan(5_000)
    // And it never typed the email, which is what made the failure unexplainable.
    expect(h.filled).toEqual([])
  })

  it("names the landing URL, the domain and the Admin Console setting", async () => {
    const h = buildHarness({ route: () => "https://www.google.com/", cookies: [] })

    await expect(loginToGoogleMeetWithSso(h.context, CONFIG)).rejects.toThrow(
      /landed on https:\/\/www\.google\.com/
    )

    const h2 = buildHarness({ route: () => "https://www.google.com/", cookies: [] })
    await expect(loginToGoogleMeetWithSso(h2.context, CONFIG)).rejects.toThrow(
      /Manage SSO profile assignments/
    )
  })

  it("skips the email step when the context already holds a live session", async () => {
    const h = buildHarness({ route: () => "https://myaccount.google.com/" })

    await loginToGoogleMeetWithSso(h.context, CONFIG)

    expect(h.filled).toEqual([])
  })

  it("fails fast when set-cookie rejects the session", async () => {
    const h = buildHarness({ route: serviceLoginWorks, setCookieStatus: 404 })

    await expect(loginToGoogleMeetWithSso(h.context, CONFIG)).rejects.toThrow(
      /set-cookie endpoint returned 404/
    )
  })
})

describe("post-submit diagnostics", () => {
  it("reports a password prompt as an SSO assignment problem", async () => {
    const h = buildHarness({
      route: serviceLoginWorks,
      afterNext: "https://accounts.google.com/v3/signin/challenge/pwd",
      passwordVisibleAfterNext: true,
      cookies: []
    })

    await expect(loginToGoogleMeetWithSso(h.context, CONFIG)).rejects.toThrow(
      /password prompt instead of redirecting to SSO/
    )
  })

  it("reports an unknown account by name", async () => {
    const h = buildHarness({
      route: serviceLoginWorks,
      afterNext: "https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn",
      pageTextAfterNext: "Couldn't find your Google Account",
      cookies: []
    })

    await expect(loginToGoogleMeetWithSso(h.context, CONFIG)).rejects.toThrow(
      new RegExp(`could not find the account '${LOGIN_EMAIL}'`)
    )
  })

  it("reports an incomplete Welcome to Workspace flow instead of timing out", async () => {
    const h = buildHarness({
      route: serviceLoginWorks,
      afterNext: "https://accounts.google.com/signin/newfeatures/accountsetup",
      pageTextAfterNext: "Welcome to your new account",
      cookies: []
    })

    await expect(loginToGoogleMeetWithSso(h.context, CONFIG)).rejects.toThrow(
      /has not completed the "Welcome to Google Workspace" flow/
    )
  })

  it("still runs the diagnostics on the path that used to skip them", async () => {
    // ServiceLogin bounces, AccountChooser recovers — the old code treated this
    // whole branch as "SSO already fired" and ran no checks at all.
    const h = buildHarness({
      route: (requested) =>
        requested.includes("AccountChooser")
          ? "https://accounts.google.com/v3/signin/identifier"
          : "https://www.google.com/",
      afterNext: "https://accounts.google.com/v3/signin/challenge/pwd",
      passwordVisibleAfterNext: true,
      cookies: []
    })

    await expect(loginToGoogleMeetWithSso(h.context, CONFIG)).rejects.toThrow(
      /password prompt instead of redirecting to SSO/
    )
  })
})

describe("failure classification", () => {
  it("keeps an explicit diagnostic as TIMEOUT even when parked on an ACS URL", async () => {
    const h = buildHarness({
      route: serviceLoginWorks,
      afterNext: "https://accounts.google.com/a/bots.acme.com/acs",
      pageTextAfterNext: "Couldn't find your Google Account",
      cookies: []
    })

    // The diagnostic throws a MeetSsoLoginError, which is rethrown as-is; the ACS
    // reclassification only applies to non-MeetSsoLoginError failures.
    await expect(loginToGoogleMeetWithSso(h.context, CONFIG)).rejects.toMatchObject({
      code: "MEET_LOGIN_FAILED_TIMEOUT"
    })
  })

  it("classifies a rejected-assertion URL as SAML_REJECTED while waiting for cookies", async () => {
    const h = buildHarness({
      route: serviceLoginWorks,
      afterNext: "https://accounts.google.com/v3/signin/rejected?rrk=21",
      cookies: []
    })

    await expect(loginToGoogleMeetWithSso(h.context, CONFIG)).rejects.toMatchObject({
      code: "MEET_LOGIN_FAILED_SAML_REJECTED"
    })
  })
})
