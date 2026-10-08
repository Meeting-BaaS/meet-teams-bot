import { createWriteStream, type WriteStream } from "fs"
import { rename, writeFile } from "fs/promises"
import { join } from "path"
import { type SpeakerData, UNKNOWN_SPEAKER } from "./types"
import { PathManager } from "./utils/PathManager"

export interface DiarizationSegment {
  source?: "ui" | "network" | "transcription"
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
    source: "ui" | "network"
    deviceId?: string
  } | null = null
  private recentSegments: DiarizationSegment[] = [] // Last 5 closed segments
  // EVERY segment produced this meeting, with the device it belongs to. This is
  // the authoritative copy: the file is rewritten from it on end() so segments
  // that were flushed while a name was still unresolved can be repaired.
  // Without this, only the single open segment could ever be fixed and every
  // "Unknown" already written to disk stayed wrong forever.
  private allSegments: Array<{
    segment: DiarizationSegment
    deviceId?: string
  }> = []
  private filePath: string
  private isEnded = false
  private hasTrackedAnySegment = false // True once ANY speaker segment was ever opened
  // Meeting-relative seconds of the last time the OPEN segment saw genuine
  // speaker activity. A continuous same-speaker utterance does not reopen a
  // segment (SpeakerManager only calls updateSpeaker on a speaker change or
  // resumed speech), so without a separate activity clock a valid utterance
  // that runs past 5min would be misreported as "stale" and wrongly retire the
  // network path. handleNoSpeakers stops refreshing this, so an ABANDONED open
  // segment still ages into "stale" and the post-stop fallback is preserved.
  private lastActivitySeconds: number | null = null
  private streamFailed = false // True once the append stream errored and was dropped

  private constructor(tempDir: string) {
    this.filePath = join(tempDir, "diarization.jsonl")
    // Open file stream for append-only writing (efficient for continuous logs)
    this.fileStream = createWriteStream(this.filePath, { flags: "a" })
    // A WriteStream is an EventEmitter: an unhandled "error" event throws and
    // kills the process mid-meeting (e.g. the temp dir becomes unwritable).
    // closeStream() only attaches a listener at finalize time, so without this
    // the whole meeting window is unprotected. The append log is best-effort
    // (end() rewrites the file from the in-memory buffer), so log and drop the
    // stream instead of crashing.
    this.fileStream.on("error", (error) => {
      if (this.streamFailed) return
      this.streamFailed = true
      console.error(`DiarizationTracker: stream error on ${this.filePath}: ${error}`)
      this.fileStream = null
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
  public updateSpeaker(
    speaker: SpeakerData,
    meetingStartTime: number,
    source: "ui" | "network" = "network"
  ): void {
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
        source: this.currentSegment.source,
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
      source,
      deviceId: speaker.deviceId
    }
    this.lastActivitySeconds = relativeTime
    this.hasTrackedAnySegment = true
  }

  /**
   * Refresh the open segment's activity clock on CONTINUED same-speaker speech.
   * SpeakerManager reopens a segment (updateSpeaker) only on a speaker change or
   * resumed speech, so an uninterrupted utterance by one participant never calls
   * updateSpeaker again; without this the open segment would look stale after a
   * few minutes even while that person is still talking. No-op when nothing is
   * open or the activity is for a different speaker, so handleNoSpeakers (which
   * stops calling this) still lets an abandoned open segment age into "stale".
   */
  public noteActivity(speaker: SpeakerData, meetingStartTime: number): void {
    if (this.isEnded || !this.currentSegment) {
      return
    }
    if (speaker.id !== this.currentSegment.userId || speaker.name !== this.currentSegment.speaker) {
      return
    }
    const relativeTime = Math.max(0, (speaker.timestamp - meetingStartTime) / 1000)
    if (this.lastActivitySeconds === null || relativeTime > this.lastActivitySeconds) {
      this.lastActivitySeconds = relativeTime
    }
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
    resolveUserId?: UserIdResolver,
    fallbackSources?: TimelineSource[],
    botNames?: string[],
    selfDeviceId?: string,
    uiSpeakingWindows?: UiSpeakingWindow[]
  ): Promise<void> {
    if (this.isEnded) {
      return
    }
    this.isEnded = true

    // Close the final segment into the buffer so it can be repaired too — it is
    // frequently the one that opened before the roster landed.
    if (this.currentSegment) {
      const endTime = Math.max(0, (lastTimestamp - meetingStartTime) / 1000)
      // Same rule as updateSpeaker: a segment that spans no audio is noise. An
      // API stop at/before meetingStartTime clamps end_time to 0 while
      // start_time is also 0, so guard against writing a zero-duration segment.
      if (endTime > this.currentSegment.startTime) {
        this.allSegments.push({
          segment: {
            speaker: this.currentSegment.speaker,
            source: this.currentSegment.source,
            start_time: this.currentSegment.startTime,
            end_time: endTime,
            user_id: this.currentSegment.userId
          },
          deviceId: this.currentSegment.deviceId
        })
      }
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

    // Final priority is independent of STT: repaired network identity first,
    // then one fresh UI speaker. Leave unobserved/unresolved spans unnamed.
    const meetingEndRel = Math.max(0, (lastTimestamp - meetingStartTime) / 1000)
    const {
      segments: assembled,
      filledBySource,
      sourceDissonance
    } = assembleSpeakerTimeline(
      [
        {
          kind: "network" as const,
          // The bot's own device never belongs in the timeline — an SSO bot's
          // segments carry the account's displayed name, which no bot_name
          // exclusion can catch; the device id is canonical.
          segments: this.allSegments
            .filter(
              (e) => e.segment.source !== "ui" && (!selfDeviceId || e.deviceId !== selfDeviceId)
            )
            .map((e) => e.segment)
        },
        ...(fallbackSources ?? [])
      ],
      meetingEndRel,
      { botNames, uiSpeakingWindows, retrofitLeadingGap: true }
    )
    if (sourceDissonance) {
      // An interceptor was wrong for the whole call. Counts only: names are PII.
      console.error(
        `[DiarizationTracker] ⚠️ Source dissonance (${sourceDissonance.reason}): promoted ${sourceDissonance.promotedSource} over ${sourceDissonance.demotedSource}; ` +
          `effective speakers ${sourceDissonance.demotedSource}=${sourceDissonance.primaryEffectiveSpeakers} ${sourceDissonance.promotedSource}=${sourceDissonance.challengerEffectiveSpeakers}, ` +
          `dominance=${sourceDissonance.primaryDominance}, other-speaker seconds ${sourceDissonance.primaryOtherSeconds} -> ${sourceDissonance.challengerOtherSeconds}`
      )
    }
    for (const [kind, count] of Object.entries(filledBySource)) {
      console.log(`[DiarizationTracker] Selected ${count} timeline segment(s) from ${kind}`)
    }
    await this.closeStream()

    // Rewrite from the in-memory buffer, which is authoritative. Appending as we
    // go keeps a usable file if the pod dies mid-meeting, but the append log can
    // contain names that were still unresolved at the time they were flushed.
    try {
      const body = assembled.map((segment) => `${JSON.stringify(segment)}\n`).join("")
      // Write to a sibling temp file and rename it. `rename` is atomic on the
      // same filesystem, so a crash inside this window leaves the file as either
      // the intact append log or the fully-repaired body — never truncated.
      const tempPath = `${this.filePath}.tmp`
      await writeFile(tempPath, body)
      await rename(tempPath, this.filePath)
    } catch (error) {
      console.error(`DiarizationTracker: Failed to rewrite ${this.filePath}: ${error}`)
    }

    const stillUnknown = assembled.filter((segment) => segment.speaker === UNKNOWN_SPEAKER).length
    if (stillUnknown > 0) {
      console.warn(`[SpeakerAlert] unresolved_unknown segments=${stillUnknown}/${assembled.length}`)
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
  public getCurrentSegment(): {
    speaker: string
    startTime: number
    userId: number
  } | null {
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

    // Check current active segment. Age it by the last time it saw genuine
    // speaker activity, not by when it opened: an open segment is not proof of
    // ongoing speech (handleNoSpeakers leaves it open after the path goes
    // quiet), so a long-running utterance stays "recent" while it is still
    // active but a segment abandoned mid-flight ages into "stale" as intended.
    if (this.currentSegment) {
      hasActive = true
      const activityRef = this.lastActivitySeconds ?? this.currentSegment.startTime
      const segmentAge = currentTimeSeconds - activityRef

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

export type TimelineSourceKind = "network" | "ui" | "transcription"

export interface TimelineSource {
  kind: TimelineSourceKind
  segments: DiarizationSegment[]
}

const isNamed = (segment: DiarizationSegment): boolean =>
  Boolean(segment.speaker.trim()) && segment.speaker.trim() !== UNKNOWN_SPEAKER

/** A speaker counts as present in a source once it holds this much named time. */
export const SOURCE_DISSONANCE_MIN_SPEAKER_SECONDS = 15
/** Share of the primary's named time one speaker must hold for "collapsed". */
export const SOURCE_DISSONANCE_DOMINANCE_RATIO = 0.85
/** The challenger must give the other speakers this many times more seconds. */
export const SOURCE_DISSONANCE_DISAGREEMENT_FACTOR = 3
/**
 * Meet's loudest-speaker path can briefly promote an orphan SSRC (no roster
 * name) and emit a contiguous `Unknown` blip between two stretches of the same
 * named person. Those spans are ranking flicker, not a real third speaker —
 * real syllables are well above this. Only Unknown is eligible: a short named
 * turn between different people is a legitimate handoff and must stay.
 */
export const SHORT_UNKNOWN_MAX_SECONDS = 0.5
export const LEADING_RETROFIT_MAX_SECONDS = 20

export interface UiSpeakingWindow {
  start_time: number
  end_time: number
  speakers: Array<{ name: string; user_id: number }>
}

export interface SpeakerSourceDissonance {
  reason: "primary_dominated_challenger_multi_speaker"
  demotedSource: TimelineSourceKind
  promotedSource: TimelineSourceKind
  primaryEffectiveSpeakers: number
  challengerEffectiveSpeakers: number
  /** Share of the primary's named time held by its top speaker. */
  primaryDominance: number
  /** Seconds the primary vs the challenger gave everyone but that speaker. */
  primaryOtherSeconds: number
  challengerOtherSeconds: number
}

/** Positive-length segments, chronological. */
function normalize(segments: DiarizationSegment[]): DiarizationSegment[] {
  return segments
    .filter((s) => s.end_time > s.start_time)
    .slice()
    .sort((a, b) => a.start_time - b.start_time)
}

function coverageOf(segments: DiarizationSegment[]): Array<[number, number]> {
  const merged: Array<[number, number]> = []
  for (const s of normalize(segments)) {
    const last = merged[merged.length - 1]
    if (last && s.start_time <= last[1]) {
      last[1] = Math.max(last[1], s.end_time)
    } else {
      merged.push([s.start_time, s.end_time])
    }
  }
  return merged
}

/**
 * Identity for cross-source comparison. Network and UI segments share the
 * sequential id namespace whenever the observer saw a device id (both go
 * through idForDevice), so a participant who renames mid-call or two people
 * with the same display name stay one or two identities in BOTH sources. The
 * display name is only the key for segments without a real id.
 */
function identityOf(segment: DiarizationSegment): string {
  return segment.user_id > 0
    ? `id:${segment.user_id}`
    : `name:${segment.speaker.trim().toLowerCase()}`
}

function speakerDurations(
  segments: DiarizationSegment[],
  excludeSpeakers: string[] = []
): Map<string, number> {
  const excluded = new Set(
    [UNKNOWN_SPEAKER, ...excludeSpeakers].map((name) => name.trim().toLowerCase())
  )
  const bySpeaker = new Map<string, DiarizationSegment[]>()
  for (const segment of normalize(segments)) {
    const name = segment.speaker?.trim().toLowerCase()
    if (!name || excluded.has(name)) continue
    const key = identityOf(segment)
    const existing = bySpeaker.get(key) ?? []
    existing.push(segment)
    bySpeaker.set(key, existing)
  }
  const durations = new Map<string, number>()
  for (const [speaker, speakerSegments] of bySpeaker) {
    durations.set(
      speaker,
      coverageOf(speakerSegments).reduce((sum, [start, end]) => sum + end - start, 0)
    )
  }
  return durations
}

function effectiveSpeakers(durations: Map<string, number>): Array<[string, number]> {
  return [...durations].filter(([, seconds]) => seconds >= SOURCE_DISSONANCE_MIN_SPEAKER_SECONDS)
}

/**
 * Drop short Unknown segments sandwiched by the same named neighbour and merge
 * those neighbours across the removed span.
 *
 * Why: the network timeline is contiguous (silence keeps the last speaker), so
 * deleting a middle blip never opens a hole — the previous segment simply
 * absorbs the time. We require matching neighbour *names* (not user ids) so a
 * single person's floor stays intact when Meet briefly surfaces an unmapped
 * stream. We do not guess when neighbours differ (`Alice → Unknown → Bob`):
 * renaming would risk wrong attribution, and dropping without a sandwich would
 * invent a gap in a contiguous timeline.
 *
 * Runs to a fixed point so flip-flop chains (`A → U → A → U → A`) collapse in
 * successive passes.
 */
export function collapseShortUnknownSandwiches(
  segments: DiarizationSegment[]
): DiarizationSegment[] {
  let current = normalize(segments).map((segment) => ({ ...segment }))
  let collapsed = 0
  let changed = true
  while (changed) {
    changed = false
    const next: DiarizationSegment[] = []
    for (let index = 0; index < current.length; index++) {
      const mid = current[index]
      const prev = next[next.length - 1]
      const after = current[index + 1]
      if (
        prev &&
        after &&
        mid.speaker === UNKNOWN_SPEAKER &&
        mid.end_time - mid.start_time <= SHORT_UNKNOWN_MAX_SECONDS &&
        prev.speaker === after.speaker &&
        identityOf(prev) === identityOf(after) &&
        prev.speaker !== UNKNOWN_SPEAKER &&
        prev.end_time === mid.start_time &&
        mid.end_time === after.start_time
      ) {
        prev.end_time = after.end_time
        index++
        collapsed++
        changed = true
        continue
      }
      next.push({ ...mid })
    }
    current = next
  }
  const remaining = current.filter((s) => s.speaker === UNKNOWN_SPEAKER).length
  console.log(
    `[UnknownCleanup] pass1_sandwich collapsed=${collapsed} remaining_unknown=${remaining}`
  )
  return current
}

function namedSpeakersOf(window: UiSpeakingWindow): Array<{ name: string; user_id: number }> {
  return window.speakers.filter((s) => s.name.trim() && s.name.trim() !== UNKNOWN_SPEAKER)
}

function coalesceAdjacent(segments: DiarizationSegment[]): DiarizationSegment[] {
  const out: DiarizationSegment[] = []
  for (const segment of normalize(segments)) {
    const last = out[out.length - 1]
    if (
      last &&
      last.speaker === segment.speaker &&
      last.user_id === segment.user_id &&
      last.end_time === segment.start_time
    ) {
      last.end_time = segment.end_time
    } else {
      out.push({ ...segment })
    }
  }
  return out
}

function uiWindowsOverlapping(
  start: number,
  end: number,
  windows: UiSpeakingWindow[]
): UiSpeakingWindow[] {
  return windows.filter((w) => w.end_time > start && w.start_time < end)
}

function cutPointsForUnknown(start: number, end: number, windows: UiSpeakingWindow[]): number[] {
  const points = new Set<number>([start, end])
  for (const window of windows) {
    if (window.start_time > start && window.start_time < end) points.add(window.start_time)
    if (window.end_time > start && window.end_time < end) points.add(window.end_time)
  }
  return [...points].sort((a, b) => a - b)
}

function uiSpeakersAt(
  time: number,
  windows: UiSpeakingWindow[]
): Array<{ name: string; user_id: number }> {
  let hit: UiSpeakingWindow | undefined
  for (const window of windows) {
    if (window.start_time <= time && time < window.end_time) hit = window
  }
  return hit ? namedSpeakersOf(hit) : []
}

type SliceDecision =
  | {
      reason: string
      action: "fill"
      speaker: string
      user_id: number
      source: "ui" | "network"
    }
  | { reason: string; action: "midpoint" }
  | { reason: string; action: "defer" }

function decideUnknownSlice(
  speakers: Array<{ name: string; user_id: number }>,
  prev: DiarizationSegment | undefined,
  next: DiarizationSegment | undefined
): SliceDecision {
  if (speakers.length === 0) {
    return { reason: "no_ui", action: "defer" }
  }
  if (speakers.length === 1) {
    return {
      reason: "sole_ui",
      action: "fill",
      speaker: speakers[0].name,
      user_id: speakers[0].user_id,
      source: "ui"
    }
  }
  const sameNeighbour = Boolean(
    prev && next && isNamed(prev) && isNamed(next) && prev.speaker === next.speaker
  )
  if (sameNeighbour && prev) {
    const others = speakers.filter((s) => s.name !== prev.speaker)
    if (others.length === 1) {
      return {
        reason: "same_neighbour_ui_other",
        action: "fill",
        speaker: others[0].name,
        user_id: others[0].user_id,
        source: "ui"
      }
    }
    if (others.length === 0) {
      return {
        reason: "same_neighbour_merge",
        action: "fill",
        speaker: prev.speaker,
        user_id: prev.user_id,
        source: prev.source === "ui" ? "ui" : "network"
      }
    }
    return { reason: "same_neighbour_multi_other", action: "defer" }
  }
  const hasPrev = Boolean(prev && isNamed(prev) && speakers.some((s) => s.name === prev.speaker))
  const hasNext = Boolean(next && isNamed(next) && speakers.some((s) => s.name === next.speaker))
  if (hasPrev && !hasNext && prev) {
    return {
      reason: "multi_prev_only",
      action: "fill",
      speaker: prev.speaker,
      user_id: prev.user_id,
      source: prev.source === "ui" ? "ui" : "network"
    }
  }
  if (hasNext && !hasPrev && next) {
    return {
      reason: "multi_next_only",
      action: "fill",
      speaker: next.speaker,
      user_id: next.user_id,
      source: next.source === "ui" ? "ui" : "network"
    }
  }
  if (hasPrev && hasNext) {
    return { reason: "multi_both_neighbours", action: "midpoint" }
  }
  return { reason: "multi_neither", action: "defer" }
}

function fillUnknownsFromUi(
  segments: DiarizationSegment[],
  uiWindows: UiSpeakingWindow[]
): DiarizationSegment[] {
  const current = normalize(segments).map((segment) => ({ ...segment }))
  const out: DiarizationSegment[] = []
  let filled = 0
  let sliceCount = 0
  let skippedNoUi = 0

  for (let index = 0; index < current.length; index++) {
    const seg = current[index]
    if (seg.speaker !== UNKNOWN_SPEAKER) {
      out.push(seg)
      continue
    }
    const prev = out[out.length - 1]
    const next = current[index + 1]
    const prevNamed = prev && isNamed(prev) ? prev : undefined
    const nextNamed = next && isNamed(next) ? next : undefined
    const overlapping = uiWindowsOverlapping(seg.start_time, seg.end_time, uiWindows)
    const points = cutPointsForUnknown(seg.start_time, seg.end_time, overlapping)

    for (let p = 0; p < points.length - 1; p++) {
      const sliceStart = points[p]
      const sliceEnd = points[p + 1]
      if (sliceEnd <= sliceStart) continue
      sliceCount++
      const mid = (sliceStart + sliceEnd) / 2
      const speakers = uiSpeakersAt(mid, overlapping)
      const decision = decideUnknownSlice(speakers, prevNamed, nextNamed)
      const sliceLabel = `slice=${p + 1}/${points.length - 1}`
      const baseLog =
        `[UnknownCleanup] decide t=${sliceStart.toFixed(3)}-${sliceEnd.toFixed(3)} ` +
        `dur_ms=${Math.round((sliceEnd - sliceStart) * 1000)} orphan_id=${seg.user_id} ` +
        `prev_id=${prevNamed?.user_id ?? "-"} next_id=${nextNamed?.user_id ?? "-"} ` +
        `ui_speakers=${speakers.length} ${sliceLabel} reason=${decision.reason}`

      if (decision.action === "fill") {
        out.push({
          speaker: decision.speaker,
          user_id: decision.user_id,
          start_time: sliceStart,
          end_time: sliceEnd,
          source: decision.source
        })
        filled++
        console.log(`${baseLog} action=fill`)
      } else if (decision.action === "midpoint" && prevNamed && nextNamed) {
        const split = (sliceStart + sliceEnd) / 2
        out.push({
          speaker: prevNamed.speaker,
          user_id: prevNamed.user_id,
          start_time: sliceStart,
          end_time: split,
          source: prevNamed.source === "ui" ? "ui" : "network"
        })
        out.push({
          speaker: nextNamed.speaker,
          user_id: nextNamed.user_id,
          start_time: split,
          end_time: sliceEnd,
          source: nextNamed.source === "ui" ? "ui" : "network"
        })
        filled += 2
        console.log(`${baseLog} action=midpoint_split`)
      } else {
        out.push({
          speaker: UNKNOWN_SPEAKER,
          user_id: seg.user_id,
          start_time: sliceStart,
          end_time: sliceEnd,
          source: seg.source
        })
        skippedNoUi++
        console.log(`${baseLog} action=defer_nearest`)
      }
    }
  }

  const coalesced = coalesceAdjacent(out)
  const remaining = coalesced.filter((s) => s.speaker === UNKNOWN_SPEAKER).length
  console.log(
    `[UnknownCleanup] pass2_ui filled=${filled} slices=${sliceCount} skipped_no_ui=${skippedNoUi} remaining_unknown=${remaining}`
  )
  return coalesced
}

function mergeNearestUnknowns(segments: DiarizationSegment[]): DiarizationSegment[] {
  const current = normalize(segments).map((segment) => ({ ...segment }))
  const out: DiarizationSegment[] = []
  let merged = 0

  for (let index = 0; index < current.length; index++) {
    const seg = current[index]
    if (seg.speaker !== UNKNOWN_SPEAKER) {
      out.push(seg)
      continue
    }
    const prev = out[out.length - 1]
    const next = current[index + 1]
    const prevOk = Boolean(prev && isNamed(prev) && prev.end_time === seg.start_time)
    const nextOk = Boolean(next && isNamed(next) && seg.end_time === next.start_time)

    if (!prevOk && !nextOk) {
      out.push(seg)
      console.log(
        `[UnknownCleanup] decide t=${seg.start_time.toFixed(3)}-${seg.end_time.toFixed(3)} ` +
          `dur_ms=${Math.round((seg.end_time - seg.start_time) * 1000)} orphan_id=${seg.user_id} ` +
          `prev_id=- next_id=- ui_speakers=0 reason=no_neighbour action=keep_unknown`
      )
      continue
    }

    const mid = (seg.start_time + seg.end_time) / 2
    const usePrev =
      prevOk &&
      (!nextOk ||
        mid - (prev as DiarizationSegment).end_time <=
          (next as DiarizationSegment).start_time - mid)

    if (usePrev && prev) {
      prev.end_time = seg.end_time
      merged++
      console.log(
        `[UnknownCleanup] decide t=${seg.start_time.toFixed(3)}-${seg.end_time.toFixed(3)} ` +
          `dur_ms=${Math.round((seg.end_time - seg.start_time) * 1000)} orphan_id=${seg.user_id} ` +
          `prev_id=${prev.user_id} next_id=${nextOk && next ? next.user_id : "-"} ` +
          `ui_speakers=0 reason=no_ui action=nearest_prev`
      )
    } else if (next) {
      next.start_time = seg.start_time
      merged++
      console.log(
        `[UnknownCleanup] decide t=${seg.start_time.toFixed(3)}-${seg.end_time.toFixed(3)} ` +
          `dur_ms=${Math.round((seg.end_time - seg.start_time) * 1000)} orphan_id=${seg.user_id} ` +
          `prev_id=${prevOk && prev ? prev.user_id : "-"} next_id=${next.user_id} ` +
          `ui_speakers=0 reason=no_ui action=nearest_next`
      )
    }
  }

  const coalesced = coalesceAdjacent(out)
  const remaining = coalesced.filter((s) => s.speaker === UNKNOWN_SPEAKER).length
  console.log(`[UnknownCleanup] pass3_nearest merged=${merged} remaining_unknown=${remaining}`)
  return coalesced
}

export function cleanupUnknownSegments(
  segments: DiarizationSegment[],
  uiWindows: UiSpeakingWindow[] = []
): DiarizationSegment[] {
  return mergeNearestUnknowns(fillUnknownsFromUi(segments, uiWindows))
}

/**
 * A primary dominated by one identity, contradicted by a lower-trust source that
 * shares that identity and gives the others several times more time. Bots excluded.
 *
 * This is the shared-mic / pinned-device class (prod 22e3adba, acf4eecf; 0.5% of
 * speech bots in the week of 2026-09-11, ~10 min of a second person each): the
 * network path is internally consistent but attributes two people to one name,
 * and only the UI indicator ever saw the second person.
 */
export function detectSourceDissonance(
  sources: TimelineSource[],
  botNames: string[] = []
): { dissonance: SpeakerSourceDissonance; challengerIndex: number } | undefined {
  if (sources.length < 2) return undefined

  const primaryDurations = speakerDurations(sources[0].segments, botNames)
  const primaryEffective = effectiveSpeakers(primaryDurations)
  if (primaryEffective.length === 0) return undefined

  const primaryNamedSeconds = [...primaryDurations.values()].reduce((a, b) => a + b, 0)
  if (primaryNamedSeconds <= 0) return undefined

  let dominant = primaryEffective[0]
  for (const entry of primaryEffective) {
    if (entry[1] > dominant[1]) dominant = entry
  }
  const dominance = dominant[1] / primaryNamedSeconds
  if (dominance < SOURCE_DISSONANCE_DOMINANCE_RATIO) return undefined

  const primaryOtherSeconds = primaryNamedSeconds - dominant[1]
  const requiredOtherSeconds = Math.max(
    SOURCE_DISSONANCE_MIN_SPEAKER_SECONDS,
    primaryOtherSeconds * SOURCE_DISSONANCE_DISAGREEMENT_FACTOR
  )

  for (let index = 1; index < sources.length; index++) {
    const challengerDurations = speakerDurations(sources[index].segments, botNames)
    const challengerEffective = effectiveSpeakers(challengerDurations)
    if (challengerEffective.length < 2) continue
    if (!challengerEffective.some(([speaker]) => speaker === dominant[0])) continue

    const challengerOtherSeconds = challengerEffective
      .filter(([speaker]) => speaker !== dominant[0])
      .reduce((sum, [, seconds]) => sum + seconds, 0)
    if (challengerOtherSeconds < requiredOtherSeconds) continue

    return {
      challengerIndex: index,
      dissonance: {
        reason: "primary_dominated_challenger_multi_speaker",
        demotedSource: sources[0].kind,
        promotedSource: sources[index].kind,
        primaryEffectiveSpeakers: primaryEffective.length,
        challengerEffectiveSpeakers: challengerEffective.length,
        primaryDominance: Number(dominance.toFixed(3)),
        primaryOtherSeconds: Number(primaryOtherSeconds.toFixed(1)),
        challengerOtherSeconds: Number(challengerOtherSeconds.toFixed(1))
      }
    }
  }
  return undefined
}

/**
 * Resolve each observed interval independently. Resolved network identity wins;
 * a single fresh named UI participant fills missing or unresolved network time.
 * Transcription is the last naming fallback.
 * Unknown network identities survive when no source can name them. Never
 * extend a name into unobserved time or merge distinct unresolved participants.
 * UI freshness and self filtering are enforced by the observation buffer.
 *
 * One exception to network-first: when the whole-call comparison shows the
 * primary collapsed two people into one (see detectSourceDissonance), the
 * corroborating source wins every interval it can name on its own, the other
 * fallbacks come next, and the collapsed primary only covers what nothing else
 * observed.
 */
export function assembleSpeakerTimeline(
  sources: TimelineSource[],
  meetingEnd: number,
  options?: {
    botNames?: string[]
    uiSpeakingWindows?: UiSpeakingWindow[]
    retrofitLeadingGap?: boolean
  }
): {
  segments: DiarizationSegment[]
  filledBySource: Partial<Record<TimelineSourceKind, number>>
  sourceDissonance?: SpeakerSourceDissonance
} {
  const excluded = new Set((options?.botNames ?? []).map((name) => name.trim().toLowerCase()))
  const dissonance = detectSourceDissonance(sources, options?.botNames)?.dissonance
  const precedence: TimelineSourceKind[] = dissonance
    ? [
        dissonance.promotedSource,
        ...(["ui", "transcription"] as TimelineSourceKind[]).filter(
          (kind) => kind !== dissonance.promotedSource && kind !== dissonance.demotedSource
        ),
        dissonance.demotedSource
      ]
    : ["network", "ui", "transcription"]
  type Entry = { segment: DiarizationSegment; kind: TimelineSourceKind }
  const events = new Map<number, Array<{ entry: Entry; opening: boolean }>>()
  for (const source of sources) {
    for (const segment of source.segments) {
      const start = Math.max(0, segment.start_time)
      const end = Math.min(meetingEnd, segment.end_time)
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
      if (excluded.has(segment.speaker.trim().toLowerCase())) continue
      const entry: Entry = { segment, kind: source.kind }
      events.set(start, [...(events.get(start) ?? []), { entry, opening: true }])
      events.set(end, [...(events.get(end) ?? []), { entry, opening: false }])
    }
  }
  const boundaries = [...events.keys()].sort((a, b) => a - b)
  const active = new Set<Entry>()
  const segments: DiarizationSegment[] = []
  const filledBySource: Partial<Record<TimelineSourceKind, number>> = {}
  // Per identity, so interleaved overlapping network speakers can also coalesce.
  const tails = new Map<string, DiarizationSegment>()
  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index]
    const end = boundaries[index + 1]
    for (const { entry, opening } of events.get(start) ?? []) {
      if (opening) active.add(entry)
      else active.delete(entry)
    }
    const byKind = (kind: TimelineSourceKind) => [...active].filter((entry) => entry.kind === kind)
    const network = byKind("network")
    // Network: any resolved identity keeps the whole (possibly concurrent) set.
    // UI: exactly one named identity, never an ambiguous or unnamed one.
    // Transcription: named entries only.
    const candidate = (kind: TimelineSourceKind): Entry[] | undefined => {
      const entries = byKind(kind)
      if (kind === "network") {
        return entries.some(({ segment }) => isNamed(segment)) ? entries : undefined
      }
      if (kind === "ui") {
        const identities = new Set(
          entries.map(({ segment }) => `${segment.user_id}:${segment.speaker}`)
        )
        return identities.size === 1 && entries.every(({ segment }) => isNamed(segment))
          ? entries.slice(0, 1)
          : undefined
      }
      const named = entries.filter(({ segment }) => isNamed(segment))
      return named.length > 0 ? named : undefined
    }
    let selected: Entry[] | undefined
    for (const kind of precedence) {
      selected = candidate(kind)
      if (selected) break
    }
    selected ??= network
    const emitted = new Set<string>()
    for (const { segment, kind } of selected) {
      const key = `${kind}:${segment.user_id}:${segment.speaker}`
      if (emitted.has(key)) continue
      emitted.add(key)
      const previous = tails.get(key)
      if (previous?.end_time === start) {
        previous.end_time = end
      } else {
        const resolved = {
          ...segment,
          start_time: start,
          end_time: end,
          source: kind
        }
        segments.push(resolved)
        tails.set(key, resolved)
        filledBySource[kind] = (filledBySource[kind] ?? 0) + 1
      }
    }
  }
  const cleaned = cleanupUnknownSegments(
    collapseShortUnknownSandwiches(segments),
    options?.uiSpeakingWindows ?? []
  )
  // Only repair an empty greeting window. Never overwrite earlier observed
  // speech or inflate a late first speaker into a whole-call attribution.
  const first = cleaned[0]
  if (
    options?.retrofitLeadingGap &&
    first &&
    isNamed(first) &&
    first.start_time > 0 &&
    first.start_time <= LEADING_RETROFIT_MAX_SECONDS
  ) {
    console.log(
      `[DiarizationTracker] Boot-gap retrofit from +${first.start_time.toFixed(1)}s (cap ${LEADING_RETROFIT_MAX_SECONDS}s)`
    )
    first.start_time = 0
  }
  return {
    segments: cleaned,
    filledBySource,
    sourceDissonance: dissonance
  }
}
