import { GLOBAL } from "../singleton"
import { awaitJoinPhase, JoinPhaseInterrupted, runInJoinAttempt } from "./join-attempt"
import { MeetingEndReason } from "./types"

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe("awaitJoinPhase", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  const options = (overrides: Partial<Parameters<typeof awaitJoinPhase>[1]> = {}) => ({
    label: "join#1 opening the meeting page",
    deadlineMs: 1_000,
    isStopRequested: () => false,
    onLateSettle: jest.fn(),
    ...overrides
  })

  it("passes the phase's own result through", async () => {
    await expect(awaitJoinPhase(Promise.resolve("page"), options())).resolves.toBe("page")
  })

  it("passes the phase's own failure through", async () => {
    await expect(
      awaitJoinPhase(Promise.reject(new Error("goto failed")), options())
    ).rejects.toThrow("goto failed")
  })

  it("stops waiting at the deadline and reports how the phase finished later", async () => {
    let finish!: (page: string) => void
    const phase = new Promise<string>((resolve) => {
      finish = resolve
    })
    const onLateSettle = jest.fn()

    const waiting = awaitJoinPhase(phase, options({ onLateSettle }))
    const settled = expect(waiting).rejects.toMatchObject({ interruption: "deadline" })
    jest.advanceTimersByTime(1_000)
    await settled

    finish("late page")
    await flush()
    expect(onLateSettle).toHaveBeenCalledWith({ status: "fulfilled", value: "late page" })
  })

  it("gives up promptly on a stop request", async () => {
    let stop = false
    const waiting = awaitJoinPhase(
      new Promise<never>(() => {}),
      options({ deadlineMs: 60_000, isStopRequested: () => stop })
    )
    const settled = expect(waiting).rejects.toBeInstanceOf(JoinPhaseInterrupted)
    stop = true
    jest.advanceTimersByTime(1_000)
    await settled
  })

  it("does not report a phase that finished in time as late", async () => {
    const onLateSettle = jest.fn()
    await awaitJoinPhase(Promise.resolve(1), options({ onLateSettle }))
    jest.advanceTimersByTime(5_000)
    await flush()
    expect(onLateSettle).not.toHaveBeenCalled()
  })
})

describe("join attempt supersession", () => {
  beforeEach(() => GLOBAL.resetErrorState())
  afterEach(() => GLOBAL.resetErrorState())

  it("drops a superseded attempt's late writes so the decided outcome stands", async () => {
    const attempt = GLOBAL.beginJoinAttempt()
    let release!: () => void
    const straggler = runInJoinAttempt(attempt, async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      GLOBAL.setError(MeetingEndReason.ZoomLoadingStalled)
      GLOBAL.setShouldRetry(true)
    })

    GLOBAL.supersedeJoinAttempt(attempt, "waiting-room timeout")
    GLOBAL.setError(MeetingEndReason.TimeoutWaitingToStart)
    release()
    await straggler

    expect(GLOBAL.getEndReason()).toBe(MeetingEndReason.TimeoutWaitingToStart)
    expect(GLOBAL.getShouldRetry()).toBe(false)
  })

  it("drops writes from an attempt replaced by a newer one, keeps the newer one's", async () => {
    const walled = GLOBAL.beginJoinAttempt()
    const relaunch = GLOBAL.beginJoinAttempt()

    await runInJoinAttempt(walled, async () => GLOBAL.setError(MeetingEndReason.CannotJoinMeeting))
    expect(GLOBAL.getEndReason()).toBeNull()

    await runInJoinAttempt(relaunch, async () =>
      GLOBAL.setError(MeetingEndReason.ZoomAnonymousJoinNotAllowed)
    )
    expect(GLOBAL.getEndReason()).toBe(MeetingEndReason.ZoomAnonymousJoinNotAllowed)
  })

  it("never drops writes made outside a join attempt", () => {
    const attempt = GLOBAL.beginJoinAttempt()
    GLOBAL.supersedeJoinAttempt(attempt, "attempt ended")

    GLOBAL.setError(MeetingEndReason.TimeoutWaitingToStart)

    expect(GLOBAL.getEndReason()).toBe(MeetingEndReason.TimeoutWaitingToStart)
  })

  it("lets code tell it is running for a superseded attempt", async () => {
    const attempt = GLOBAL.beginJoinAttempt()
    await runInJoinAttempt(attempt, async () => {
      expect(GLOBAL.inSupersededJoinAttempt()).toBe(false)
      GLOBAL.supersedeJoinAttempt(attempt, "stop requested")
      expect(GLOBAL.inSupersededJoinAttempt()).toBe(true)
    })
    expect(GLOBAL.inSupersededJoinAttempt()).toBe(false)
  })
})
