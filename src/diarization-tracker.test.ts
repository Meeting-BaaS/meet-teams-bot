import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DiarizationTracker } from "./diarization-tracker"
import type { SpeakerData } from "./types"

const TEMP_DIR = mkdtempSync(join(tmpdir(), "diarization-test-"))

jest.mock("./utils/PathManager", () => ({
  PathManager: {
    getInstance: () => ({ getTempPath: () => TEMP_DIR })
  }
}))

const MEETING_START = 1_000_000

function speech(deviceId: string, name: string, atSeconds: number): SpeakerData {
  return {
    name,
    id: 0,
    timestamp: MEETING_START + atSeconds * 1000,
    isSpeaking: true,
    deviceId
  }
}

function readSegments(): Array<{ speaker: string; user_id: number }> {
  return readFileSync(join(TEMP_DIR, "diarization.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

function freshTracker(): DiarizationTracker {
  // Singleton — reset between cases so each starts with an empty buffer.
  ;(DiarizationTracker as unknown as { instance: DiarizationTracker | null }).instance = null
  return DiarizationTracker.getInstance()
}

describe("DiarizationTracker backfill", () => {
  it("repairs segments already flushed to disk before the roster resolved", () => {
    const tracker = freshTracker()

    // Audio beats the roster: several turns are recorded before any name is
    // known. Each updateSpeaker call CLOSES and writes the previous segment, so
    // by the time the roster lands these are already on disk — this is the exact
    // production case the open-segment-only repair could not fix.
    tracker.updateSpeaker(speech("dev-a", "Unknown", 1), MEETING_START)
    tracker.updateSpeaker(speech("dev-a", "Unknown", 3), MEETING_START)
    tracker.updateSpeaker(speech("dev-a", "Unknown", 5), MEETING_START)

    return tracker
      .end(MEETING_START + 7000, MEETING_START, (deviceId) =>
        deviceId === "dev-a" ? { name: "Amr El Shimy", userId: 2 } : undefined
      )
      .then(() => {
        const segments = readSegments()
        expect(segments).toHaveLength(3)
        expect(segments.every((s) => s.speaker === "Amr El Shimy")).toBe(true)
        expect(segments.every((s) => s.user_id === 2)).toBe(true)
      })
  })

  it("matches by device, never by name, so speech is not handed to the wrong person", async () => {
    const tracker = freshTracker()

    // Two participants are both "Unknown" at the same time. Renaming by name
    // alone would relabel whichever segment happened to be open.
    tracker.updateSpeaker(speech("dev-a", "Unknown", 1), MEETING_START)
    tracker.updateSpeaker(speech("dev-b", "Unknown", 4), MEETING_START)

    await tracker.end(MEETING_START + 6000, MEETING_START, (deviceId) =>
      deviceId === "dev-a"
        ? { name: "Amr El Shimy", userId: 2 }
        : { name: "Johnny", userId: 3 }
    )

    const segments = readSegments()
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ speaker: "Amr El Shimy", user_id: 2 })
    expect(segments[1]).toMatchObject({ speaker: "Johnny", user_id: 3 })
  })

  it("leaves a device the roster never named as Unknown rather than guessing", async () => {
    const tracker = freshTracker()

    tracker.updateSpeaker(speech("dev-a", "Unknown", 1), MEETING_START)
    tracker.updateSpeaker(speech("ghost", "Unknown", 3), MEETING_START)

    await tracker.end(MEETING_START + 5000, MEETING_START, (deviceId) =>
      deviceId === "dev-a" ? { name: "Amr El Shimy", userId: 2 } : undefined
    )

    const segments = readSegments()
    expect(segments[0].speaker).toBe("Amr El Shimy")
    expect(segments[1].speaker).toBe("Unknown")
  })

  it("does not disturb segments that already had a real name", async () => {
    const tracker = freshTracker()

    tracker.updateSpeaker(speech("dev-a", "Amr El Shimy", 1), MEETING_START)
    tracker.updateSpeaker(speech("dev-b", "Johnny", 3), MEETING_START)

    await tracker.end(MEETING_START + 5000, MEETING_START, () => ({
      name: "SHOULD NOT APPLY",
      userId: 99
    }))

    const segments = readSegments()
    expect(segments.map((s) => s.speaker)).toEqual(["Amr El Shimy", "Johnny"])
  })
})

describe("DiarizationTracker first-segment telemetry", () => {
  it("logs the first-segment latency exactly once", () => {
    const tracker = freshTracker()
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {})

    tracker.updateSpeaker(speech("dev-a", "Amr El Shimy", 12.3), MEETING_START)
    tracker.updateSpeaker(speech("dev-b", "Johnny", 20), MEETING_START)

    const latencyLogs = logSpy.mock.calls.filter(([msg]) =>
      typeof msg === "string" && msg.includes("First speaker segment opened")
    )
    expect(latencyLogs).toHaveLength(1)
    expect(latencyLogs[0][0]).toContain("+12.3s")

    logSpy.mockRestore()
  })
})
