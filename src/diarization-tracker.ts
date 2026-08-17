import { createWriteStream, type WriteStream } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type SpeakerData, UNKNOWN_SPEAKER } from "./types"
import { PathManager } from "./utils/PathManager"

interface DiarizationSegment {
  speaker: string
  user_id: number // Sequential user ID (0 for UI-based detection, 1+ for network-based)
  start_time: number
  end_time: number
}

/**
 * Health status levels for diarization monitoring.
 */
export type DiarizationHealthStatusLevel = "optimal" | "acceptable" | "stale"

/**
 * Tracks speaker diarization during the meeting and writes to a local file.
 * Uses in-memory buffering to minimize file I/O operations.
 */
export interface DiarizationHealthStatus {
  hasActive: boolean
  hasRecent60s: boolean
  hasRecent5min: boolean
  segmentCount60s: number
  segmentCount5min: number
  status: DiarizationHealthStatusLevel
}

/** Resolves a network device to its final name/id, once the roster is complete. */
export type SpeakerResolver = (deviceId: string) => { name: string; userId: number } | undefined
// Resolve a stable sequential user id to its final name, for segments whose
// deviceId never resolved (churning SSRC) but whose user id did resolve while
// the participant spoke.
export type UserIdResolver = (userId: number) => string | undefined

export class DiarizationTracker {
  private static instance: DiarizationTracker | null = null
  private fileStream: WriteStream | null = null
  private currentSegment: {
    speaker: string
    startTime: number
    userId: number
    deviceId?: string
  } | null = null
  private recentSegments: DiarizationSegment[] = [] // Last 5 closed segments
  // EVERY segment produced this meeting, with the device it belongs to. This is
  // the authoritative copy: the file is rewritten from it on end() so segments
  // that were flushed while a name was still unresolved can be repaired.
  // Without this, only the single open segment could ever be fixed and every
  // "Unknown" already written to disk stayed wrong forever.
  private allSegments: Array<{ segment: DiarizationSegment; deviceId?: string }> = []
  private filePath: string
  private isEnded = false
  private hasTrackedAnySegment = false // True once ANY speaker segment was ever opened
  private streamFailed = false // True once the append stream errored and was dropped

  private constructor(tempDir: string) {
    this.filePath = join(tempDir, "diarization.jsonl")
    // Open file stream for append-only writing (efficient for continuous logs)
    this.fileStream = createWriteStream(this.filePath, { flags: "a" })
    // Unhandled 'error' (ENOSPC) would kill the bot mid-meeting. Degrade to
    // memory — end() rewrites the file from allSegments.
    this.fileStream.on("error", (error) => {
      if (this.streamFailed) return
      this.streamFailed = true
      this.fileStream = null
      console.error(
        `[DiarizationTracker] Append stream failed (${error}) — continuing in memory; segments are rewritten from the buffer on end()`
      )
    })
  }

  public static getInstance(): DiarizationTracker {
    if (!DiarizationTracker.instance) {
      const pathManager = PathManager.getInstance()
      const tempDir = pathManager.getTempPath()
      DiarizationTracker.instance = new DiarizationTracker(tempDir)
    }
    return DiarizationTracker.instance
  }

  /**
   * Update the current speaker segment.
   * @param speaker - Speaker data with name and timestamp
   * @param meetingStartTime - Meeting start timestamp in milliseconds
   */
  public updateSpeaker(speaker: SpeakerData, meetingStartTime: number): void {
    if (this.isEnded) {
      console.warn("DiarizationTracker: Attempted to update after ended")
      return
    }

    // Clamp to the recording clock. A speaker event can carry a timestamp from
    // before meetingStartTime — the roster and speaking signals start flowing
    // while the bot is still in the pre-call/waiting phase — and unclamped that
    // produced a negative start_time on the first segment (observed: -7.152s),
    // which misaligns exactly the segment the leading-"Unknown" run lives in.
    // Someone already speaking when recording opens belongs at 0, not before it.
    const relativeTime = Math.max(0, (speaker.timestamp - meetingStartTime) / 1000)

    // If we have a current segment, close it before starting a new one
    if (this.currentSegment) {
      const closedSegment: DiarizationSegment = {
        speaker: this.currentSegment.speaker,
        start_time: this.currentSegment.startTime,
        end_time: relativeTime,
        user_id: this.currentSegment.userId
      }
      // Clamping to the recording clock can collapse a segment to zero length
      // when two consecutive events both predate meetingStartTime. Such a
      // segment spans no audio, so emitting it only adds noise to the timeline.
      if (closedSegment.end_time > closedSegment.start_time) {
        this.writeToFile(closedSegment)
        this.allSegments.push({
          segment: closedSegment,
          deviceId: this.currentSegment.deviceId
        })

        // Add to recent segments (keep max 5)
        this.recentSegments.push(closedSegment)
        if (this.recentSegments.length > 5) {
          this.recentSegments.shift() // Remove oldest
        }
      }
    }

    // Start new segment (keep in memory)
    if (!this.hasTrackedAnySegment) {
      // Speech recorded before this point has no diarization to name it and
      // surfaces as a leading "Unknown" run in the transcript, so this latency
      // is the direct size of that window. Greppable across bot logs to track
      // the boot gap in production (target: single-digit seconds).
      console.log(
        `[DiarizationTracker] First speaker segment opened at +${relativeTime.toFixed(1)}s after meeting start`
      )
    }
    this.currentSegment = {
      speaker: speaker.name,
      startTime: relativeTime,
      userId: speaker.id,
      deviceId: speaker.deviceId
    }
    this.hasTrackedAnySegment = true
  }

  /**
   * Repair every segment still attributed to the placeholder, using the final
   * roster. Returns how many were fixed.
   *
   * Matching is by DEVICE, never by name: two participants can both be sitting
   * under "Unknown" at once, and renaming by name alone would hand one person's
   * speech to the other.
   */
  private repairUnknownSpeakers(resolve: SpeakerResolver): number {
    let repaired = 0
    for (const entry of this.allSegments) {
      if (entry.segment.speaker !== UNKNOWN_SPEAKER || !entry.deviceId) {
        continue
      }
      const resolved = resolve(entry.deviceId)
      if (!resolved || resolved.name === UNKNOWN_SPEAKER) {
        continue
      }
      entry.segment.speaker = resolved.name
      entry.segment.user_id = resolved.userId
      repaired++
    }
    return repaired
  }

  /**
   * Second repair pass, keyed on the STABLE user id rather than the device.
   * A speaker seen only through the CSRC/SSRC path gets a fresh bare-numeric
   * deviceId on every active-speaker switch, so the roster never maps those
   * devices and repairUnknownSpeakers leaves the segment "Unknown" — even though
   * the same participant kept one stable user id that DID resolve to a real name
   * while they spoke. Match on that id (still a per-participant key, so it can't
   * hand one person's speech to another) to recover them.
   */
  private repairUnknownByUserId(resolve: UserIdResolver): number {
    let repaired = 0
    for (const entry of this.allSegments) {
      if (entry.segment.speaker !== UNKNOWN_SPEAKER || !entry.segment.user_id) {
        continue
      }
      const name = resolve(entry.segment.user_id)
      if (!name || name === UNKNOWN_SPEAKER) {
        continue
      }
      entry.segment.speaker = name
      repaired++
    }
    return repaired
  }

  /**
   * True once at least one speaker segment was ever opened this meeting.
   * Distinguishes "network diarization NEVER produced data" (source is dead —
   * fall back fast) from "was producing, currently quiet" (normal silence —
   * debounce before falling back).
   */
  public hasEverTrackedSegment(): boolean {
    return this.hasTrackedAnySegment
  }

  /**
   * Finalize the tracker by closing the last segment.
   * @param lastTimestamp - Last timestamp of the meeting in milliseconds
   * @param meetingStartTime - Meeting start timestamp in milliseconds
   * @returns Promise that resolves when the file stream is fully closed and flushed
   */
  public async end(
    lastTimestamp: number,
    meetingStartTime: number,
    resolveSpeaker?: SpeakerResolver,
    resolveUserId?: UserIdResolver
  ): Promise<void> {
    if (this.isEnded) {
      return
    }
    this.isEnded = true

    // Close the final segment into the buffer so it can be repaired too — it is
    // frequently the one that opened before the roster landed.
    if (this.currentSegment) {
      this.allSegments.push({
        segment: {
          speaker: this.currentSegment.speaker,
          start_time: this.currentSegment.startTime,
          end_time: Math.max(0, (lastTimestamp - meetingStartTime) / 1000),
          user_id: this.currentSegment.userId
        },
        deviceId: this.currentSegment.deviceId
      })
      this.currentSegment = null
    }

    const repaired = resolveSpeaker ? this.repairUnknownSpeakers(resolveSpeaker) : 0
    if (repaired > 0) {
      console.log(
        `[DiarizationTracker] Backfilled ${repaired} segment(s) that were written before the roster resolved`
      )
    }

    // Second pass: rescue segments the device-keyed repair could not, using the
    // stable user id (churning-SSRC speakers whose device never mapped).
    const repairedById = resolveUserId ? this.repairUnknownByUserId(resolveUserId) : 0
    if (repairedById > 0) {
      console.log(
        `[DiarizationTracker] Backfilled ${repairedById} segment(s) by stable user id (device never resolved)`
      )
    }

    await this.closeStream()

    // Rewrite from the in-memory buffer, which is authoritative. Appending as we
    // go keeps a usable file if the pod dies mid-meeting, but the append log can
    // contain names that were still unresolved at the time they were flushed.
    try {
      const body = this.allSegments.map((e) => `${JSON.stringify(e.segment)}\n`).join("")
      await writeFile(this.filePath, body)
    } catch (error) {
      console.error(`DiarizationTracker: Failed to rewrite ${this.filePath}: ${error}`)
    }

    const stillUnknown = this.allSegments.filter(
      (e) => e.segment.speaker === UNKNOWN_SPEAKER
    ).length
    if (stillUnknown > 0) {
      console.warn(
        `[DiarizationTracker] ${stillUnknown}/${this.allSegments.length} segment(s) remain "${UNKNOWN_SPEAKER}" — the roster never resolved those devices`
      )
    }
    console.log(`Diarization tracking completed: ${this.filePath}`)
  }

  /** Flush and close the append stream, resolving even if it errors. */
  private closeStream(): Promise<void> {
    const stream = this.fileStream
    this.fileStream = null
    if (!stream) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      stream.end()
      stream.once("finish", () => resolve())
      stream.once("error", (error) => {
        // The constructor listener runs first and already reported this one.
        if (!this.streamFailed) {
          console.error(`DiarizationTracker: Error closing stream: ${error}`)
        }
        resolve()
      })
    })
  }

  /**
   * Get the file path for the diarization file.
   */
  public getFilePath(): string {
    return this.filePath
  }

  /**
   * Get the current active segment.
   */
  public getCurrentSegment(): { speaker: string; startTime: number; userId: number } | null {
    return this.currentSegment
  }

  /**
   * Check if there's an active or recent segment within the specified time windows.
   * @param meetingStartTime - Meeting start timestamp in milliseconds
   * @param currentTime - Current timestamp in milliseconds
   * @returns Health status object
   */
  public hasActiveOrRecentSegment(
    meetingStartTime: number,
    currentTime: number
  ): DiarizationHealthStatus {
    const currentTimeSeconds = (currentTime - meetingStartTime) / 1000
    const window60s = 60 // 60 seconds
    const window5min = 300 // 5 minutes

    let hasActive = false
    let hasRecent60s = false
    let hasRecent5min = false
    let segmentCount60s = 0
    let segmentCount5min = 0

    // Check current active segment
    if (this.currentSegment) {
      hasActive = true
      const segmentAge = currentTimeSeconds - this.currentSegment.startTime

      if (segmentAge < window60s) {
        hasRecent60s = true
        segmentCount60s++
      }
      if (segmentAge < window5min) {
        hasRecent5min = true
        segmentCount5min++
      }
    }

    // Check recent closed segments
    for (const segment of this.recentSegments) {
      const segmentAge = currentTimeSeconds - segment.end_time

      if (segmentAge < window60s) {
        hasRecent60s = true
        segmentCount60s++
      }
      if (segmentAge < window5min) {
        hasRecent5min = true
        segmentCount5min++
      }
    }

    // Determine overall status
    let status: DiarizationHealthStatusLevel
    if (segmentCount60s > 1) {
      status = "optimal"
    } else if (hasRecent5min) {
      status = "acceptable"
    } else {
      status = "stale"
    }

    return {
      hasActive,
      hasRecent60s,
      hasRecent5min,
      segmentCount60s,
      segmentCount5min,
      status
    }
  }

  /**
   * Write a segment to the file (JSONL format).
   */
  private writeToFile(segment: DiarizationSegment): void {
    if (!this.fileStream) {
      // Already reported once by the error handler.
      if (!this.streamFailed) {
        console.error("DiarizationTracker: File stream not initialized")
      }
      return
    }

    const line = `${JSON.stringify(segment)}\n`
    this.fileStream.write(line)
  }
}
