import type { DiarizationSegment } from "./diarization-tracker"
import { UNKNOWN_SPEAKER } from "./types"

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
  return [...durations].filter(
    ([, seconds]) => seconds >= SOURCE_DISSONANCE_MIN_SPEAKER_SECONDS
  )
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
  options?: { botNames?: string[] }
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
  return { segments, filledBySource, sourceDissonance: dissonance }
}
