import type { DiarizationSegment } from "./diarization-tracker"
import { UNKNOWN_SPEAKER } from "./types"

/**
 * Final speaker-timeline assembly: re-assembles the diarization artifact from
 * every source, best source per stretch. Trust order: network (WebRTC
 * interception — authoritative wherever it produced data) > ui (the platform's
 * own active-speaker indicator, shadow-buffered whole-call) > transcription
 * (live transcription-system turns, when one ran). A lower-trust source never
 * overwrites a higher-trust one — it only fills sufficiently large holes.
 */

export type TimelineSourceKind = "network" | "ui" | "transcription"

export interface TimelineSource {
  kind: TimelineSourceKind
  segments: DiarizationSegment[]
}

// Minimum hole size before a lower-trust source is consulted — anything
// shorter is ordinary turn-taking silence.
export const GAP_FILL_MIN_SECONDS = 10
// Minimum length a clipped contribution must keep to be emitted.
export const MIN_SEGMENT_SECONDS = 1
// Cap on stretching the first segment back over the boot gap; a first segment
// later than this means something else broke.
export const LEADING_RETROFIT_MAX_SECONDS = 300

/** Positive-length segments, chronological. */
function normalize(segments: DiarizationSegment[]): DiarizationSegment[] {
  return segments
    .filter((s) => s.end_time > s.start_time)
    .slice()
    .sort((a, b) => a.start_time - b.start_time)
}

/** Union of the segments' spans as merged, sorted intervals. */
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

/** Holes of at least GAP_FILL_MIN_SECONDS in [0, meetingEnd] left by coverage. */
function gapsIn(coverage: Array<[number, number]>, meetingEnd: number): Array<[number, number]> {
  const gaps: Array<[number, number]> = []
  let cursor = 0
  for (const [start, end] of coverage) {
    if (start - cursor >= GAP_FILL_MIN_SECONDS) {
      gaps.push([cursor, start])
    }
    cursor = Math.max(cursor, end)
  }
  if (meetingEnd - cursor >= GAP_FILL_MIN_SECONDS) {
    gaps.push([cursor, meetingEnd])
  }
  return gaps
}

/** The parts of the candidates that fall inside the gaps. */
function clipIntoGaps(
  candidates: DiarizationSegment[],
  gaps: Array<[number, number]>
): DiarizationSegment[] {
  const clipped: DiarizationSegment[] = []
  for (const candidate of candidates) {
    if (!candidate.speaker || candidate.speaker === UNKNOWN_SPEAKER) {
      continue
    }
    for (const [gapStart, gapEnd] of gaps) {
      const start = Math.max(candidate.start_time, gapStart)
      const end = Math.min(candidate.end_time, gapEnd)
      if (end - start >= MIN_SEGMENT_SECONDS) {
        clipped.push({ ...candidate, start_time: start, end_time: end })
      }
    }
  }
  return clipped
}

/**
 * Stretch the earliest NAMED segment back to 0 so speech recorded before any
 * diarization source was live (the boot-gap greeting, the prod leading-
 * "Unknown" class) inherits the first identified speaker.
 */
function retrofitLeadingGap(
  segments: DiarizationSegment[],
  excludeSpeakers?: string[]
): {
  segments: DiarizationSegment[]
  retrofittedFromSeconds?: number
} {
  let firstNamed: DiarizationSegment | null = null
  for (const s of segments) {
    if (s.speaker === UNKNOWN_SPEAKER) continue
    // Never stretch the recording bot's own segment (its join announcement can
    // be the first thing diarized) — the boot gap belongs to a human. Both the
    // configured bot_name and the LEARNED displayed name (SSO: the account's
    // name, which bot_name matching misses) are excluded.
    if (excludeSpeakers?.includes(s.speaker)) continue
    if (!firstNamed || s.start_time < firstNamed.start_time) firstNamed = s
  }
  if (
    !firstNamed ||
    firstNamed.start_time <= 0 ||
    firstNamed.start_time > LEADING_RETROFIT_MAX_SECONDS
  ) {
    return { segments }
  }
  const target = firstNamed
  return {
    segments: segments.map((s) => (s === target ? { ...s, start_time: 0 } : s)),
    retrofittedFromSeconds: target.start_time
  }
}

/**
 * Clip Unknown segments down to what named coverage does not overlap.
 * Downstream mapping picks by overlap, so an Unknown left under a named
 * segment would still win the words the repair names. Uncovered remainders
 * are kept — they mark real speech nothing ever named.
 */
function suppressCoveredUnknowns(segments: DiarizationSegment[]): DiarizationSegment[] {
  const namedCoverage = coverageOf(segments.filter((s) => s.speaker !== UNKNOWN_SPEAKER))
  const out: DiarizationSegment[] = []
  for (const segment of segments) {
    if (segment.speaker !== UNKNOWN_SPEAKER) {
      out.push(segment)
      continue
    }
    let pieces: Array<[number, number]> = [[segment.start_time, segment.end_time]]
    for (const [coverStart, coverEnd] of namedCoverage) {
      const next: Array<[number, number]> = []
      for (const [pieceStart, pieceEnd] of pieces) {
        if (coverEnd <= pieceStart || coverStart >= pieceEnd) {
          next.push([pieceStart, pieceEnd])
          continue
        }
        if (coverStart > pieceStart) next.push([pieceStart, coverStart])
        if (coverEnd < pieceEnd) next.push([coverEnd, pieceEnd])
      }
      pieces = next
    }
    for (const [pieceStart, pieceEnd] of pieces) {
      if (pieceEnd - pieceStart >= MIN_SEGMENT_SECONDS) {
        out.push({ ...segment, start_time: pieceStart, end_time: pieceEnd })
      }
    }
  }
  return normalize(out)
}

/**
 * Assemble the final timeline. `sources` must be ordered highest-trust first;
 * each source contributes only where everything before it left a hole.
 */
export function assembleSpeakerTimeline(
  sources: TimelineSource[],
  meetingEnd: number,
  options?: { botNames?: string[] }
): {
  segments: DiarizationSegment[]
  filledBySource: Partial<Record<TimelineSourceKind, number>>
  retrofittedFromSeconds?: number
} {
  let assembled: DiarizationSegment[] = []
  const filledBySource: Partial<Record<TimelineSourceKind, number>> = {}

  for (const [index, source] of sources.entries()) {
    if (index === 0) {
      // Primary source taken as-is, Unknowns included.
      assembled = normalize(source.segments)
      continue
    }
    // Holes are measured against NAMED coverage only — a named fallback wins
    // a stretch the network could only call "Unknown" (clipped away at the end).
    const clipped = clipIntoGaps(
      normalize(source.segments),
      gapsIn(coverageOf(assembled.filter((s) => s.speaker !== UNKNOWN_SPEAKER)), meetingEnd)
    )
    if (clipped.length > 0) {
      filledBySource[source.kind] = clipped.length
      assembled = normalize([...assembled, ...clipped])
    }
  }

  const { segments, retrofittedFromSeconds } = retrofitLeadingGap(
    assembled,
    options?.botNames
  )
  return {
    segments: suppressCoveredUnknowns(segments),
    filledBySource,
    retrofittedFromSeconds
  }
}
