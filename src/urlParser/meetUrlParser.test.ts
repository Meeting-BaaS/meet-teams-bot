import { parseMeetingUrlFromJoinInfos } from "./meetUrlParser"

describe("Meet URL Parser", () => {
  describe("Valid URLs", () => {
    const validUrls = [
      {
        name: "standard Meet URL",
        url: "https://meet.google.com/abc-defg-hij",
        expected: {
          meetingId: "https://meet.google.com/abc-defg-hij",
          password: ""
        }
      },
      {
        name: "Meet URL with query parameters",
        url: "https://meet.google.com/abc-defg-hij?authuser=0",
        expected: {
          meetingId: "https://meet.google.com/abc-defg-hij?authuser=0",
          password: ""
        }
      },
      {
        name: "Meet URL without https",
        url: "meet.google.com/abc-defg-hij",
        expected: {
          meetingId: "https://meet.google.com/abc-defg-hij",
          password: ""
        }
      },
      {
        name: "Meet URL with multiple query parameters",
        url: "https://meet.google.com/abc-defg-hij?authuser=0&hs=178",
        expected: {
          meetingId: "https://meet.google.com/abc-defg-hij?authuser=0&hs=178",
          password: ""
        }
      },
      {
        name: "Meet URL with www subdomain",
        url: "https://www.meet.google.com/abc-defg-hij",
        expected: {
          meetingId: "https://meet.google.com/abc-defg-hij",
          password: ""
        }
      },
      {
        name: "Meet URL with special characters in query params",
        url: "https://meet.google.com/abc-defg-hij?authuser=test%40gmail.com",
        expected: {
          meetingId: "https://meet.google.com/abc-defg-hij?authuser=test%40gmail.com",
          password: ""
        }
      },
      {
        name: "Meet URL with multiple query parameters",
        url: "https://meet.google.com/abc-defg-hij?authuser=0&hs=178",
        expected: {
          meetingId: "https://meet.google.com/abc-defg-hij?authuser=0&hs=178",
          password: ""
        }
      },
      {
        name: "Meet URL with encoded characters in query",
        url: "https://meet.google.com/abc-defg-hij?authuser=test%40gmail.com",
        expected: {
          meetingId: "https://meet.google.com/abc-defg-hij?authuser=test%40gmail.com",
          password: ""
        }
      },
      {
        name: "Meet URL with accidental prefix",
        url: "jhttps://meet.google.com/abc-defg-hij",
        expected: {
          meetingId: "https://meet.google.com/abc-defg-hij",
          password: ""
        }
      },
      {
        name: "Meet URL with quotes",
        url: '"https://meet.google.com/abc-defg-hij"',
        expected: {
          meetingId: "https://meet.google.com/abc-defg-hij",
          password: ""
        }
      }
    ]

    test.each(validUrls)("should parse $name correctly", async ({ url, expected }) => {
      const result = await parseMeetingUrlFromJoinInfos(url)
      expect(result).toEqual(expected)
    })
  })

  describe("Invalid URLs", () => {
    // The parser distinguishes two rejection reasons, and the message matters
    // because they mean different things operationally: nothing that looks like
    // a Meet link at all, versus a Meet link whose code is malformed.
    const invalidUrls = [
      {
        name: "empty URL",
        url: "",
        error: "No Google Meet URL found"
      },
      {
        name: "wrong domain",
        url: "https://google.com/abc-defg-hij",
        error: "No Google Meet URL found"
      },
      {
        name: "invalid code format",
        url: "https://meet.google.com/abcd-efgh-ijkl",
        error: "Invalid Google Meet URL format"
      },
      {
        name: "missing code parts",
        url: "https://meet.google.com/abc-defg",
        error: "Invalid Google Meet URL format"
      },
      {
        name: "invalid characters in code",
        url: "https://meet.google.com/123-4567-890",
        error: "Invalid Google Meet URL format"
      }
    ]

    test.each(invalidUrls)("should reject $name", async ({ url, error }) => {
      await expect(parseMeetingUrlFromJoinInfos(url)).rejects.toThrow(error)
    })
  })
})
