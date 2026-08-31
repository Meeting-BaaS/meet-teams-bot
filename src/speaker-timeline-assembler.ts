import type { DiarizationSegment } from "./diarization-tracker"
import { UNKNOWN_SPEAKER } from "./types"

/**
 * Final speaker-timeline assembly: one pure function that re-assembles the
 * diarization artifact from every source we have, taking the best source for
 * each stretch of the meeting.
 *
 * Sources, in trust order:
 *  - "network"       — WebRTC interception (CSRC/dcrpc/roster). Carries device
 *                      ids, survives DOM changes: authoritative wherever it
 *                      produced data.
 *  - "ui"            — the platform's own UI active-speaker indicator,
 *                      shadow-buffered for the whole call. Fills holes the
 *                      network path left.
 *  - "transcription" — speaker turns from the live transcription system, when
 *                      one ran. Last resort for stretches neither of the
 *                      above covered.
 *
 * A lower-trust source NEVER overwrites a higher-trust one: it only
 * contributes the parts of its segments that fall inside a sufficiently large
 * hole of everything assembled before it.
 */

export type TimelineSourceKind = "network" | "ui" | "transcription"

export interface TimelineSource {
  kind: TimelineSourceKind
  segments: DiarizationSegment[]
}

// A hole in the assembled timeline must be at least this long before a
// lower-trust source is consulted — shorter holes are ordinary turn-taking
// silence.
export const GAP_FILL_MIN_SECONDS = 10
// A clipped contribution must keep at least this much of itself to be worth
// emitting.
export const MIN_SEGMENT_SECONDS = 1
// How far back the first segment may be stretched to cover the boot gap
// (recording start → first diarization signal). Beyond this something else is
// broken, and claiming the whole leading window would mislabel real speech.
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
 * diarization source was live (the boot gap — typically the "thanks for
 * letting the bot in" greeting, observed in prod as a leading "Unknown" run of
 * 1-4 utterances) inherits the first identified speaker.
 */
function retrofitLeadingGap(segments: DiarizationSegment[]): DiarizationSegment[] {
  let firstNamed: DiarizationSegment | null = null
  for (const s of segments) {
    if (s.speaker === UNKNOWN_SPEAKER) continue
    if (!firstNamed || s.start_time < firstNamed.start_time) firstNamed = s
  }
  if (
    !firstNamed ||
    firstNamed.start_time <= 0 ||
    firstNamed.start_time > LEADING_RETROFIT_MAX_SECONDS
  ) {
    return segments
  }
  const target = firstNamed
  return segments.map((s) => (s === target ? { ...s, start_time: 0 } : s))
}

/**
 * Assemble the final timeline. `sources` must be ordered highest-trust first;
 * each source contributes only where everything before it left a hole.
 */
export function assembleSpeakerTimeline(
  sources: TimelineSource[],
  meetingEnd: number
): { segments: DiarizationSegment[]; filledBySource: Partial<Record<TimelineSourceKind, number>> } {
  let assembled: DiarizationSegment[] = []
  const filledBySource: Partial<Record<TimelineSourceKind, number>> = {}

  for (const [index, source] of sources.entries()) {
    if (index === 0) {
      // The primary source is taken as-is (Unknowns included — the repair
      // passes upstream had their chance to name them, and downstream mapping
      // still uses their spans).
      assembled = normalize(source.segments)
      continue
    }
    const clipped = clipIntoGaps(
      normalize(source.segments),
      gapsIn(coverageOf(assembled), meetingEnd)
    )
    if (clipped.length > 0) {
      filledBySource[source.kind] = clipped.length
      assembled = normalize([...assembled, ...clipped])
    }
  }

  return { segments: retrofitLeadingGap(assembled), filledBySource }
}
