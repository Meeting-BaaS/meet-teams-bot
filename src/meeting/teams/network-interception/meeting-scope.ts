// A signed-in bot's page also sees the account's other calls, so the Teams roster
// interceptor merges only rosters from the conversation this bot joined.

// Teams thread ids. Built per call: a shared /g/ regex carries lastIndex between calls.
function conversationRe(): RegExp {
  return /19:[^@"'\\/\s]+@thread\.[a-z0-9]+/gi
}

export interface TeamsMeetingScope {
  /** Lowercased; null when the join URL has no thread id (latched in-page instead). */
  conversationId: string | null
}

/** Every conversation id in `text`, raw or percent-encoded, lowercased and de-duplicated. */
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

/** The conversation a meetup-join deep link names; null (resolved in-page) otherwise. */
export function deriveMeetingScope(joinUrl: string): TeamsMeetingScope {
  const ids = findConversationIds(joinUrl ?? "")
  // Don't guess between several ids.
  return { conversationId: ids.length === 1 ? ids[0] : null }
}

/** Serialized into the page, so it must stay JSON-safe. */
export interface TeamsInterceptorScope extends TeamsMeetingScope {
  /** Signed in via `teams_login_config`; only these pages can see other meetings. */
  isAuthenticated: boolean
}

export type RosterScopeReason =
  /** This bot's own conversation isn't identified yet — nothing to compare against. */
  | "own-unknown"
  | "match"
  | "foreign"
  /** Names ours AND others: an account-scoped aggregate, not one call's roster. */
  | "aggregate"
  | "unplaceable"

export interface RosterScopeVerdict {
  accept: boolean
  reason: RosterScopeReason
}

export type RosterScopeResolver = (input: {
  own: string | null
  url?: string
  body?: string
  isAuthenticated: boolean
  strict: boolean
}) => RosterScopeVerdict

/**
 * Whether a roster payload belongs to the joined meeting. Anonymous bots drop only
 * proven-foreign payloads; strict signed-in bots also drop unplaceable ones.
 * Self-contained: it is stringified into the page, so no outside references.
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

  if (seen.length > 1 && input.isAuthenticated && input.strict) {
    // Our participants also arrive call-scoped; `strict` lets a starved session relax.
    return { accept: false, reason: "aggregate" }
  }

  return { accept: true, reason: "match" }
}
