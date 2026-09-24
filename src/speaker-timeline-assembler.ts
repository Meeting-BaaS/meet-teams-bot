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
/**
 * Meet's loudest-speaker path can briefly promote an orphan SSRC (no roster
 * name) and emit a contiguous `Unknown` blip between two stretches of the same
 * named person. Those spans are ranking flicker, not a real third speaker —
 * real syllables are well above this. Only Unknown is eligible: a short named
 * turn between different people is a legitimate handoff and must stay.
 */
export const SHORT_UNKNOWN_MAX_SECONDS = 0.5

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
  return [...durations].filter(
    ([, seconds]) => seconds >= SOURCE_DISSONANCE_MIN_SPEAKER_SECONDS
  )
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

function cutPointsForUnknown(
  start: number,
  end: number,
  windows: UiSpeakingWindow[]
): number[] {
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
  | { reason: string; action: "fill"; speaker: string; user_id: number; source: "ui" | "network" }
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
  const sameNeighbour =
    Boolean(prev && next && isNamed(prev) && isNamed(next) && prev.speaker === next.speaker)
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
  const hasPrev = Boolean(
    prev && isNamed(prev) && speakers.some((s) => s.name === prev.speaker)
  )
  const hasNext = Boolean(
    next && isNamed(next) && speakers.some((s) => s.name === next.speaker)
  )
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
  console.log(
    `[UnknownCleanup] pass3_nearest merged=${merged} remaining_unknown=${remaining}`
  )
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
  options?: { botNames?: string[]; uiSpeakingWindows?: UiSpeakingWindow[] }
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
  return {
    segments: cleanupUnknownSegments(
      collapseShortUnknownSandwiches(segments),
      options?.uiSpeakingWindows ?? []
    ),
    filledBySource,
    sourceDissonance: dissonance
  }
}
