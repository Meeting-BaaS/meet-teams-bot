import type { DiarizationSegment } from "./diarization-tracker"
import {
  assembleSpeakerTimeline,
  SOURCE_DISSONANCE_MIN_SPEAKER_SECONDS
} from "./speaker-timeline-assembler"

const seg = (speaker: string, start: number, end: number, id = 1): DiarizationSegment => ({
  speaker,
  user_id: id,
  start_time: start,
  end_time: end
})

describe("speaker attribution priority (including no STT)", () => {
  it("uses a single UI speaker for a one-second unresolved network interval", () => {
    for (const name of ["Unknown"]) {
      const { segments } = assembleSpeakerTimeline(
        [
          { kind: "network", segments: [seg(name, 0, 10)] },
          { kind: "ui", segments: [seg("UI Guest", 3, 4, 2)] }
        ],
        10
      )
      expect(segments).toEqual([
        { ...seg(name, 0, 3), source: "network" },
        { ...seg("UI Guest", 3, 4, 2), source: "ui" },
        { ...seg(name, 4, 10), source: "network" }
      ])
    }
  })

  it("preserves resolved network names and exact boundaries despite conflicting UI", () => {
    const network = [seg("Host", 0, 3), seg("Guest", 3, 4, 2), seg("Host", 4, 10)]
    const { segments } = assembleSpeakerTimeline(
      [
        { kind: "network", segments: network },
        { kind: "ui", segments: [seg("Lagging UI", 2, 5, 3)] }
      ],
      10
    )
    expect(segments).toEqual(network.map((s) => ({ ...s, source: "network" })))
  })

  it("fills a short missing network interval without overwriting its named edges", () => {
    const { segments } = assembleSpeakerTimeline(
      [
        { kind: "network", segments: [seg("Host", 0, 3), seg("Host", 4, 10)] },
        { kind: "ui", segments: [seg("Guest", 2, 5, 2)] }
      ],
      10
    )
    expect(segments).toEqual([
      { ...seg("Host", 0, 3), source: "network" },
      { ...seg("Guest", 3, 4, 2), source: "ui" },
      { ...seg("Host", 4, 10), source: "network" }
    ])
  })

  it("does not let UI erase concurrent named and unresolved network sources", () => {
    const network = [seg("Host", 0, 10), seg("Unknown", 3, 5, 2)]
    const { segments } = assembleSpeakerTimeline(
      [
        { kind: "network", segments: network },
        { kind: "ui", segments: [seg("UI Guest", 3, 5, 3)] }
      ],
      10
    )
    expect(segments).toEqual(network.map((s) => ({ ...s, source: "network" })))
  })

  it.each(["Other Guest", "Unknown"])("falls back to network for ambiguous UI (%s)", (other) => {
    const { segments } = assembleSpeakerTimeline(
      [
        {
          kind: "ui",
          segments: [seg("Guest", 0, 10, 2), seg(other, 0, 10, 3)]
        },
        { kind: "network", segments: [seg("Network Guest", 0, 10)] },
        {
          kind: "transcription",
          segments: [seg("Acoustic Guest", 0, 10, 4)]
        }
      ],
      10
    )
    expect(segments).toEqual([{ ...seg("Network Guest", 0, 10), source: "network" }])
  })

  it("keeps different unresolved source IDs separate without STT", () => {
    const { segments } = assembleSpeakerTimeline(
      [
        {
          kind: "network",
          segments: [seg("Unknown", 1, 3, 1), seg("Unknown", 3, 5, 2)]
        }
      ],
      10
    )
    expect(segments.map((s) => s.user_id)).toEqual([1, 2])
    expect(segments.map((s) => s.start_time)).toEqual([1, 3])
    expect(segments[1].end_time).toBe(5)
  })

  it("does not extend any source into an unobserved opening or tail", () => {
    const { segments } = assembleSpeakerTimeline(
      [{ kind: "ui", segments: [seg("Guest", 5, 7)] }],
      10
    )
    expect(segments).toEqual([{ ...seg("Guest", 5, 7), source: "ui" }])
  })

  it("uses transcription only when UI and network cannot name the interval", () => {
    const { segments } = assembleSpeakerTimeline(
      [
        { kind: "network", segments: [seg("Unknown", 0, 10)] },
        { kind: "transcription", segments: [seg("Guest", 3, 5, 2)] }
      ],
      10
    )
    expect(segments[1]).toEqual({
      ...seg("Guest", 3, 5, 2),
      source: "transcription"
    })
  })

  it("filters the recording bot before assessing UI ambiguity", () => {
    const { segments } = assembleSpeakerTimeline(
      [
        {
          kind: "ui",
          segments: [seg("Notetaker", 0, 10), seg("Guest", 0, 10, 2)]
        }
      ],
      10,
      { botNames: ["Notetaker"] }
    )
    expect(segments).toEqual([{ ...seg("Guest", 0, 10, 2), source: "ui" }])
  })

  it("preserves concurrent network identities without picking one arbitrarily", () => {
    const { segments } = assembleSpeakerTimeline(
      [
        {
          kind: "network",
          segments: [seg("Guest", 0, 10), seg("Host", 3, 5, 2)]
        }
      ],
      10
    )
    expect(segments).toEqual([
      { ...seg("Guest", 0, 10), source: "network" },
      { ...seg("Host", 3, 5, 2), source: "network" }
    ])
  })

  it("clips invalid bounds and ignores empty segments", () => {
    const { segments } = assembleSpeakerTimeline(
      [
        {
          kind: "network",
          segments: [seg("Guest", -2, 20), seg("Host", 2, 2)]
        }
      ],
      10
    )
    expect(segments).toEqual([{ ...seg("Guest", 0, 10), source: "network" }])
  })
})

describe("assembleSpeakerTimeline source dissonance", () => {
  // Prod bot 22e3adba: network pinned a two-person call on one speaker.
  const network = [seg("Stefano", 0, 1400, 2)]
  const ui = [seg("Stefano", 0, 640, 2), seg("Emanuele", 640, 1350, 3)]

  it("promotes corroborated multi-speaker evidence when the primary collapsed", () => {
    const { segments, filledBySource, sourceDissonance } = assembleSpeakerTimeline(
      [
        { kind: "network", segments: network },
        { kind: "ui", segments: ui }
      ],
      1400
    )
    expect(sourceDissonance).toMatchObject({
      reason: "primary_dominated_challenger_multi_speaker",
      demotedSource: "network",
      promotedSource: "ui",
      primaryEffectiveSpeakers: 1,
      challengerEffectiveSpeakers: 2,
      primaryDominance: 1
    })
    // The demoted primary still covers the tail the UI never reached.
    expect(segments).toEqual([
      { ...seg("Stefano", 0, 640, 2), source: "ui" },
      { ...seg("Emanuele", 640, 1350, 3), source: "ui" },
      { ...seg("Stefano", 1350, 1400, 2), source: "network" }
    ])
    expect(filledBySource).toEqual({ ui: 2, network: 1 })
  })

  it("does not promote a transient second speaker", () => {
    const { segments, sourceDissonance } = assembleSpeakerTimeline(
      [
        { kind: "network", segments: [seg("Stefano", 0, 120)] },
        {
          kind: "ui",
          segments: [
            seg("Stefano", 0, 100),
            seg("Emanuele", 100, 100 + SOURCE_DISSONANCE_MIN_SPEAKER_SECONDS - 0.1, 3)
          ]
        }
      ],
      120
    )
    expect(sourceDissonance).toBeUndefined()
    expect(segments).toEqual([{ ...seg("Stefano", 0, 120), source: "network" }])
  })

  it("does not count the recording bot as multi-speaker evidence", () => {
    const { segments, sourceDissonance } = assembleSpeakerTimeline(
      [
        { kind: "network", segments: [seg("Stefano", 0, 120)] },
        {
          kind: "ui",
          segments: [seg("Stefano", 0, 60), seg("MeetingBaaS Notetaker", 60, 120, 9)]
        }
      ],
      120,
      { botNames: ["MeetingBaaS Notetaker"] }
    )
    expect(sourceDissonance).toBeUndefined()
    expect(segments).toEqual([{ ...seg("Stefano", 0, 120), source: "network" }])
  })

  it("requires a shared identity before treating disagreement as collapse", () => {
    const { segments, sourceDissonance } = assembleSpeakerTimeline(
      [
        { kind: "network", segments: [seg("Network Identity", 0, 120)] },
        { kind: "ui", segments: [seg("Alice", 0, 60, 2), seg("Bob", 60, 120, 3)] }
      ],
      120
    )
    expect(sourceDissonance).toBeUndefined()
    expect(segments).toEqual([{ ...seg("Network Identity", 0, 120), source: "network" }])
  })

  it("catches a PARTIAL collapse, where the primary found slivers of the second speaker", () => {
    // Prod bot acf4eecf: 5,271 speaking samples against 31.
    const { sourceDissonance } = assembleSpeakerTimeline(
      [
        {
          kind: "network",
          segments: [seg("Stefano", 0, 1380, 2), seg("Emanuele", 1380, 1400, 3)]
        },
        { kind: "ui", segments: ui }
      ],
      1400
    )
    expect(sourceDissonance).toMatchObject({
      promotedSource: "ui",
      primaryEffectiveSpeakers: 2,
      primaryOtherSeconds: 20,
      challengerOtherSeconds: 710
    })
  })

  it("leaves a lopsided but CORRECT call alone when both sources agree", () => {
    const { segments, sourceDissonance } = assembleSpeakerTimeline(
      [
        {
          kind: "network",
          segments: [seg("Stefano", 0, 1380, 2), seg("Emanuele", 1380, 1400, 3)]
        },
        { kind: "ui", segments: [seg("Stefano", 0, 1375, 2), seg("Emanuele", 1375, 1398, 3)] }
      ],
      1400
    )
    expect(sourceDissonance).toBeUndefined()
    expect(segments).toEqual([
      { ...seg("Stefano", 0, 1380, 2), source: "network" },
      { ...seg("Emanuele", 1380, 1400, 3), source: "network" }
    ])
  })

  it("demotes the collapsed primary BELOW every source it has not disproven", () => {
    const { segments, filledBySource, sourceDissonance } = assembleSpeakerTimeline(
      [
        { kind: "network", segments: network },
        { kind: "ui", segments: [seg("Stefano", 0, 600, 2), seg("Emanuele", 600, 1200, 3)] },
        { kind: "transcription", segments: [seg("Emanuele", 1200, 1395, 3)] }
      ],
      1400
    )
    expect(sourceDissonance?.promotedSource).toBe("ui")
    expect(filledBySource.transcription).toBe(1)
    expect(segments.find((s) => s.start_time === 1200)).toMatchObject({
      speaker: "Emanuele",
      end_time: 1395,
      source: "transcription"
    })
    // Only the unobserved tail falls back to the collapsed primary.
    expect(segments.filter((s) => s.source === "network")).toEqual([
      { ...seg("Stefano", 1395, 1400, 2), source: "network" }
    ])
  })

  it("does not treat a mid-call rename as a second speaker (same id, two names)", () => {
    // Network keeps the device's first name; the UI shows the new one.
    const { segments, sourceDissonance } = assembleSpeakerTimeline(
      [
        { kind: "network", segments: [seg("Jane Doe", 0, 1200, 2)] },
        { kind: "ui", segments: [seg("Jane Doe", 0, 600, 2), seg("Jane Smith", 600, 1200, 2)] }
      ],
      1200
    )
    expect(sourceDissonance).toBeUndefined()
    expect(segments).toEqual([{ ...seg("Jane Doe", 0, 1200, 2), source: "network" }])
  })

  it("keeps two participants with the same display name apart (two ids, one name)", () => {
    // Both sources see two devices; neither is dominated, so nothing is promoted.
    const { sourceDissonance } = assembleSpeakerTimeline(
      [
        { kind: "network", segments: [seg("Alex", 0, 600, 2), seg("Alex", 600, 1200, 3)] },
        { kind: "ui", segments: [seg("Alex", 0, 600, 2), seg("Alex", 600, 1200, 3)] }
      ],
      1200
    )
    expect(sourceDissonance).toBeUndefined()
    // And a real collapse of two same-named people is still caught by id.
    const collapsed = assembleSpeakerTimeline(
      [
        { kind: "network", segments: [seg("Alex", 0, 1200, 2)] },
        { kind: "ui", segments: [seg("Alex", 0, 600, 2), seg("Alex", 600, 1200, 3)] }
      ],
      1200
    )
    expect(collapsed.sourceDissonance).toMatchObject({ promotedSource: "ui" })
  })

  it("accepts any lower-trust source as the challenger, not just the UI observer", () => {
    const { sourceDissonance } = assembleSpeakerTimeline(
      [
        { kind: "network", segments: network },
        { kind: "ui", segments: [] },
        { kind: "transcription", segments: ui }
      ],
      1400
    )
    expect(sourceDissonance).toMatchObject({
      demotedSource: "network",
      promotedSource: "transcription"
    })
  })
})
