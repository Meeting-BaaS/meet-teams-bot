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
 * Counts EVERY active non-self, non-excluded row before accepting the name —
 * `[Alice speaking, Unknown speaking]` has two people active and yields null,
 * even though only one of them is named. Self rows (the bot's own marker) and
 * excluded names (bot_name / learned self identity) never qualify.
 */
export function pickFreshUiSpeakerName(params: {
  observed: Pick<SpeakerData, "name" | "isSpeaking" | "isSelf">[]
  excludedNames: string[]
}): string | null {
  const excluded = new Set(params.excludedNames)
  const active = params.observed.filter(
    (speaker) =>
      speaker.isSpeaking === true &&
      speaker.isSelf !== true &&
      !(speaker.name && excluded.has(speaker.name))
  )
  if (active.length !== 1) return null
  const name = active[0].name
  if (!name || name === UNKNOWN_SPEAKER) return null
  return name
}

/**
 * The name to fill into an unresolved (Unknown) network speaker, or null.
 *
 * Guards, in order:
 *  - the update holds exactly one speaking network speaker overall, so a
 *    resolved speaker active next to the unresolved one can never lend it a
 *    name (that would double-name one voice);
 *  - that sole speaker is the unresolved one;
 *  - the UI evidence is fresh (≤ maxAgeMs).
 *
 * Resolved network names are never candidates; callers only fill Unknown ones.
 */
export function chooseLiveFillName(params: {
  networkSpeakingCount: number
  unresolvedSpeakingCount: number
  evidence: { name: string; at: number } | null
  now: number
  maxAgeMs?: number
}): string | null {
  if (params.networkSpeakingCount !== 1 || params.unresolvedSpeakingCount !== 1) return null
  const { evidence } = params
  if (!evidence || !evidence.name) return null
  const maxAge = params.maxAgeMs ?? UI_NAME_FILL_MAX_AGE_MS
  if (params.now - evidence.at > maxAge) return null
  return evidence.name
}
