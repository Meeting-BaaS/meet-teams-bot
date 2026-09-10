const mockParams: { max_recording_duration?: number } = {}
const mockSetError = jest.fn()
const mockSetShouldRetry = jest.fn()

jest.mock("../singleton", () => ({
  GLOBAL: {
    get: () => mockParams,
    setError: (...args: unknown[]) => mockSetError(...args),
    setShouldRetry: (...args: unknown[]) => mockSetShouldRetry(...args)
  }
}))

import { MeetingEndReason } from "../state-machine/types"
import { handleTimingControl } from "./timing-control"

const now = () => Math.floor(Date.now() / 1000)

describe("handleTimingControl lateness guard", () => {
  beforeEach(() => {
    mockSetError.mockClear()
    mockSetShouldRetry.mockClear()
    mockParams.max_recording_duration = 3600
  })

  it("joins immediately when no start time was scheduled", async () => {
    await expect(handleTimingControl(undefined)).resolves.toBeGreaterThan(0)
    expect(mockSetError).not.toHaveBeenCalled()
  })

  it("still joins a meeting it is only modestly late for", async () => {
    const startTime = now() - 10 * 60
    await expect(handleTimingControl(startTime)).resolves.toBe(startTime)
    expect(mockSetError).not.toHaveBeenCalled()
  })

  it("allows a short cold start even when the recording cap is tiny", async () => {
    mockParams.max_recording_duration = 60
    const startTime = now() - 5 * 60
    await expect(handleTimingControl(startTime)).resolves.toBe(startTime)
    expect(mockSetError).not.toHaveBeenCalled()
  })

  it("refuses to join hours after the meeting could still be running", async () => {
    const startTime = now() - 5 * 3600
    await expect(handleTimingControl(startTime)).rejects.toThrow(/Refusing to join/)
    expect(mockSetError).toHaveBeenCalledWith(MeetingEndReason.TimeoutWaitingToStart)
    expect(mockSetShouldRetry).toHaveBeenCalledWith(false)
  })

  it("uses the recording cap as the allowance, not a fixed window", async () => {
    mockParams.max_recording_duration = 4 * 3600
    const startTime = now() - 3 * 3600
    await expect(handleTimingControl(startTime)).resolves.toBe(startTime)
    expect(mockSetError).not.toHaveBeenCalled()
  })
})
