import type { DiarizationSegment } from "./diarization-tracker"
import { UNKNOWN_SPEAKER } from "./types"

/**
 * Final speaker-timeline assembly: re-assembles the diarization artifact from
 * every source, best source per stretch. Trust order: network (WebRTC
 * interception — authoritative wherever it produced data) > ui (the platform's
 * own active-speaker indicator, shadow-buffered whole-call) > transcription
 * (live transcription-system turns, when one ran). A lower-trust source never
 * overwrites a higher-trust one — it only fills sufficiently large holes —
 * unless a lower-trust source proves the primary collapsed onto one
 * participant (see detectSourceDissonance).
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
// Cap on stretching the first segment back over the boot gap. The gap this
// exists for is the join greeting (prod: median 3.5s, all observed cases
// <=21s). A larger stretch inflates a barely-heard participant's talk-time
// (prod: 1s -> 147s) past the reconciliation's "effective speaker" floor and
// masked a real collapse; longer leading gaps are the reconciliation's job
// (label-only backfill), never the timeline's.
export const LEADING_RETROFIT_MAX_SECONDS = 20

// --- Source dissonance (primary-collapse) detection ---
// A primary source can fail by being confidently WRONG rather than absent:
// every stretch pinned on one participant. Hole-filling cannot repair that —
// a wrong answer leaves no holes — so on proof of collapse the contradicting
// source is promoted and the primary demoted. Proof is never a bare suspicion:
// a real monologue looks identical from the primary alone.
/** An identity must own this much unambiguous time to count as a speaker. */
export const SOURCE_DISSONANCE_MIN_SPEAKER_SECONDS = 15
/** Share of the primary's named time its top speaker must hold to look collapsed. */
export const SOURCE_DISSONANCE_DOMINANCE_RATIO = 0.85
/**
 * How much MORE time the challenger must give the other speakers than the
 * primary did. Dominance alone is not proof: on a call where one person really
 * does hold 95% of the floor, both sources agree and there is nothing to fix.
 * Requiring the challenger to multiply the others' time is what separates a
 * collapse from a lopsided-but-correct call.
 */
export const SOURCE_DISSONANCE_DISAGREEMENT_FACTOR = 3

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

/** Named, non-bot speaking seconds by normalized identity. */
function speakerDurations(
  segments: DiarizationSegment[],
  excludeSpeakers: string[] = []
): Map<string, number> {
  const excluded = new Set(
    [UNKNOWN_SPEAKER, ...excludeSpeakers].map((name) => name.trim().toLowerCase())
  )
  const bySpeaker = new Map<string, DiarizationSegment[]>()
  for (const segment of normalize(segments)) {
    const key = segment.speaker?.trim().toLowerCase()
    if (!key || excluded.has(key)) continue
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

/** Identities holding at least the effective-speaker floor. */
function effectiveSpeakers(durations: Map<string, number>): Array<[string, number]> {
  return [...durations].filter(
    ([, seconds]) => seconds >= SOURCE_DISSONANCE_MIN_SPEAKER_SECONDS
  )
}

/**
 * Detect the production failure where the primary source pins effectively a
 * whole call on one participant while an independent, lower-trust source saw
 * several people taking turns.
 *
 * Four things must hold, and each rules out a specific false positive:
 *  - the primary is DOMINATED by one effective speaker (not merely "named
 *    exactly one"): a collapse usually leaves slivers of the real second
 *    speaker, and an exclusivity test loses those cases — prod bot acf4eecf
 *    was 5,271 samples against 31, which can clear the effective floor;
 *  - the challenger has two or more effective speakers, so a transient
 *    active-tile misread cannot promote anything;
 *  - the two sources SHARE the dominant identity, which distinguishes a real
 *    collapse from two sources using incompatible naming schemes;
 *  - the challenger gives the OTHER speakers materially more time than the
 *    primary did, which is what separates a collapse from a genuinely lopsided
 *    call that both sources describe the same way.
 * The recording bot is excluded from both sides throughout.
 */
function detectSourceDissonance(
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
  sourceDissonance?: SpeakerSourceDissonance
} {
  let assembled: DiarizationSegment[] = []
  const filledBySource: Partial<Record<TimelineSourceKind, number>> = {}

  // On proof of collapse the challenger leads and the primary goes LAST, not
  // second: it has just been shown wrong about identity, so it should fill
  // holes only after every source we have not disproven. It is demoted rather
  // than dropped — it is wrong about who spoke, not about that speech
  // happened, so it still covers what the challenger left uncovered.
  const detected = detectSourceDissonance(sources, options?.botNames)
  const ordered = detected
    ? [
        sources[detected.challengerIndex],
        ...sources.filter((_, index) => index !== 0 && index !== detected.challengerIndex),
        sources[0]
      ]
    : sources

  for (const [index, source] of ordered.entries()) {
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
    retrofittedFromSeconds,
    sourceDissonance: detected?.dissonance
  }
}
