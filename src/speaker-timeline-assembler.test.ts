import type { DiarizationSegment } from "./diarization-tracker"
import {
  assembleSpeakerTimeline,
  GAP_FILL_MIN_SECONDS,
  LEADING_RETROFIT_MAX_SECONDS
} from "./speaker-timeline-assembler"

function seg(
  speaker: string,
  start: number,
  end: number,
  userId = 2
): DiarizationSegment {
  return { speaker, user_id: userId, start_time: start, end_time: end }
}

describe("assembleSpeakerTimeline", () => {
  it("keeps the primary (network) timeline untouched when it has no holes", () => {
    const network = [seg("Amr", 0, 50), seg("Jonny", 50, 100)]
    const { segments, filledBySource } = assembleSpeakerTimeline(
      [
        { kind: "network", segments: network },
        { kind: "ui", segments: [seg("Impostor", 10, 90, 0)] }
      ],
      100
    )
    expect(segments).toEqual(network)
    expect(filledBySource.ui).toBeUndefined()
  })

  it("fills a mid-call hole from the UI source, clipped to the hole", () => {
    // Network went quiet 100→160; UI saw Jonny speaking 90→150.
    const { segments, filledBySource } = assembleSpeakerTimeline(
      [
        { kind: "network", segments: [seg("Amr", 20, 100), seg("Amr", 160, 200)] },
        { kind: "ui", segments: [seg("Jonny", 90, 150, 0)] }
      ],
      200
    )
    expect(filledBySource.ui).toBe(1)
    const filled = segments.find((s) => s.speaker === "Jonny")
    expect(filled).toEqual(seg("Jonny", 100, 150, 0))
  })

  it("ignores holes shorter than the gap threshold (ordinary turn-taking silence)", () => {
    const shortGapEnd = 100 + GAP_FILL_MIN_SECONDS - 1
    const { segments } = assembleSpeakerTimeline(
      [
        {
          kind: "network",
          segments: [seg("Amr", 0, 100), seg("Amr", shortGapEnd, 200)]
        },
        { kind: "ui", segments: [seg("Jonny", 100, shortGapEnd, 0)] }
      ],
      200
    )
    expect(segments.some((s) => s.speaker === "Jonny")).toBe(false)
  })

  it("consults sources in trust order: transcription only fills what UI left", () => {
    const { segments, filledBySource } = assembleSpeakerTimeline(
      [
        { kind: "network", segments: [seg("Amr", 0, 100)] },
        { kind: "ui", segments: [seg("Jonny", 100, 150, 0)] },
        // Overlaps UI's contribution AND the still-open 150→200 hole: only the
        // uncovered part survives.
        { kind: "transcription", segments: [seg("Speaker 1", 120, 200, 0)] }
      ],
      200
    )
    expect(filledBySource.ui).toBe(1)
    expect(filledBySource.transcription).toBe(1)
    const fromTranscription = segments.find((s) => s.speaker === "Speaker 1")
    expect(fromTranscription).toEqual(seg("Speaker 1", 150, 200, 0))
  })

  it("never lets a fallback contribute an Unknown segment", () => {
    const { segments } = assembleSpeakerTimeline(
      [
        { kind: "network", segments: [seg("Amr", 15, 200)] },
        { kind: "ui", segments: [seg("Unknown", 0, 12, 0)] }
      ],
      200
    )
    // Unknown was rejected, so only the retrofit covers the leading window.
    expect(segments.every((s) => s.speaker === "Amr")).toBe(true)
  })

  it("retrofits the boot gap onto the first identified speaker", () => {
    // Prod case 8db02fee: first utterance ("Grazie.") at 6.1s, first
    // diarization segment much later — the greeting surfaced as Unknown.
    const { segments } = assembleSpeakerTimeline(
      [{ kind: "network", segments: [seg("Opener", 14, 300), seg("Guest", 300, 400)] }],
      400
    )
    expect(segments[0]).toEqual(seg("Opener", 0, 300))
  })

  it("does not retrofit past the cap — a first segment that late means something broke", () => {
    const lateStart = LEADING_RETROFIT_MAX_SECONDS + 1
    const { segments } = assembleSpeakerTimeline(
      [{ kind: "network", segments: [seg("Amr", lateStart, lateStart + 60)] }],
      lateStart + 60
    )
    expect(segments[0].start_time).toBe(lateStart)
  })

  it("retrofits onto the first NAMED segment and clips the Unknown it now covers", () => {
    const { segments } = assembleSpeakerTimeline(
      [
        {
          kind: "network",
          segments: [seg("Unknown", 5, 15, 0), seg("Amr", 18, 100)]
        }
      ],
      100
    )
    // The retrofit stretches Amr over the Unknown; leaving the Unknown in
    // place would still win the opening words downstream (overlap pick).
    expect(segments).toEqual([seg("Amr", 0, 100)])
  })

  it("lets a named fallback win a stretch the network only knew as Unknown", () => {
    const { segments, filledBySource } = assembleSpeakerTimeline(
      [
        {
          kind: "network",
          segments: [seg("Amr", 0, 100), seg("Unknown", 100, 160, 0), seg("Amr", 160, 200)]
        },
        { kind: "ui", segments: [seg("Jonny", 110, 150, 0)] }
      ],
      200
    )
    expect(filledBySource.ui).toBe(1)
    expect(segments.find((s) => s.speaker === "Jonny")).toEqual(seg("Jonny", 110, 150, 0))
    // The Unknown keeps only its uncovered remainders — Jonny's span is
    // Unknown-free.
    for (const s of segments.filter((x) => x.speaker === "Unknown")) {
      expect(s.end_time <= 110 || s.start_time >= 150).toBe(true)
    }
  })

  it("keeps the uncovered remainder of a partially covered Unknown", () => {
    const { segments } = assembleSpeakerTimeline(
      [
        {
          kind: "network",
          // Named coverage [0..50] overlaps the Unknown's head only.
          segments: [seg("Amr", 0, 50), seg("Unknown", 40, 90, 0), seg("Amr", 320, 400)]
        }
      ],
      400
    )
    // First named segment starts at 0 → no retrofit. Unknown survives as its
    // uncovered tail.
    expect(segments.find((s) => s.speaker === "Unknown")).toEqual(seg("Unknown", 50, 90, 0))
  })

  it("handles an empty network timeline: the UI source fills the whole meeting", () => {
    const { segments, filledBySource } = assembleSpeakerTimeline(
      [
        { kind: "network", segments: [] },
        { kind: "ui", segments: [seg("Jonny", 5, 60, 0)] }
      ],
      120
    )
    expect(filledBySource.ui).toBe(1)
    expect(segments).toEqual([seg("Jonny", 0, 60, 0)])
  })
})

describe("assembleSpeakerTimeline retrofit reporting", () => {
  it("reports the original start the retrofit stretched from", () => {
    const { retrofittedFromSeconds } = assembleSpeakerTimeline(
      [{ kind: "network", segments: [seg("Opener", 14, 300)] }],
      300
    )
    expect(retrofittedFromSeconds).toBe(14)
  })

  it("reports nothing when no retrofit happened", () => {
    const { retrofittedFromSeconds } = assembleSpeakerTimeline(
      [{ kind: "network", segments: [seg("Amr", 0, 60)] }],
      60
    )
    expect(retrofittedFromSeconds).toBeUndefined()
  })
})

describe("assembleSpeakerTimeline bot exclusion", () => {
  it("never stretches the bot's own segment over the boot gap", () => {
    // Prod bot 7ff21856: the bot's join announcement was the first diarized
    // segment and the retrofit stretched IT to 0 instead of a human's.
    const { segments, retrofittedFromSeconds } = assembleSpeakerTimeline(
      [
        {
          kind: "network",
          segments: [seg("MeetingBaaS's Notetaker", 7, 14), seg("Amr", 18, 100)]
        }
      ],
      100,
      { botNames: ["MeetingBaaS's Notetaker"] }
    )
    expect(retrofittedFromSeconds).toBe(18)
    expect(segments.find((s) => s.speaker === "Amr")?.start_time).toBe(0)
    expect(segments.find((s) => s.speaker === "MeetingBaaS's Notetaker")).toEqual(
      seg("MeetingBaaS's Notetaker", 7, 14)
    )
  })
})

describe("assembleSpeakerTimeline multi-name bot exclusion", () => {
  it("excludes the learned displayed name even when it differs from bot_name", () => {
    // SSO: configured "Amr's Notetaker", displayed "MeetingBaaS's Notetaker".
    const { segments, retrofittedFromSeconds } = assembleSpeakerTimeline(
      [
        {
          kind: "network",
          segments: [seg("MeetingBaaS's Notetaker", 7, 14), seg("Amr", 18, 100)]
        }
      ],
      100,
      { botNames: ["Amr's Notetaker", "MeetingBaaS's Notetaker"] }
    )
    expect(retrofittedFromSeconds).toBe(18)
    expect(segments.find((s) => s.speaker === "Amr")?.start_time).toBe(0)
  })
})


describe("assembleSpeakerTimeline retrofit cap", () => {
  it("does not stretch a first segment that opens later than the greeting window", () => {
    // Prod bot 013722ff: the guest's lone ~1s segment at +146.6s was stretched
    // to 0s, inflating his talk-time to 147s and masking a collapse downstream.
    const { segments, retrofittedFromSeconds } = assembleSpeakerTimeline(
      [{ kind: "network", segments: [seg("Guest", 146.6, 147.6), seg("Host", 147.6, 2400)] }],
      2400
    )
    expect(retrofittedFromSeconds).toBeUndefined()
    expect(segments[0]).toEqual(seg("Guest", 146.6, 147.6))
  })
})

describe("assembleSpeakerTimeline retrofit cap boundary", () => {
  it("retrofits a first segment opening exactly at the cap", () => {
    const { segments, retrofittedFromSeconds } = assembleSpeakerTimeline(
      [{ kind: "network", segments: [seg("Opener", LEADING_RETROFIT_MAX_SECONDS, 60)] }],
      60
    )
    expect(retrofittedFromSeconds).toBe(LEADING_RETROFIT_MAX_SECONDS)
    expect(segments[0]?.start_time).toBe(0)
  })

  it("does not retrofit a first segment opening just past the cap", () => {
    const start = LEADING_RETROFIT_MAX_SECONDS + 0.1
    const { segments, retrofittedFromSeconds } = assembleSpeakerTimeline(
      [{ kind: "network", segments: [seg("Opener", start, 60)] }],
      60
    )
    expect(retrofittedFromSeconds).toBeUndefined()
    expect(segments[0]?.start_time).toBe(start)
  })
})
