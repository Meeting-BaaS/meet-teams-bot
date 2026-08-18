import { GLOBAL } from "./singleton"

describe("network diarization re-arm", () => {
  it("refuses to re-arm once the page-side interceptor was torn down", () => {
    // Tearing the interceptor down is one-way — no restart path exists. Clearing
    // the latches anyway would mute the UI bridge in favour of a dead source and
    // the meeting would finish with nobody named at all.
    GLOBAL.setNetworkInterceptionSetupFailed()
    GLOBAL.setDiarizationFallbackTriggered()
    GLOBAL.markNetworkInterceptionStopped()

    expect(GLOBAL.rearmNetworkDiarization()).toBe(false)
    expect(GLOBAL.hasDiarizationFallbackTriggered()).toBe(true)
    expect(GLOBAL.hasRearmedNetworkDiarization()).toBe(false)
  })

  it("re-arms a path whose interceptor is still running", () => {
    // Meet never stops its interceptor, which is exactly what makes its re-arm
    // safe: the frames signal that proves recovery can only come from a live one.
    const fresh = new (GLOBAL.constructor as new () => typeof GLOBAL)()
    fresh.setNetworkInterceptionSetupFailed()
    fresh.setDiarizationFallbackTriggered()

    expect(fresh.rearmNetworkDiarization()).toBe(true)
    expect(fresh.hasDiarizationFallbackTriggered()).toBe(false)
    expect(fresh.hasNetworkInterceptionSetupFailed()).toBe(false)
    expect(fresh.hasRearmedNetworkDiarization()).toBe(true)
  })
})
