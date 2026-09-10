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
  if (ownIds.length !== 1) {
    // Signed-in and strict: held until our meeting is known (the caller quarantines it).
    return { accept: !(input.isAuthenticated && input.strict), reason: "own-unknown" }
  }
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
    // Never merged wholesale, relaxed or not; the caller extracts our own part.
    return { accept: false, reason: "aggregate" }
  }

  return { accept: true, reason: "match" }
}

// Deepest roster sub-object naming ONLY our conversation, or null.
// SELF-CONTAINED: stringified into the page.
export function extractOwnRoster(body: unknown, own: string | null): unknown {
  const CONVERSATION = /19:[^@"'\\/\s]+@thread\.[a-z0-9]+/gi
  const idsIn = (text: string): string[] => {
    let decoded = text
    try {
      decoded = decodeURIComponent(text)
    } catch {
      // Malformed percent-encoding — the raw pass still applies.
    }
    const found: string[] = []
    for (const candidate of decoded === text ? [text] : [text, decoded]) {
      for (const match of candidate.match(CONVERSATION) || []) {
        const lower = match.toLowerCase()
        if (found.indexOf(lower) === -1) found.push(lower)
      }
    }
    return found
  }

  if (!own) return null
  const ownIds = idsIn(own)
  if (ownIds.length !== 1) return null
  const ownId = ownIds[0]

  const isOwnRoster = (node: Record<string, unknown>): boolean => {
    if (!("participants" in node) && !("roster" in node)) return false
    try {
      const ids = idsIn(JSON.stringify(node))
      return ids.length === 1 && ids[0] === ownId
    } catch {
      return false
    }
  }

  const visit = (node: unknown, depth: number): unknown => {
    if (!node || typeof node !== "object" || depth > 8) return null
    for (const child of Object.values(node as Record<string, unknown>)) {
      const found = visit(child, depth + 1)
      if (found) return found
    }
    return !Array.isArray(node) && isOwnRoster(node as Record<string, unknown>) ? node : null
  }
  return visit(body, 0)
}

export type OwnRosterExtractor = typeof extractOwnRoster
