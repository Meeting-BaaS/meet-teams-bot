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

  it("gives Meet a short dwell so the force-native audio path survives the roster race", () => {
    // With MEET_FORCE_NATIVE_AUDIO_PIPELINE the native audio path emits
    // source=audio events that are still (none)/"Unknown" until the roster
    // resolves. The caller only holds when such an event arrived recently, so a
    // dead path still fast-falls-back; this floor bounds the live-path hold.
    expect(networkMinDwellMs("meet")).toBe(15_000)
  })

  it("treats an unknown platform as unprotected rather than throwing", () => {
    expect(networkMinDwellMs("unknown-platform")).toBe(0)
  })
})
