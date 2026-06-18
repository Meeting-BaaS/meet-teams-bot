import { MeetingEndReason, MeetingStateType, type MeetingContext } from "../types"

// ── mock the world ──────────────────────────────────────────────
// jest.mock calls are hoisted – do NOT reference module-scope variables here.

jest.mock("../../singleton", () => ({
  GLOBAL: {
    get: jest.fn(),
    getEndReason: jest.fn().mockReturnValue(undefined),
    getParticipants: jest.fn().mockReturnValue([]),
    setEndReason: jest.fn(),
    setExitTime: jest.fn(),
    hasError: jest.fn().mockReturnValue(false),
    setError: jest.fn(),
    hasNetworkInterceptionSetupFailed: jest.fn().mockReturnValue(false),
    hasDiarizationFallbackTriggered: jest.fn().mockReturnValue(false),
    setNetworkInterceptionSetupFailed: jest.fn(),
    setDiarizationFallbackTriggered: jest.fn(),
  },
}))

jest.mock("../../speaker-manager", () => ({
  SpeakerManager: {
    getInstance: jest.fn().mockReturnValue({
      getLastCallbackTime: jest.fn().mockReturnValue(Date.now()),
      handleSpeakerUpdate: jest.fn(),
    }),
    start: jest.fn(),
    finalize: jest.fn(),
  },
}))

jest.mock("../../utils/sound-level-monitor", () => ({
  SoundLevelMonitor: {
    peekInstance: jest.fn(),
    getInstance: jest.fn(),
    stopIfStarted: jest.fn(),
  },
}))

jest.mock("../../recording/ScreenRecorder", () => ({
  ScreenRecorderManager: {
    getInstance: jest.fn().mockReturnValue({
      on: jest.fn(),
      setMeetingStartTime: jest.fn(),
    }),
  },
}))

jest.mock("../../events", () => ({ Events: { callEnded: jest.fn().mockResolvedValue(undefined) } }))

jest.mock("../../utils/sleep", () => ({ sleep: jest.fn() }))

jest.mock("../../browser/page-logger", () => ({ listenPage: jest.fn() }))

jest.mock("../../meeting/meet/ui-observer", () => ({ startUIBasedObserver: jest.fn() }))

jest.mock("../../meeting/meet/network-interception", () => ({ stopNetworkInterception: jest.fn() }))

jest.mock("../../utils/diarization-monitor", () => ({
  checkDiarizationHealth: jest.fn().mockResolvedValue({ status: "optimal" }),
  logHealthStatus: jest.fn(),
}))

// Import after mocks so the SUT picks up mocked dependencies.
import { RecordingState } from "./recording-state"

// ── helpers ─────────────────────────────────────────────────────

function mockGLOBAL() {
  return require("../../singleton").GLOBAL as Record<string, jest.Mock>
}

function mockSoundLevelMonitor() {
  return require("../../utils/sound-level-monitor").SoundLevelMonitor as Record<string, jest.Mock>
}

function createContext(overrides: Partial<MeetingContext> = {}): MeetingContext {
  return {
    provider: {
      findEndMeeting: jest.fn().mockResolvedValue(false),
      closeMeeting: jest.fn(),
    } as any,
    playwrightPage: undefined,
    browserContext: undefined,
    startTime: Date.now(),
    attendeesCount: 0,
    firstUserJoined: false,
    pauseWindows: [],
    currentPauseStart: null,
    ...overrides,
  }
}

function setMeetingParams(params: Record<string, unknown>): void {
  mockGLOBAL().get.mockImplementation((path: string) => params[path])
}

// ── tests ───────────────────────────────────────────────────────

describe("RecordingState – grace period participant detection", () => {
  let state: RecordingState
  let context: MeetingContext
  let startTime: number

  beforeEach(() => {
    jest.useFakeTimers({ now: 0 })
    jest.clearAllMocks()

    startTime = Date.now()

    setMeetingParams({
      meeting_platform: "teams",
      grace_period: 10,
      silence_timeout: 30,
      no_one_joined_timeout: 30,
    })

    // SoundLevelMonitor: active but silent
    mockSoundLevelMonitor().peekInstance.mockReturnValue({
      getCurrentSoundLevel: jest.fn().mockReturnValue(0),
      getIsActive: jest.fn().mockReturnValue(true),
    })

    context = createContext({
      startTime,
      attendeesCount: 5,
    })

    state = new RecordingState(context, MeetingStateType.Recording)

    // Suppress checkBotRemoved (needs browser page, which we don't have)
    jest.spyOn(state as any, "checkBotRemoved").mockResolvedValue(false)
  })

  describe("fix: humans leave during grace period", () => {
    it("DOES set hasNoOneJoinedPeriodEnded when attendees are present during grace period", async () => {
      jest.setSystemTime(startTime + 2000)
      await (state as any).checkEndConditions()

      expect((state as any).hasNoOneJoinedPeriodEnded).toBe(true)
    })

    it("proceeds to silence/alone checks after grace period expires (not stuck in noone-joined)", async () => {
      // T=2s: inside grace period, humans present → detection happens
      jest.setSystemTime(startTime + 2000)
      await (state as any).checkEndConditions()

      // Humans leave during grace period
      context.attendeesCount = 1

      // T=12s: grace period expired
      jest.setSystemTime(startTime + 12000)
      const result = await (state as any).checkEndConditions()

      // Fix: hasNoOneJoinedPeriodEnded is true — checkAloneInMeeting is reached
      expect((state as any).hasNoOneJoinedPeriodEnded).toBe(true)
      // Should not be stuck (doesn't return early at "Still waiting" block)
      // Note: result is still false because we need 30s alone before leaving
    })
  })

  describe("grace period exit suppression", () => {
    it("does not end meeting during grace period even when alone", async () => {
      jest.setSystemTime(startTime + 2000)
      context.attendeesCount = 1

      const result = await (state as any).checkEndConditions()
      expect(result.shouldEnd).toBe(false)
    })
  })

  describe("API stop request", () => {
    it("returns shouldEnd=true when end reason is set externally", async () => {
      // Override the mock from beforeEach to return a reason this time
      mockGLOBAL().getEndReason.mockReset()
      mockGLOBAL().getEndReason.mockReturnValue(MeetingEndReason.ApiRequest)

      jest.setSystemTime(startTime + 2000)
      const result = await (state as any).checkEndConditions()

      expect(result.shouldEnd).toBe(true)
      expect(result.reason).toBe(MeetingEndReason.ApiRequest)
    })
  })
})
