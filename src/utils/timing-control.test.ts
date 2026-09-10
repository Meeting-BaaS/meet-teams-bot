const mockSetError = jest.fn()
const mockSetShouldRetry = jest.fn()

jest.mock("../singleton", () => ({
  GLOBAL: {
    get: () => ({}),
    setError: (...args: unknown[]) => mockSetError(...args),
    setShouldRetry: (...args: unknown[]) => mockSetShouldRetry(...args)
  }
}))

import { MeetingEndReason } from "../state-machine/types"
import { handleTimingControl, JOIN_DEADLINE_AFTER_START_SEC } from "./timing-control"

const now = () => Math.floor(Date.now() / 1000)

describe("handleTimingControl join deadline", () => {
  beforeEach(() => {
    mockSetError.mockClear()
    mockSetShouldRetry.mockClear()
  })

  it("joins immediately when no start time was scheduled", async () => {
    await expect(handleTimingControl(undefined)).resolves.toBeGreaterThan(0)
    expect(mockSetError).not.toHaveBeenCalled()
  })

  it("still joins a scheduled meeting it is well past fifteen minutes late for", async () => {
    // The old allowance was max(max_recording_duration, 15min): with no cap, 15m01s late
    // was permanently rejected even though the meeting was running.
    const startTime = now() - (15 * 60 + 1)
    await expect(handleTimingControl(startTime)).resolves.toBe(startTime)
    expect(mockSetError).not.toHaveBeenCalled()
  })

  it("joins hours late, since lateness alone cannot prove the meeting ended", async () => {
    const startTime = now() - 5 * 3600
    await expect(handleTimingControl(startTime)).resolves.toBe(startTime)
    expect(mockSetShouldRetry).not.toHaveBeenCalled()
  })

  it("refuses a relaunch past the join deadline, without retrying", async () => {
    const startTime = now() - (JOIN_DEADLINE_AFTER_START_SEC + 60)
    await expect(handleTimingControl(startTime)).rejects.toThrow(/Refusing to join/)
    expect(mockSetError).toHaveBeenCalledWith(MeetingEndReason.TimeoutWaitingToStart)
    expect(mockSetShouldRetry).toHaveBeenCalledWith(false)
  })
})
