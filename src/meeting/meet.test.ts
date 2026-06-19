import { MeetingEndReason } from "../state-machine/types"

// ── mock GLOBAL singleton ────────────────────────────────────────
const mockGlobal = {
  setShouldRetry: jest.fn(),
  setError: jest.fn(),
  getEndReason: jest.fn().mockReturnValue(undefined),
  getErrorMessage: jest.fn().mockReturnValue(null),
  get: jest.fn().mockReturnValue({ bot_name: "TestBot", streaming_input: undefined, recording_mode: "speaker_view" }),
  generateClientError: jest.fn(),
  setEndReason: jest.fn(),
}

jest.mock("../singleton", () => ({
  GLOBAL: mockGlobal,
}))

// ── mock meeting-state-detector (prevents module-level createStateDetector call) ─
jest.mock("../utils/meeting-state-detector", () => ({
  createStateDetector: jest.fn().mockReturnValue({
    isDenied: jest.fn().mockResolvedValue({ matched: false, matchedText: null, pattern: null }),
  }),
}))

// ── mock all other module-level dependencies that run at import time ─
jest.mock("../branding", () => ({ brandingReady: false }))
jest.mock("../browser/page-logger", () => ({ listenPage: jest.fn() }))
jest.mock("../services/dialog-observer/simple-dialog-observer", () => ({
  SimpleDialogObserver: { pause: jest.fn(), resume: jest.fn() },
}))
jest.mock("../services/html-snapshot-service", () => ({
  HtmlSnapshotService: { getInstance: jest.fn().mockReturnValue({ captureSnapshot: jest.fn() }) },
}))
jest.mock("../urlParser/meetUrlParser", () => ({
  parseMeetingUrlFromJoinInfos: jest.fn(),
}))
jest.mock("../utils/Logger", () => ({
  formatError: jest.fn((e: any) => e?.message ?? String(e)),
}))
jest.mock("../utils/sleep", () => ({
  sleep: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("./meet/audio-capture", () => ({
  enableMeetAudioCapture: jest.fn(),
}))
jest.mock("./meet/closeMeeting", () => ({
  closeMeeting: jest.fn(),
}))
jest.mock("./meet-state-config", () => ({
  MEET_STATE_CONFIG: { providerName: "Google Meet", denialPatterns: [], waitingRoomPattern: { selectors: [], threshold: 1 }, inMeetingPattern: { selectors: [], threshold: 1 } },
}))

// Import after mocks
import { assertOnMeetPage, MeetProvider } from "./meet"

// ── helpers ──────────────────────────────────────────────────────

function resetMocks() {
  jest.clearAllMocks()
  mockGlobal.getEndReason.mockReturnValue(undefined)
  mockGlobal.getErrorMessage.mockReturnValue(null)
}

function createMockPage(overrides: Partial<{ url: string; content: string; isClosed: boolean }> = {}) {
  return {
    url: jest.fn().mockReturnValue(overrides.url ?? "https://meet.google.com/abc-defg-hij"),
    content: jest.fn().mockResolvedValue(overrides.content ?? "<html></html>"),
    isClosed: jest.fn().mockReturnValue(overrides.isClosed ?? false),
    evaluate: jest.fn().mockResolvedValue("complete"),
  } as any
}

// ══════════════════════════════════════════════════════════════════
// assertOnMeetPage
// ══════════════════════════════════════════════════════════════════

describe("assertOnMeetPage", () => {
  beforeEach(resetMocks)

  describe("when page is on meet.google.com", () => {
    it("does nothing (no error, no throw)", () => {
      const page = createMockPage({ url: "https://meet.google.com/abc-defg-hij" })

      expect(() => assertOnMeetPage(page)).not.toThrow()
      expect(mockGlobal.setError).not.toHaveBeenCalled()
      expect(mockGlobal.setShouldRetry).not.toHaveBeenCalled()
    })
  })

  describe("when page navigated away and wasInMeeting is false", () => {
    it("sets BotNotAccepted error and retry flag, then throws", () => {
      const page = createMockPage({ url: "https://workspace.google.com/" })

      expect(() => assertOnMeetPage(page, false)).toThrow("Page navigated away from Google Meet")
      expect(mockGlobal.setShouldRetry).toHaveBeenCalledWith(true)
      expect(mockGlobal.setError).toHaveBeenCalledWith(
        MeetingEndReason.BotNotAccepted,
        expect.stringContaining("Google Meet denied entry")
      )
    })

    it("defaults wasInMeeting to false when omitted", () => {
      const page = createMockPage({ url: "https://workspace.google.com/" })

      expect(() => assertOnMeetPage(page)).toThrow("Page navigated away from Google Meet")
      expect(mockGlobal.setShouldRetry).toHaveBeenCalledWith(true)
    })
  })

  describe("when page navigated away and wasInMeeting is true", () => {
    it("sets BotRemoved error (normal end) and does NOT set retry flag", () => {
      const page = createMockPage({ url: "https://workspace.google.com/" })

      expect(() => assertOnMeetPage(page, true)).toThrow("Page navigated away from Google Meet")
      expect(mockGlobal.setShouldRetry).not.toHaveBeenCalled()
      expect(mockGlobal.setError).toHaveBeenCalledWith(
        MeetingEndReason.BotRemoved,
        expect.stringContaining("Bot was in meeting but page redirected away")
      )
    })
  })
})

// ══════════════════════════════════════════════════════════════════
// MeetProvider.findEndMeeting — URL fast-path
// ══════════════════════════════════════════════════════════════════

describe("MeetProvider.findEndMeeting", () => {
  let provider: MeetProvider

  beforeEach(() => {
    resetMocks()
    provider = new MeetProvider()
  })

  describe("URL fast-path", () => {
    it("returns true when page has navigated away from meet.google.com", async () => {
      const page = createMockPage({ url: "https://workspace.google.com/dashboard" })

      const result = await provider.findEndMeeting(page)
      expect(result).toBe(true)
      // content should NOT be called — fast-path short-circuits
      expect(page.content).not.toHaveBeenCalled()
    })

    it("returns true when page URL does not contain meet.google.com", async () => {
      const page = createMockPage({ url: "https://accounts.google.com/signin" })

      const result = await provider.findEndMeeting(page)
      expect(result).toBe(true)
    })
  })

  describe("text-based detection (still works after URL fast-path)", () => {
    it("returns true when page content contains 'You've been removed'", async () => {
      const page = createMockPage({
        url: "https://meet.google.com/abc-defg-hij",
        content: "<html><body>You've been removed from the meeting</body></html>",
      })

      const result = await provider.findEndMeeting(page)
      expect(result).toBe(true)
    })

    it("returns true when page content contains 'The call ended'", async () => {
      const page = createMockPage({
        url: "https://meet.google.com/abc-defg-hij",
        content: "<html><body>The call ended</body></html>",
      })

      const result = await provider.findEndMeeting(page)
      expect(result).toBe(true)
    })

    it("returns false when still on meet page with no end messages", async () => {
      const page = createMockPage({
        url: "https://meet.google.com/abc-defg-hij",
        content: "<html><body>Meeting in progress</body></html>",
      })

      const result = await provider.findEndMeeting(page)
      expect(result).toBe(false)
    })
  })

  describe("error handling", () => {
    it("returns false when page.content throws", async () => {
      const page = createMockPage({ url: "https://meet.google.com/abc-defg-hij" })
      page.content.mockRejectedValue(new Error("Page closed"))

      const result = await provider.findEndMeeting(page)
      expect(result).toBe(false)
    })
  })
})
