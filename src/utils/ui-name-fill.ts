import type { SpeakerData } from "../types"
import { UNKNOWN_SPEAKER } from "../types"

/**
 * How long a piece of UI name evidence stays usable for live fills. Short on
 * purpose: the fill is only trustworthy while the person it names is likely
 * still the one on the floor.
 */
export const UI_NAME_FILL_MAX_AGE_MS = 5000

/**
 * The single named person the UI observer currently sees speaking, or null.
 *
 * Returns a name only when EXACTLY ONE named speaker is active, so the fill can
 * never pick between two people. Self rows (the bot's own marker) and excluded
 * names (bot_name / learned self identity) never qualify.
 */
export function pickFreshUiSpeakerName(params: {
  observed: Pick<SpeakerData, "name" | "isSpeaking" | "isSelf">[]
  excludedNames: string[]
}): string | null {
  const excluded = new Set(params.excludedNames)
  const speaking = params.observed.filter(
    (speaker) =>
      speaker.isSpeaking === true &&
      speaker.isSelf !== true &&
      Boolean(speaker.name) &&
      speaker.name !== UNKNOWN_SPEAKER &&
      !excluded.has(speaker.name)
  )
  if (speaking.length !== 1) return null
  return speaking[0].name
}

/**
 * The name to fill into an unresolved (Unknown) network speaker, or null.
 *
 * Guards, in order:
 *  - exactly one unresolved speaker is speaking in this update — two of them
 *    cannot share one name;
 *  - the UI evidence is fresh (≤ maxAgeMs).
 *
 * Resolved network names are never candidates; callers only fill Unknown ones.
 */
export function chooseLiveFillName(params: {
  unresolvedSpeakingCount: number
  evidence: { name: string; at: number } | null
  now: number
  maxAgeMs?: number
}): string | null {
  if (params.unresolvedSpeakingCount !== 1) return null
  const { evidence } = params
  if (!evidence || !evidence.name) return null
  const maxAge = params.maxAgeMs ?? UI_NAME_FILL_MAX_AGE_MS
  if (params.now - evidence.at > maxAge) return null
  return evidence.name
}
