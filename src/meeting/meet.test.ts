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
// Shared instance so join-loop tests can script waiting-room / in-meeting state.
const mockDetector = {
  isDenied: jest.fn().mockResolvedValue({ matched: false, matchedText: null, pattern: null }),
  isWaitingRoom: jest.fn().mockResolvedValue({ matched: false, count: 0 }),
  isInMeeting: jest.fn().mockResolvedValue({ count: 0, matched: false }),
}
jest.mock("../utils/meeting-state-detector", () => ({
  createStateDetector: jest.fn().mockReturnValue(mockDetector),
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

  // ── scenarios where retry MUST still happen ────────────────────

  describe("anti-bot page redirect (bot never admitted)", () => {
    it("still retries — Google Meet shows 'You can't join this video call' then redirects", () => {
      // The anti-bot page renders on meet.google.com, then Google
      // redirects to workspace.google.com.  The bot was never admitted
      // so wasInMeeting stays false → retry.
      const page = createMockPage({ url: "https://workspace.google.com/" })

      expect(() => assertOnMeetPage(page, false)).toThrow("Page navigated away from Google Meet")
      expect(mockGlobal.setShouldRetry).toHaveBeenCalledWith(true)
      expect(mockGlobal.setError).toHaveBeenCalledWith(
        MeetingEndReason.BotNotAccepted,
        expect.stringContaining("Google Meet denied entry")
      )
    })
  })

  describe("redirect before admission (bot never reached meeting)", () => {
    it("still retries — e.g. network issue or Meet redirect before the join loop confirms entry", () => {
      const page = createMockPage({ url: "https://workspace.google.com/" })

      expect(() => assertOnMeetPage(page, false)).toThrow("Page navigated away from Google Meet")
      expect(mockGlobal.setShouldRetry).toHaveBeenCalledWith(true)
      expect(mockGlobal.setError).toHaveBeenCalledWith(
        MeetingEndReason.BotNotAccepted,
        expect.stringContaining("Google Meet denied entry")
      )
    })
  })

  describe("early fail-fast denial (line 214 — no second arg)", () => {
    it("still retries — defaults wasInMeeting to false when argument omitted", () => {
      // The call at meet.ts line 214 passes no wasInMeeting argument.
      // Default is false, so retry behaviour is preserved.
      const page = createMockPage({ url: "https://workspace.google.com/" })

      expect(() => assertOnMeetPage(page)).toThrow("Page navigated away from Google Meet")
      expect(mockGlobal.setShouldRetry).toHaveBeenCalledWith(true)
      expect(mockGlobal.setError).toHaveBeenCalledWith(
        MeetingEndReason.BotNotAccepted,
        expect.stringContaining("Google Meet denied entry")
      )
    })
  })

  // ── the fix: NO retry when bot was admitted then removed ────────

  describe("redirect after confirmed admission (host removed bot)", () => {
    it("does NOT retry — wasInMeeting=true → BotRemoved, no setShouldRetry call", () => {
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

  describe("ignoreAloneSignals (grace-period explicit-removal check)", () => {
    it("still returns true for an explicit removal ('You've been removed')", async () => {
      const page = createMockPage({
        url: "https://meet.google.com/abc-defg-hij",
        content: "<html><body>You've been removed from the meeting</body></html>",
      })

      const result = await provider.findEndMeeting(page, { ignoreAloneSignals: true })
      expect(result).toBe(true)
    })

    it("does NOT exit on the alone-signal ('No one else') when ignoreAloneSignals is set", async () => {
      const page = createMockPage({
        url: "https://meet.google.com/abc-defg-hij",
        content: "<html><body>No one else is here</body></html>",
      })

      const result = await provider.findEndMeeting(page, { ignoreAloneSignals: true })
      expect(result).toBe(false)
    })

    it("exits on 'No one else' normally after grace (no opts)", async () => {
      const page = createMockPage({
        url: "https://meet.google.com/abc-defg-hij",
        content: "<html><body>No one else is here</body></html>",
      })

      const result = await provider.findEndMeeting(page)
      expect(result).toBe(true)
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

// ══════════════════════════════════════════════════════════════════
// MeetProvider.joinMeeting — lobby / debounce regression tests
//
// Regression for the 2026-08-11 prod incident: Meet's lobby can render
// the in-meeting DOM (indicator threshold passes) while the lobby text
// appears seconds LATE. A join confirm that fires inside that window is
// false, and the post-confirm lobby check then kills the bot as
// botNotAccepted. The debounce must hold the confirm until the lobby
// text has been absent long enough — including renders later than the
// old 6s window (observed up to 6.4s).
// ══════════════════════════════════════════════════════════════════

describe("MeetProvider.joinMeeting — join-confirm debounce", () => {
  let provider: MeetProvider

  const { sleep } = jest.requireMock("../utils/sleep")

  function createJoinLoopPage() {
    // Permissive page mock: every UI interaction "exists but never succeeds",
    // so the pre-loop steps (name typing, mic/camera, join click) fall
    // through their retry paths without throwing. Timer-advancing waits keep
    // Date.now() moving under fake timers.
    const locatorChain: any = {}
    Object.assign(locatorChain, {
      first: jest.fn().mockReturnValue(locatorChain),
      count: jest.fn().mockResolvedValue(0),
      isVisible: jest.fn().mockResolvedValue(false),
      isEnabled: jest.fn().mockResolvedValue(false),
      click: jest.fn().mockRejectedValue(new Error("not clickable")),
      fill: jest.fn().mockRejectedValue(new Error("not fillable")),
      type: jest.fn().mockRejectedValue(new Error("not typable")),
      waitFor: jest.fn().mockRejectedValue(new Error("never visible")),
      evaluate: jest.fn().mockResolvedValue(undefined),
      evaluateAll: jest.fn().mockResolvedValue([]),
      all: jest.fn().mockResolvedValue([]),
    })
    return {
      url: jest.fn().mockReturnValue("https://meet.google.com/abc-defg-hij"),
      content: jest.fn().mockResolvedValue("<html></html>"),
      isClosed: jest.fn().mockReturnValue(false),
      evaluate: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn().mockReturnValue(locatorChain),
      keyboard: { press: jest.fn().mockResolvedValue(undefined) },
      mouse: {
        move: jest.fn().mockResolvedValue(undefined),
        click: jest.fn().mockResolvedValue(undefined),
        down: jest.fn().mockResolvedValue(undefined),
        up: jest.fn().mockResolvedValue(undefined),
      },
      waitForTimeout: jest.fn().mockImplementation(async (ms: number) => {
        jest.advanceTimersByTime(ms)
      }),
    } as any
  }

  beforeEach(() => {
    resetMocks()
    jest.useFakeTimers()
    provider = new MeetProvider()
    mockGlobal.get.mockReturnValue({
      bot_name: "TestBot",
      streaming_input: undefined,
      recording_mode: "audio_only", // skips the layout-change machinery in critical setup
      meet_sso_config: undefined,
      enter_message: undefined,
    })
    sleep.mockImplementation(async (ms: number) => {
      jest.advanceTimersByTime(ms)
    })
    mockDetector.isDenied.mockResolvedValue({ matched: false, matchedText: null, pattern: null })
  })

  afterEach(() => {
    jest.useRealTimers()
    sleep.mockResolvedValue(undefined)
    mockDetector.isWaitingRoom.mockResolvedValue({ matched: false, count: 0 })
    mockDetector.isInMeeting.mockResolvedValue({ count: 0, matched: false })
  })

  it("does NOT confirm when the lobby text renders late (8s after the first clean sample)", async () => {
    // In-meeting indicators pass from the start (the lobby renders call
    // controls); the lobby text only becomes detectable 8s after the first
    // clean in-meeting sample — later than the old 6s window.
    let firstCleanSampleAt: number | null = null
    mockDetector.isInMeeting.mockImplementation(async () => {
      if (firstCleanSampleAt === null) firstCleanSampleAt = Date.now()
      return { count: 4, matched: true }
    })
    mockDetector.isWaitingRoom.mockImplementation(async () => {
      const lateTextVisible =
        firstCleanSampleAt !== null && Date.now() - firstCleanSampleAt >= 8000
      return { matched: lateTextVisible, count: lateTextVisible ? 3 : 0 }
    })

    const onJoinSuccess = jest.fn()
    const start = Date.now()
    // Let the loop run 40s of virtual time, then stop it via cancelCheck.
    const cancelCheck = () => Date.now() - start > 40000

    await expect(
      provider.joinMeeting(createJoinLoopPage(), cancelCheck, onJoinSuccess)
    ).rejects.toThrow("API request to stop recording")

    expect(onJoinSuccess).not.toHaveBeenCalled()
  })

  it("confirms after an observed lobby→clear transition plus the debounce window", async () => {
    // Bot sees the lobby for 3s (host admits), text clears and stays gone —
    // the trusted transition case. Confirm should land after grace + 6s.
    const start = Date.now()
    mockDetector.isInMeeting.mockResolvedValue({ count: 4, matched: true })
    mockDetector.isWaitingRoom.mockImplementation(async () => {
      const inLobby = Date.now() - start < 3000
      return { matched: inLobby, count: inLobby ? 3 : 0 }
    })

    const onJoinSuccess = jest.fn()
    const cancelCheck = () => Date.now() - start > 60000

    await provider.joinMeeting(createJoinLoopPage(), cancelCheck, onJoinSuccess)

    expect(onJoinSuccess).toHaveBeenCalledTimes(1)
  })
})
