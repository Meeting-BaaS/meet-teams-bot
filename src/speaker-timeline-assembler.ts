import type { DiarizationSegment } from "./diarization-tracker"
import { UNKNOWN_SPEAKER } from "./types"

export type TimelineSourceKind = "network" | "ui" | "transcription"

export interface TimelineSource {
  kind: TimelineSourceKind
  segments: DiarizationSegment[]
}

const isNamed = (segment: DiarizationSegment): boolean =>
  Boolean(segment.speaker.trim()) && segment.speaker.trim() !== UNKNOWN_SPEAKER

/**
 * Resolve each observed interval independently. A single named UI participant
 * wins; ambiguous/absent UI falls back to network identity, then transcription.
 * Unknown network identities survive when no source can name them. Never
 * extend a name into unobserved time or merge distinct unresolved participants.
 * UI freshness and self filtering are enforced by the observation buffer.
 */
export function assembleSpeakerTimeline(
  sources: TimelineSource[],
  meetingEnd: number,
  options?: { botNames?: string[] }
): {
  segments: DiarizationSegment[]
  filledBySource: Partial<Record<TimelineSourceKind, number>>
} {
  const excluded = new Set((options?.botNames ?? []).map((name) => name.trim().toLowerCase()))
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
    const ui = byKind("ui")
    const uiIdentities = new Set(ui.map(({ segment }) => `${segment.user_id}:${segment.speaker}`))
    const network = byKind("network")
    const namedNetwork = network.filter(({ segment }) => isNamed(segment))
    const transcription = byKind("transcription").filter(({ segment }) => isNamed(segment))
    const selected =
      uiIdentities.size === 1 && ui.every(({ segment }) => isNamed(segment))
        ? ui.slice(0, 1)
        : namedNetwork.length > 0
          ? network
          : transcription.length > 0
            ? transcription
            : network
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
  return { segments, filledBySource }
}
