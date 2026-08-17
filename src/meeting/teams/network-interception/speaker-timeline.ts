// Who was speaking at instant T. Ranks evidence instead of switching sources:
// dsh only re-reports on a speaker CHANGE, so it stays "fresh" for DSH_FRESH_MS
// while still naming the previous speaker.
//
// Separate from browser-bundle.ts, which is stringified and cannot import — this
// is injected the same way, and is therefore testable.

/** Which rung decided the answer. Logged, never PII. */
export type SpeakerTimelineRung =
  | "csrc"
  | "caption-interval"
  | "dsh-fresh"
  | "caption-window"
  | "dsh-stale"
  | "silence"

export interface SpeakerTimelineEvidence {
  csrcAvailable: boolean
  /** Only meaningful when csrcAvailable. */
  csrcSpeaking: string[]
  /** deviceIds whose caption interval CONTAINS the instant, on the audio clock. */
  captionAtInstant: string[]
  /** deviceIds from the caption hold + wall-clock windows. Superset of the above. */
  captionWindowed: string[]
  dominant: string | null
  /** Whether the dsh event behind `dominant` is inside DSH_FRESH_MS. */
  dominantFresh: boolean
  /** True once caption results are arriving, not merely requested. */
  captionsEnabled: boolean
  /** This update ENDS an utterance: it must be able to emit silence. */
  captionExpiry: boolean
}

export interface SpeakerTimelineDecision {
  deviceIds: string[]
  rung: SpeakerTimelineRung
}

/** Pure and closure-free — it is stringified into the page. */
export function resolveSpeakingSet(evidence: SpeakerTimelineEvidence): SpeakerTimelineDecision {
  if (evidence.csrcAvailable) {
    return { deviceIds: evidence.csrcSpeaking, rung: "csrc" }
  }

  // A caption covering this instant beats a dsh that merely has not expired.
  // Gated on dominantFresh so caption-only sessions keep their old behaviour:
  // there rungs 3/5 cannot fire and captionWindowed already covers this set.
  if (evidence.dominantFresh && !evidence.captionExpiry && evidence.captionAtInstant.length > 0) {
    return { deviceIds: evidence.captionAtInstant, rung: "caption-interval" }
  }

  if (evidence.dominant && !evidence.captionExpiry && evidence.dominantFresh) {
    return { deviceIds: [evidence.dominant], rung: "dsh-fresh" }
  }

  if (evidence.captionWindowed.length > 0) {
    return { deviceIds: evidence.captionWindowed, rung: "caption-window" }
  }

  // Gated on captionsEnabled, not freshness: a healthy call may emit dsh only on
  // changes, so dropping a stale dominant would silence a monologue.
  if (evidence.dominant && !evidence.captionExpiry && !evidence.captionsEnabled) {
    return { deviceIds: [evidence.dominant], rung: "dsh-stale" }
  }

  return { deviceIds: [], rung: "silence" }
}

/** Signature of the resolver as the browser bundle receives it. */
export type SpeakerSetResolver = typeof resolveSpeakingSet
