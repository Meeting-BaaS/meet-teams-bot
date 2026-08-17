import { resolveSpeakingSet, type SpeakerTimelineEvidence } from "./speaker-timeline"

function evidence(overrides: Partial<SpeakerTimelineEvidence> = {}): SpeakerTimelineEvidence {
  return {
    csrcAvailable: false,
    csrcSpeaking: [],
    captionAtInstant: [],
    captionWindowed: [],
    dominant: null,
    dominantFresh: false,
    captionsEnabled: false,
    captionExpiry: false,
    ...overrides
  }
}

describe("resolveSpeakingSet — the hybrid dsh + caption session", () => {
  // The bug: dsh stays fresh while still naming the previous speaker.
  it("lets a caption interval containing the instant overrule a dsh that has not expired", () => {
    const decision = resolveSpeakingSet(
      evidence({
        captionAtInstant: ["dev-b"],
        dominant: "dev-a",
        dominantFresh: true,
        captionsEnabled: true
      })
    )

    expect(decision).toEqual({ deviceIds: ["dev-b"], rung: "caption-interval" })
  })

  it("keeps the fresh dsh speaker when no caption covers the instant", () => {
    // Between utterances dsh is the only continuous signal.
    const decision = resolveSpeakingSet(
      evidence({ dominant: "dev-a", dominantFresh: true, captionsEnabled: true })
    )

    expect(decision).toEqual({ deviceIds: ["dev-a"], rung: "dsh-fresh" })
  })

  it("hands the floor back to a live dsh when the caption utterance expires", () => {
    // Only the expiry update ends a selected caption interval; emitting silence
    // here would cut off a speaker dsh still reports as active.
    const decision = resolveSpeakingSet(
      evidence({
        captionAtInstant: ["dev-b"],
        dominant: "dev-a",
        dominantFresh: true,
        captionsEnabled: true,
        captionExpiry: true
      })
    )

    expect(decision).toEqual({ deviceIds: ["dev-a"], rung: "dsh-fresh" })
  })

  it("emits silence on expiry when dsh is not live either", () => {
    const decision = resolveSpeakingSet(
      evidence({ dominant: "dev-a", captionsEnabled: true, captionExpiry: true })
    )

    expect(decision).toEqual({ deviceIds: [], rung: "silence" })
  })
})

describe("resolveSpeakingSet — unchanged behaviour on single-signal sessions", () => {
  it("prefers CSRC over everything, including reading its silence as nobody", () => {
    const decision = resolveSpeakingSet(
      evidence({
        csrcAvailable: true,
        csrcSpeaking: [],
        captionAtInstant: ["dev-b"],
        dominant: "dev-a",
        dominantFresh: true
      })
    )

    expect(decision).toEqual({ deviceIds: [], rung: "csrc" })
  })

  it("uses the caption window when dsh is dead — the server-mixed-audio session", () => {
    const decision = resolveSpeakingSet(
      evidence({
        captionWindowed: ["dev-b"],
        dominant: "dev-a",
        dominantFresh: false,
        captionsEnabled: true
      })
    )

    expect(decision).toEqual({ deviceIds: ["dev-b"], rung: "caption-window" })
  })

  it("never revives a stale dominant once captions are the working signal", () => {
    // These sessions emit dsh once or not at all; it would pin one speaker.
    const decision = resolveSpeakingSet(
      evidence({ dominant: "dev-a", dominantFresh: false, captionsEnabled: true })
    )

    expect(decision).toEqual({ deviceIds: [], rung: "silence" })
  })

  it("holds a stale dominant on a session where captions never came up", () => {
    // A stale dominant here is a monologue, and it is all the bot has.
    const decision = resolveSpeakingSet(
      evidence({ dominant: "dev-a", dominantFresh: false, captionsEnabled: false })
    )

    expect(decision).toEqual({ deviceIds: ["dev-a"], rung: "dsh-stale" })
  })

  it("reports silence when no source has anything to say", () => {
    expect(resolveSpeakingSet(evidence())).toEqual({ deviceIds: [], rung: "silence" })
  })
})

describe("resolveSpeakingSet — injectable into the page", () => {
  // A closure would arrive undefined in the page — silent mis-attribution.
  it("is self-contained enough to survive toString() + eval", () => {
    // biome-ignore lint/security/noGlobalEval: this is the production injection path
    const rehydrated = eval(`(${resolveSpeakingSet.toString()})`) as typeof resolveSpeakingSet

    expect(
      rehydrated(
        evidence({
          captionAtInstant: ["dev-b"],
          dominant: "dev-a",
          dominantFresh: true,
          captionsEnabled: true
        })
      )
    ).toEqual({ deviceIds: ["dev-b"], rung: "caption-interval" })
  })
})
