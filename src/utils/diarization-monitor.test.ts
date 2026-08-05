import { networkMinDwellMs } from "./diarization-monitor"

describe("networkMinDwellMs", () => {
  it("protects the Teams network path long enough for dominant-speaker history to arrive", () => {
    // Teams has no per-participant audio levels, so the only speaking signal is
    // the data-channel dominant-speaker history, observed still at dsh=1 fifteen
    // seconds in. The stale detector can retire the path after ~10s of sound.
    expect(networkMinDwellMs("teams")).toBeGreaterThanOrEqual(60_000)
  })

  it("keeps the Zoom dwell aligned with the interceptor's own 45s self-check", () => {
    expect(networkMinDwellMs("zoom")).toBe(45_000)
  })

  it("does not delay the Meet fallback: its audio levels arrive immediately", () => {
    expect(networkMinDwellMs("meet")).toBe(0)
  })

  it("treats an unknown platform as unprotected rather than throwing", () => {
    expect(networkMinDwellMs("unknown-platform")).toBe(0)
  })
})
