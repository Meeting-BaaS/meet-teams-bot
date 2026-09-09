// Meeting scope for the Teams roster interceptor.
//
// An ANONYMOUS bot's browser only ever knows the one meeting it joined, so the
// interceptor could merge any roster-shaped payload it saw and stay correct.
// A SIGNED-IN bot's browser is a full Teams client for the M365 account, and it
// fetches state scoped to the ACCOUNT — including other calls that account is in
// when several bots run concurrently on the same teams_login. Merging those mixed
// foreign participants into this bot's roster, and (via the per-call mediaStream
// sourceId map, whose ids are only unique within one call) occasionally pinned a
// foreign display name onto this bot's OWN audio.
//
// Scoping needs exactly one fact: which conversation this bot actually joined.

/**
 * Teams conversation (thread) ids: `19:meeting_<...>@thread.v2` for scheduled
 * meetings, `19:<...>@thread.tacv2` / `@thread.skype` for the other call shapes.
 *
 * Built per call — a shared /g/ regex carries `lastIndex` between calls and would
 * silently skip matches.
 */
function conversationRe(): RegExp {
  return /19:[^@"'\\/\s]+@thread\.[a-z0-9]+/gi
}

export interface TeamsMeetingScope {
  /**
   * The joined conversation, lowercased for comparison. Null when the join URL
   * carries no thread id — short `/meet/<code>` links and the personal-Teams
   * launcher resolve the conversation only after the client joins, so the browser
   * side latches it from the live call instead.
   */
  conversationId: string | null
}

/**
 * Every Teams conversation id in `text`, lowercased and de-duplicated.
 *
 * Searches the raw text and, separately, its percent-decoded form: ids travel
 * URL-encoded in query strings (`19%3Ameeting_...%40thread.v2`) and raw in paths
 * and JSON bodies.
 */
export function findConversationIds(text: string): string[] {
  if (!text) return []

  const candidates = [text]
  try {
    const decoded = decodeURIComponent(text)
    if (decoded !== text) candidates.push(decoded)
  } catch {
    // Malformed percent-encoding — the raw pass still applies.
  }

  const found = new Set<string>()
  for (const candidate of candidates) {
    const matches = candidate.match(conversationRe())
    if (matches) {
      for (const match of matches) found.add(match.toLowerCase())
    }
  }
  return [...found]
}

/**
 * The conversation this bot was sent to join, read off the join URL.
 *
 * Deep links (`/l/meetup-join/<threadId>/<messageId>`) carry it directly — that
 * covers scheduled meetings, which is where concurrent signed-in sessions on one
 * account actually happen. Anything else returns null and is resolved in-page.
 */
export function deriveMeetingScope(joinUrl: string): TeamsMeetingScope {
  const ids = findConversationIds(joinUrl ?? "")
  // A join URL names exactly one conversation; if a link ever carried more than
  // one, guessing which is the meeting would be worse than staying permissive.
  return { conversationId: ids.length === 1 ? ids[0] : null }
}

/**
 * What the browser-side bundle receives. Serialized into the injected script, so
 * it must stay JSON-safe.
 */
export interface TeamsInterceptorScope extends TeamsMeetingScope {
  /**
   * True when the bot signed into an M365 account (`teams_login_config` present).
   * Signed-in bots are the only ones whose page can see another meeting's roster,
   * and they scope strictly: see `resolveRosterScope`.
   */
  isAuthenticated: boolean
}

export type RosterScopeReason =
  /** This bot's own conversation isn't identified yet — nothing to compare against. */
  | "own-unknown"
  /** The payload names our conversation and only ours. */
  | "match"
  /** The payload names conversations, none of them ours. */
  | "foreign"
  /** Names ours AND others: an account-scoped aggregate, not one call's roster. */
  | "aggregate"
  /** Names no conversation at all. */
  | "unplaceable"

export interface RosterScopeVerdict {
  accept: boolean
  reason: RosterScopeReason
}

/** Signature the browser bundle receives; see resolveRosterScope. */
export type RosterScopeResolver = (input: {
  own: string | null
  url?: string
  body?: string
  isAuthenticated: boolean
  strict: boolean
}) => RosterScopeVerdict

/**
 * Decide whether a roster payload belongs to the meeting this bot joined.
 *
 * SELF-CONTAINED: this is stringified into the page alongside the interceptor
 * bundle (same mechanism as `resolveSpeakingSet`), so it must not reference
 * anything outside its own body — no imports, no module-level constants.
 *
 * An ANONYMOUS bot keeps its pre-existing behaviour exactly: its page only ever
 * knows the one meeting it joined, so only proven-foreign payloads are dropped and
 * nothing is taken away from the path that never had an incident.
 *
 * A SIGNED-IN bot scopes strictly — a payload merges only if it proves it belongs
 * to this meeting. That is what actually closes the leak, since a foreign payload
 * carrying no conversation id would otherwise still merge. The caller relaxes
 * `strict` on its own if strict scoping ever turns out to starve a real roster.
 *
 * @param own - The joined conversation, or any raw string containing it (a live
 *   call's threadId). Null/unrecognized means "not yet identified".
 */
export function resolveRosterScope(input: {
  own: string | null
  url?: string
  body?: string
  isAuthenticated: boolean
  strict: boolean
}): RosterScopeVerdict {
  const CONVERSATION = /19:[^@"'\\/\s]+@thread\.[a-z0-9]+/gi

  const idsIn = (text: string | null | undefined): string[] => {
    if (!text) return []
    const candidates = [text]
    try {
      const decoded = decodeURIComponent(text)
      if (decoded !== text) candidates.push(decoded)
    } catch {
      // Malformed percent-encoding — the raw pass still applies.
    }
    const found: string[] = []
    for (const candidate of candidates) {
      const matches = candidate.match(CONVERSATION)
      if (!matches) continue
      for (const match of matches) {
        const lower = match.toLowerCase()
        if (found.indexOf(lower) === -1) found.push(lower)
      }
    }
    return found
  }

  const ownIds = idsIn(input.own)
  if (ownIds.length !== 1) return { accept: true, reason: "own-unknown" }
  const ownId = ownIds[0]

  const seen: string[] = []
  for (const source of [input.url, input.body]) {
    for (const id of idsIn(source)) {
      if (seen.indexOf(id) === -1) seen.push(id)
    }
  }

  if (seen.length === 0) {
    const strictDrop = input.strict && input.isAuthenticated
    return { accept: !strictDrop, reason: "unplaceable" }
  }

  if (seen.indexOf(ownId) === -1) return { accept: false, reason: "foreign" }

  if (seen.length > 1 && input.isAuthenticated) {
    // Our own participants still arrive on the call-scoped snapshot and the
    // socket deltas, so dropping the aggregate costs nothing it carried.
    return { accept: false, reason: "aggregate" }
  }

  return { accept: true, reason: "match" }
}
