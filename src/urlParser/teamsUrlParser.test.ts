import { parseMeetingUrlFromJoinInfos } from "./teamsUrlParser"

describe("Teams URL Parser", () => {
  describe("Standard Teams Microsoft URLs", () => {
    const standardUrls = [
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_MjM0OTEwZmEtMGU1Yi00MjA4LTgwNmUtZDUzYWY3YWE2MmZj%40thread.v2/0?context=%7b%22Tid%22%3a%228dd08955-18a8-4cd7-8017-5f997f4d47af%22%2c%22Oid%22%3a%220fab73dc-0c6c-4780-9032-1c19b5a545c3%22%7d",
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_OWIwY2ZhYzQtMGVjMC00ZTE4LTgwMzctMDU0MzBmMzg2ZDJl%40thread.v2/0?context=%7b%22Tid%22%3a%228dd08955-18a8-4cd7-8017-5f997f4d47af%22%7d",
      "https://teams.microsoft.com/l/meetup-join/19:meeting_MDYyNDgzMmQtODg2Ni00MjBmLTk4YTAtZjYwMTQ0MGNiMmNl@thread.v2/0?context=%7B%22Tid%22:%222dbdd394-741d-4914-9993-ea4584a95749%22%7D"
    ]

    test.each(standardUrls)("should parse standard Teams URL: %s", (url) => {
      const result = parseMeetingUrlFromJoinInfos(url)
      expect(result.meetingId).toBe(url + "&anon=true")
      expect(result.password).toBe("")
    })
  })

  describe("Teams urls standard", () => {
    const standardUrls = [
      "https://teams.microsoft.com/l/meetup-join/19%3aalTrvfJlXitdMLLxjio8rfnHDhKWaZ3_M-EwK5ewWHg1%40thread.tacv2/1740503107049?context=%7b%22Tid%22%3a%221eba988e-f725-4323-976e-38aaba6ee3a3%22%2c%22Oid%22%3a%222f8f4d50-3e1b-41ea-99fe-4361ba60ada5%22%7d"
    ]

    test.each(standardUrls)("should parse Teams Live URL: %s", (url) => {
      const result = parseMeetingUrlFromJoinInfos(url)
      expect(result.meetingId).toBe(url + (url.includes("?") ? "&" : "?") + "anon=true")
      expect(result.password).toBe("")
    })
  })

  describe("Teams Live URLs", () => {
    const liveUrls = [
      "https://teams.live.com/meet/9356969621606?p=08ogAWeCL73fVssuEK",
      "https://teams.live.com/meet/9339528342593?p=VGZGxvTVLIyZ81WauE",
      "https://teams.live.com/meet/9314184555833?p=00ewkGrA1OJD7Id1NR"
    ]

    test.each(liveUrls)("should parse Teams Live URL: %s", (url) => {
      const result = parseMeetingUrlFromJoinInfos(url)
      expect(result.meetingId).toBe(url)
      expect(result.password).toBe(new URL(url).searchParams.get("p"))
    })
  })

  describe("Teams Microsoft URLs with Query Parameters", () => {
    const urlsWithParams = [
      "https://teams.microsoft.com/l/meetup-join/19:meeting_123@thread.v2/0?context=123",
      "https://teams.microsoft.com/l/meetup-join/19:meeting_456@thread.v2/0?param=value"
    ]

    test.each(urlsWithParams)("should parse URL with params: %s", (url) => {
      const result = parseMeetingUrlFromJoinInfos(url)
      expect(result.meetingId).toBe(`${url}&anon=true`)
      expect(result.password).toBe("")
    })
  })

  describe("Teams Launcher URLs", () => {
    const launcherUrls = [
      "https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fl%2Fmeetup-join%2F19%3Ameeting_YTQxZDliNzQtYzlmMS00OTZhLWE1MzQtNDUzYjhjYzU1ZTVk%40thread.v2%2F0%3Fcontext%3D%257b%2522Tid%2522%253a%25220deb691f-902d-4dea-8026-5a790862fede%2522%252c%2522Oid%2522%253a%25222d56fa49-dfef-4eca-82e9-5b2802766c02%2522%257d%26anon%3Dtrue",
      "https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fl%2Fmeetup-join%2F19%3Ameeting_OWQxZDc4MzYtN2NhMC00MjZkLWI5NmEtYWZkMmNjNjQ1Y2Rm%40thread.v2%2F0%3Fcontext"
    ]

    test.each(launcherUrls)("should parse Teams Launcher URL: %s", (url) => {
      const result = parseMeetingUrlFromJoinInfos(url)
      expect(result.meetingId).toBe(url + (url.includes("?") ? "&" : "?") + "anon=true")
      expect(result.password).toBe("")
    })
  })

  describe("Teams Launcher URLs", () => {
    const launcherUrls = [
      "https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fl%2Fmeetup-join%2F19%3Ameeting_YTQxZDliNzQtYzlmMS00OTZhLWE1MzQtNDUzYjhjYzU1ZTVk%40thread.v2%2F0%3Fcontext%3D%257b%2522Tid%2522%253a%25220deb691f-902d-4dea-8026-5a790862fede%2522%252c%2522Oid%2522%253a%25222d56fa49-dfef-4eca-82e9-5b2802766c02%2522%257d%26anon%3Dtrue",
      "https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fl%2Fmeetup-join%2F19%3Ameeting_OWQxZDc4MzYtN2NhMC00MjZkLWI5NmEtYWZkMmNjNjQ1Y2Rm%40thread.v2%2F0%3Fcontext"
    ]

    test.each(launcherUrls)("should parse Teams Launcher URL: %s", (url) => {
      const result = parseMeetingUrlFromJoinInfos(url)
      expect(result.meetingId).toBe(url + "&anon=true")
      expect(result.password).toBe("")
    })
  })

  describe("Teams TACV2 URLs", () => {
    const tacv2Urls = [
      "https://teams.microsoft.com/l/meetup-join/19:alTrvfJlXitdMLLxjio8rfnHDhKWaZ3_M-EwK5ewWHg1@thread.tacv2/1730831739131?context=%7B%22Tid%22:%221eba988e-f725-4323-976e-38aaba6ee3a3%22%7D",
      "https://teams.microsoft.com/l/meetup-join/19:alTrvfJlXitdMLLxjio8rfnHDhKWaZ3_M-EwK5ewWHg1@thread.tacv2/1731342990116?context=%7BTid:1eba988e-f725-4323-976e-38aaba6ee3a3,Oid:2f8f4d50-3e1b-41ea-99fe-4361ba60ada5%7D"
    ]

    test.each(tacv2Urls)("should parse TACV2 URL: %s", (url) => {
      const result = parseMeetingUrlFromJoinInfos(url)
      expect(result.meetingId).toBe(url + "&anon=true")
      expect(result.password).toBe("")
    })
  })

  describe("Teams URLs with Custom Subdomains", () => {
    const subdomainUrls = [
      "https://us02web.teams.microsoft.com/l/meetup-join/19:meeting_123@thread.v2/0",
      "https://us06web.teams.microsoft.com/l/meetup-join/19:meeting_456@thread.v2/0"
    ]

    test.each(subdomainUrls)("should parse subdomain URL: %s", (url) => {
      const result = parseMeetingUrlFromJoinInfos(url)
      expect(result.meetingId).toBe(`${url}?anon=true`)
      expect(result.password).toBe("")
    })
  })

  describe("Invalid URLs", () => {
    const invalidUrls = [
      "https://not-teams.com/meeting",
      "https://teams.zoom.us/j/123456",
      "not-a-url",
      "https://teams.com/invalid-format",
      ""
    ]

    test.each(invalidUrls)("should reject invalid URL: %s", (url) => {
      expect(() => {
        parseMeetingUrlFromJoinInfos(url)
      }).toThrow("Invalid Teams URL")
    })
  })

  describe("Encoded URLs", () => {
    const encodedUrls = [
      encodeURI("https://teams.microsoft.com/l/meetup-join/19:meeting_123@thread.v2/0"),
      encodeURIComponent("https://teams.microsoft.com/l/meetup-join/19:meeting_456@thread.v2/0")
    ]

    test.each(encodedUrls)("should handle encoded URL: %s", (url) => {
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

    test.each(googleUrls)("should handle Google redirect URL: %s", (url) => {
      const result = parseMeetingUrlFromJoinInfos(url)
      expect(result).toBeDefined()
      expect(result.password).toBe("")
    })
  })
})
