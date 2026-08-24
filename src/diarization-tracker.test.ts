import { mkdtempSync, readFileSync, type WriteStream } from "fs"
import { tmpdir } from "os"
import { join } from "path"
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

function readSegments(): Array<{
  speaker: string
  user_id: number
  start_time: number
  end_time: number
}> {
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

  it("repairs a churning-device speaker by stable user id when the device never resolves", async () => {
    const tracker = freshTracker()

    // One participant, stable user id 5, but a fresh bare-numeric deviceId every
    // turn (CSRC/SSRC active-speaker switching). All written as "Unknown" before
    // a name resolved. The roster never maps these volatile devices, so the
    // device-keyed pass can't fix them — but the user id did resolve to a name.
    const churn = (deviceId: string, atSeconds: number): SpeakerData => ({
      name: "Unknown",
      id: 5,
      timestamp: MEETING_START + atSeconds * 1000,
      isSpeaking: true,
      deviceId
    })
    tracker.updateSpeaker(churn("111", 1), MEETING_START)
    tracker.updateSpeaker(churn("222", 3), MEETING_START)
    tracker.updateSpeaker(churn("333", 5), MEETING_START)

    await tracker.end(
      MEETING_START + 7000,
      MEETING_START,
      () => undefined, // device resolver: roster never named these SSRC devices
      (userId) => (userId === 5 ? "Real Speaker" : undefined)
    )

    const segments = readSegments()
    expect(segments).toHaveLength(3)
    expect(segments.every((s) => s.speaker === "Real Speaker")).toBe(true)
    expect(segments.every((s) => s.user_id === 5)).toBe(true)
  })

  it("does not repair by user id when the id is 0 (UI/ambiguous) or the device already resolved", async () => {
    const tracker = freshTracker()

    // id 0 = UI-based/ambiguous — must never be relabelled by the id pass.
    tracker.updateSpeaker(speech("ui-dev", "Unknown", 1), MEETING_START)

    await tracker.end(
      MEETING_START + 3000,
      MEETING_START,
      () => undefined,
      () => "WRONG" // would fire if id 0 were eligible
    )

    expect(readSegments()[0].speaker).toBe("Unknown")
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

describe("DiarizationTracker health activity clock", () => {
  it("keeps a long continuous single-speaker utterance out of 'stale'", () => {
    const tracker = freshTracker()

    // One participant opens a segment and keeps talking. SpeakerManager does
    // NOT reopen a segment for continued same-speaker speech — it calls
    // noteActivity — so without the activity clock this open segment would look
    // stale after 5min even though the person is still speaking.
    tracker.updateSpeaker(speech("dev-a", "Amr El Shimy", 1), MEETING_START)
    tracker.noteActivity(speech("dev-a", "Amr El Shimy", 315), MEETING_START)

    const status = tracker.hasActiveOrRecentSegment(
      MEETING_START,
      MEETING_START + 320_000
    )
    expect(status.hasActive).toBe(true)
    expect(status.status).not.toBe("stale")
  })

  it("lets an abandoned open segment age into 'stale' (no activity refresh)", () => {
    const tracker = freshTracker()

    // Segment opened once, then the path went quiet — handleNoSpeakers leaves it
    // open but stops refreshing activity. It must still go stale so the network
    // path can be retired after it stops producing.
    tracker.updateSpeaker(speech("dev-a", "Amr El Shimy", 1), MEETING_START)

    const status = tracker.hasActiveOrRecentSegment(
      MEETING_START,
      MEETING_START + 320_000
    )
    expect(status.status).toBe("stale")
  })

  it("noteActivity ignores activity attributed to a different speaker", () => {
    const tracker = freshTracker()

    tracker.updateSpeaker(speech("dev-a", "Amr El Shimy", 1), MEETING_START)
    // A note for someone who is not the open speaker must not keep the segment
    // fresh — attribution stays per-speaker.
    tracker.noteActivity(speech("dev-b", "Jonny", 315), MEETING_START)

    const status = tracker.hasActiveOrRecentSegment(
      MEETING_START,
      MEETING_START + 320_000
    )
    expect(status.status).toBe("stale")
  })
})

describe("DiarizationTracker first-segment telemetry", () => {
  it("logs the first-segment latency exactly once", async () => {
    const tracker = freshTracker()
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {})

    try {
      tracker.updateSpeaker(speech("dev-a", "Amr El Shimy", 12.3), MEETING_START)
      tracker.updateSpeaker(speech("dev-b", "Johnny", 20), MEETING_START)

      const latencyLogs = logSpy.mock.calls.filter(
        ([msg]) => typeof msg === "string" && msg.includes("First speaker segment opened")
      )
      expect(latencyLogs).toHaveLength(1)
      expect(latencyLogs[0][0]).toContain("+12.3s")
    } finally {
      await tracker.end(MEETING_START + 22_000, MEETING_START, () => undefined)
      logSpy.mockRestore()
    }
  })
})

describe("DiarizationTracker recording-clock clamp", () => {
  it("clamps an event predating the recording instead of emitting a negative start_time", async () => {
    const tracker = freshTracker()

    // Roster and speaking signals flow while the bot is still pre-call, so the
    // first event can carry a timestamp from before meetingStartTime. Observed
    // live as start_time -7.152 on the segment holding the opening utterance.
    tracker.updateSpeaker(speech("dev-a", "Amr El Shimy", -7.152), MEETING_START)
    tracker.updateSpeaker(speech("dev-b", "Jonny", 4.734), MEETING_START)

    await tracker.end(MEETING_START + 12_000, MEETING_START, () => undefined)

    const segments = readSegments()
    expect(segments.length).toBeGreaterThan(0)
    expect(segments[0].start_time).toBe(0)
    expect(segments.every((s) => s.start_time >= 0)).toBe(true)
  })

  it("reports a stream that fails during end() once, not from both listeners", async () => {
    const tracker = freshTracker()
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})

    try {
      tracker.updateSpeaker(speech("dev-a", "Amr El Shimy", 1), MEETING_START)

      // Failure at close time: the constructor listener and closeStream's own
      // listener both see it, and would otherwise log the same fault twice.
      const stream = (tracker as unknown as { fileStream: WriteStream }).fileStream
      jest.spyOn(stream, "end").mockImplementation(function (this: WriteStream) {
        this.destroy(Object.assign(new Error("disk lost"), { code: "EIO" }))
        return this
      } as WriteStream["end"])

      await tracker.end(MEETING_START + 5000, MEETING_START, () => undefined)

      const failureLogs = errorSpy.mock.calls.filter((call) =>
        /stream error on|Error closing stream/.test(String(call[0]))
      )
      expect(failureLogs).toHaveLength(1)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("drops a segment the clamp collapses to zero length", async () => {
    const tracker = freshTracker()

    // Two consecutive pre-recording events: the first segment would open and
    // close at 0 once clamped, spanning no audio at all.
    tracker.updateSpeaker(speech("dev-a", "Amr El Shimy", -9), MEETING_START)
    tracker.updateSpeaker(speech("dev-b", "Jonny", -3), MEETING_START)
    tracker.updateSpeaker(speech("dev-a", "Amr El Shimy", 5), MEETING_START)

    await tracker.end(MEETING_START + 10_000, MEETING_START, () => undefined)

    const segments = readSegments()
    expect(segments.every((s) => s.end_time > s.start_time)).toBe(true)
  })
})
