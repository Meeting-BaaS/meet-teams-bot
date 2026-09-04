import { parseMeetingUrlFromJoinInfos } from "./teamsUrlParser"

// The parser consults GLOBAL to decide whether to append anon=true. With no
// meeting configured GLOBAL.get() throws, transformTeamsLink swallows it and
// returns the URL untransformed — so without this mock every assertion below
// silently tested the error path instead of the parser.
let mockTeamsLoginConfig: unknown = null
jest.mock("../singleton", () => ({
  GLOBAL: {
    get: () => ({ teams_login_config: mockTeamsLoginConfig }),
    setError: jest.fn()
  }
}))

const V2_PREFIX = "https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/"

beforeEach(() => {
  mockTeamsLoginConfig = null // anonymous bot unless a test says otherwise
})

describe("Teams URL Parser", () => {
  describe("Standard Teams Microsoft URLs", () => {
    const standardUrls = [
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_MjM0OTEwZmEtMGU1Yi00MjA4LTgwNmUtZDUzYWY3YWE2MmZj%40thread.v2/0?context=%7b%22Tid%22%3a%228dd08955-18a8-4cd7-8017-5f997f4d47af%22%2c%22Oid%22%3a%220fab73dc-0c6c-4780-9032-1c19b5a545c3%22%7d",
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_OWIwY2ZhYzQtMGVjMC00ZTE4LTgwMzctMDU0MzBmMzg2ZDJl%40thread.v2/0?context=%7b%22Tid%22%3a%228dd08955-18a8-4cd7-8017-5f997f4d47af%22%7d",
      "https://teams.microsoft.com/l/meetup-join/19:meeting_MDYyNDgzMmQtODg2Ni00MjBmLTk4YTAtZjYwMTQ0MGNiMmNl@thread.v2/0?context=%7B%22Tid%22:%222dbdd394-741d-4914-9993-ea4584a95749%22%7D"
    ]

    test.each(standardUrls)("rewrites to the v2 join format: %s", (url) => {
      const result = parseMeetingUrlFromJoinInfos(url)
      const threadId = url.split("/l/meetup-join/")[1].split("/")[0]

      expect(result.meetingId.startsWith(V2_PREFIX)).toBe(true)
      expect(result.meetingId).toContain(threadId)
      expect(result.meetingId.endsWith("&anon=true")).toBe(true)
      expect(result.password).toBe("")
    })
  })

  describe("Authenticated bots", () => {
    const url =
      "https://teams.microsoft.com/l/meetup-join/19:meeting_123@thread.v2/0?context=123"

    test("omits anon=true so the bot joins as the signed-in user", () => {
      mockTeamsLoginConfig = { email: "bot@example.com" }
      const result = parseMeetingUrlFromJoinInfos(url)

      expect(result.meetingId.startsWith(V2_PREFIX)).toBe(true)
      expect(result.meetingId).not.toContain("anon=true")
    })

    test("appends anon=true for anonymous bots", () => {
      const result = parseMeetingUrlFromJoinInfos(url)
      expect(result.meetingId.endsWith("&anon=true")).toBe(true)
    })
  })

  describe("Teams TACV2 URLs", () => {
    const tacv2Urls = [
      "https://teams.microsoft.com/l/meetup-join/19%3aalTrvfJlXitdMLLxjio8rfnHDhKWaZ3_M-EwK5ewWHg1%40thread.tacv2/1740503107049?context=%7b%22Tid%22%3a%221eba988e-f725-4323-976e-38aaba6ee3a3%22%2c%22Oid%22%3a%222f8f4d50-3e1b-41ea-99fe-4361ba60ada5%22%7d",
      "https://teams.microsoft.com/l/meetup-join/19:alTrvfJlXitdMLLxjio8rfnHDhKWaZ3_M-EwK5ewWHg1@thread.tacv2/1730831739131?context=%7B%22Tid%22:%221eba988e-f725-4323-976e-38aaba6ee3a3%22%7D",
      "https://teams.microsoft.com/l/meetup-join/19:alTrvfJlXitdMLLxjio8rfnHDhKWaZ3_M-EwK5ewWHg1@thread.tacv2/1731342990116?context=%7BTid:1eba988e-f725-4323-976e-38aaba6ee3a3,Oid:2f8f4d50-3e1b-41ea-99fe-4361ba60ada5%7D"
    ]

    test.each(tacv2Urls)("rewrites to the v2 join format: %s", (url) => {
      const result = parseMeetingUrlFromJoinInfos(url)
      expect(result.meetingId.startsWith(V2_PREFIX)).toBe(true)
      expect(result.meetingId.endsWith("&anon=true")).toBe(true)
      expect(result.password).toBe("")
    })
  })

  describe("Teams Live URLs", () => {
    const liveUrls = [
      "https://teams.live.com/meet/9356969621606?p=08ogAWeCL73fVssuEK",
      "https://teams.live.com/meet/9339528342593?p=VGZGxvTVLIyZ81WauE",
      "https://teams.live.com/meet/9314184555833?p=00ewkGrA1OJD7Id1NR"
    ]

    test.each(liveUrls)("passes through with its passcode: %s", (url) => {
      const result = parseMeetingUrlFromJoinInfos(url)
      expect(result.meetingId).toBe(url)
      expect(result.password).toBe(new URL(url).searchParams.get("p"))
    })
  })

  // Anything the meetup-join rewrite cannot parse is handed to Teams untouched,
  // which is the safe default: the page itself still resolves these.
  describe("URLs passed through unchanged", () => {
    const passthroughUrls = [
      // no ?context= for the rewrite regex to anchor on
      "https://teams.microsoft.com/l/meetup-join/19:meeting_456@thread.v2/0?param=value",
      // launcher shell, not a meetup-join link
      "https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fl%2Fmeetup-join%2F19%3Ameeting_OWQxZDc4MzYtN2NhMC00MjZkLWI5NmEtYWZkMmNjNjQ1Y2Rm%40thread.v2%2F0%3Fcontext",
      // custom subdomain — the rewrite is anchored to bare teams.microsoft.com
      "https://us02web.teams.microsoft.com/l/meetup-join/19:meeting_123@thread.v2/0",
      "https://us06web.teams.microsoft.com/l/meetup-join/19:meeting_456@thread.v2/0"
    ]

    test.each(passthroughUrls)("leaves the URL alone: %s", (url) => {
      const result = parseMeetingUrlFromJoinInfos(url)
      expect(result.meetingId).toBe(url)
      expect(result.password).toBe("")
    })
  })

  describe("Invalid URLs", () => {
    const invalidUrls = [
      { url: "https://not-teams.com/meeting", error: "Invalid Teams URL" },
      { url: "https://teams.zoom.us/j/123456", error: "Invalid Teams URL" },
      { url: "https://teams.com/invalid-format", error: "Invalid Teams URL" },
      { url: "not-a-url", error: "Invalid URL" },
      { url: "", error: "No meeting URL provided" }
    ]

    test.each(invalidUrls)("rejects $url", ({ url, error }) => {
      expect(() => parseMeetingUrlFromJoinInfos(url)).toThrow(error)
    })
  })

  describe("Encoded URLs", () => {
    const encodedUrls = [
      encodeURI("https://teams.microsoft.com/l/meetup-join/19:meeting_123@thread.v2/0"),
      encodeURIComponent("https://teams.microsoft.com/l/meetup-join/19:meeting_456@thread.v2/0")
    ]

    test.each(encodedUrls)("handles encoded URL: %s", (url) => {
      const result = parseMeetingUrlFromJoinInfos(url)
      expect(result).toBeDefined()
      expect(result.password).toBe("")
    })
  })

  describe("Google Redirect URLs", () => {
    const googleUrls = [
      "https://www.google.com/url?q=https://teams.microsoft.com/l/meetup-join/19%3ameeting_OTUzODNjNmEtNjIwMC00MzkxLWExYjktNWMyMDY2NTE3Yzhk%40thread.v2/0",
      "https://www.google.com/url?q=https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjVhZDgyYjQtZDE2NC00ZDI4LWI3Y2EtN2Y4Zjg3ODQwNzc2%40thread.v2/0"
    ]

    test.each(googleUrls)("unwraps the redirect: %s", (url) => {
      const result = parseMeetingUrlFromJoinInfos(url)
      expect(result).toBeDefined()
      expect(result.password).toBe("")
    })
  })

  // Teams is recognized by URL shape, not by a hostname list: sovereign and
  // national partner clouds (teams.sovcloud.fr) and the unified Microsoft 365
  // domain run the same client on their own origin, and every rewrite has to
  // stay on that origin.
  describe("Other Teams clouds", () => {
    test.each([
      "https://teams.sovcloud.fr/meet/1234567890",
      "https://teams.cloud.microsoft/meet/1234567890",
      "https://teams.some-future-cloud.example/meet/1234567890"
    ])("passes a short join code through unchanged: %s", (url) => {
      const result = parseMeetingUrlFromJoinInfos(url)
      expect(result.meetingId).toBe(url)
    })

    test("rewrites a deep link onto its OWN origin, not teams.microsoft.com", () => {
      const url =
        "https://teams.sovcloud.fr/l/meetup-join/19:meeting_123@thread.v2/0?context=%7B%22Tid%22%3A%22abc%22%7D"
      const result = parseMeetingUrlFromJoinInfos(url)

      expect(result.meetingId.startsWith("https://teams.sovcloud.fr/v2/?meetingjoin=true#/")).toBe(
        true
      )
      expect(result.meetingId).not.toContain("teams.microsoft.com")
      expect(result.meetingId.endsWith("&anon=true")).toBe(true)
    })

    test("keeps the passcode from the query string", () => {
      const result = parseMeetingUrlFromJoinInfos("https://teams.sovcloud.fr/meet/123?p=secret")
      expect(result.password).toBe("secret")
    })

    test("accepts a deep link on a host that does not say teams at all", () => {
      const url = "https://meetings.example.gov/l/meetup-join/19:meeting_9@thread.v2/0"
      expect(parseMeetingUrlFromJoinInfos(url).meetingId).toBe(url)
    })
  })

  describe("SafeLinks-wrapped URLs", () => {
    test("unwraps the Outlook rewrite before parsing", () => {
      const inner = "https://teams.sovcloud.fr/meet/1234567890"
      const wrapped = `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent(inner)}&data=05%7C01`
      expect(parseMeetingUrlFromJoinInfos(wrapped).meetingId).toBe(inner)
    })
  })
})
