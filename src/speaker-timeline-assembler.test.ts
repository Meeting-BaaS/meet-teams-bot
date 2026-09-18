import type { DiarizationSegment } from "./diarization-tracker"
import { assembleSpeakerTimeline } from "./speaker-timeline-assembler"

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
