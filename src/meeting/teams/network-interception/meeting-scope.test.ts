import { deriveMeetingScope, findConversationIds, resolveRosterScope } from "./meeting-scope"

const OURS = "19:meeting_ndc4mjy5ndqtnwe2os00@thread.v2"
const THEIRS = "19:meeting_zjjkzwrmnzytytc2os00@thread.v2"

describe("findConversationIds", () => {
  it("finds a raw conversation id in a URL path", () => {
    expect(
      findConversationIds(`https://teams.microsoft.com/api/csa/conversations/${OURS}/roster`)
    ).toEqual([OURS])
  })

  it("finds a percent-encoded id", () => {
    const encoded = encodeURIComponent(OURS)
    expect(encoded).not.toBe(OURS)
    expect(findConversationIds(`https://teams.microsoft.com/api/v1?threadId=${encoded}`)).toEqual([
      OURS
    ])
  })

  it("finds ids inside a JSON body", () => {
    const body = JSON.stringify({ roster: { conversationId: OURS, participants: {} } })
    expect(findConversationIds(body)).toEqual([OURS])
  })

  it("is case-insensitive and de-duplicates", () => {
    const text = `${OURS} ${OURS.toUpperCase()}`
    expect(findConversationIds(text)).toEqual([OURS])
  })

  it("returns every distinct id from an account-scoped aggregate", () => {
    const body = JSON.stringify({ calls: [{ threadId: OURS }, { threadId: THEIRS }] })
    expect(findConversationIds(body).sort()).toEqual([OURS, THEIRS].sort())
  })

  it("matches the other thread suffixes Teams uses", () => {
    expect(findConversationIds("19:abc123@thread.tacv2")).toEqual(["19:abc123@thread.tacv2"])
    expect(findConversationIds("19:abc123@thread.skype")).toEqual(["19:abc123@thread.skype"])
  })

  it("returns nothing for payloads with no conversation id", () => {
    expect(findConversationIds("")).toEqual([])
    expect(findConversationIds('{"participants":{"8:orgid:abc":{"displayName":"A"}}}')).toEqual([])
  })

  it("does not mistake a user MRI for a conversation id", () => {
    expect(findConversationIds("8:orgid:2b9f0e5c-1111-2222-3333-444455556666")).toEqual([])
  })

  it("survives malformed percent-encoding", () => {
    expect(findConversationIds(`%E0%A4%A ${OURS}`)).toEqual([OURS])
  })
})

describe("deriveMeetingScope", () => {
  it("reads the conversation off a meetup-join deep link", () => {
    const url = `https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/${OURS}/0?context=%7B%22Tid%22%3A%22t%22%7D`
    expect(deriveMeetingScope(url).conversationId).toBe(OURS)
  })

  it("reads the conversation off an encoded deep link", () => {
    const url = `https://teams.microsoft.com/l/meetup-join/${encodeURIComponent(OURS)}/0`
    expect(deriveMeetingScope(url).conversationId).toBe(OURS)
  })

  it("yields null for a short /meet/ join code, to be latched in-page", () => {
    expect(
      deriveMeetingScope("https://teams.microsoft.com/meet/357286674199395?p=abc").conversationId
    ).toBeNull()
  })

  it("yields null rather than guessing when a link names several conversations", () => {
    expect(
      deriveMeetingScope(`https://x/l/meetup-join/${OURS}/0?prev=${THEIRS}`).conversationId
    ).toBeNull()
  })

  it("tolerates an empty or missing URL", () => {
    expect(deriveMeetingScope("").conversationId).toBeNull()
    expect(deriveMeetingScope(undefined as unknown as string).conversationId).toBeNull()
  })
})

describe("resolveRosterScope", () => {
  // How the interceptor actually calls this: anonymous bots never scope strictly,
  // signed-in bots do until they self-relax to keep a roster from starving.
  const anon = { isAuthenticated: false, strict: false }
  const signedIn = { isAuthenticated: true, strict: true }
  const signedInRelaxed = { isAuthenticated: true, strict: false }

  it("accepts a payload scoped to our own conversation", () => {
    expect(
      resolveRosterScope({ own: OURS, url: `/csa/conversations/${OURS}/roster`, ...signedIn })
    ).toEqual({ accept: true, reason: "match" })
  })

  it("rejects a payload scoped to another conversation — the concurrent-session leak", () => {
    expect(
      resolveRosterScope({ own: OURS, url: `/csa/conversations/${THEIRS}/roster`, ...signedIn })
    ).toEqual({ accept: false, reason: "foreign" })
  })

  it("rejects a foreign payload identified only by its body", () => {
    const body = JSON.stringify({ roster: { conversationId: THEIRS, participants: {} } })
    expect(resolveRosterScope({ own: OURS, url: "/api/v2/state", body, ...signedIn }).accept).toBe(
      false
    )
  })

  it("rejects an account-scoped aggregate for a signed-in bot", () => {
    const body = JSON.stringify({ calls: [{ threadId: OURS }, { threadId: THEIRS }] })
    expect(resolveRosterScope({ own: OURS, body, ...signedIn })).toEqual({
      accept: false,
      reason: "aggregate"
    })
  })

  it("keeps anonymous behaviour unchanged for that same aggregate", () => {
    // An anonymous bot's page never sees another meeting, so nothing is taken away
    // from the path that had no incident.
    const body = JSON.stringify({ calls: [{ threadId: OURS }, { threadId: THEIRS }] })
    expect(resolveRosterScope({ own: OURS, body, ...anon })).toEqual({
      accept: true,
      reason: "match"
    })
  })

  it("drops a payload it cannot place when signed in — nothing merges without proof", () => {
    const body = '{"participants":{"8:orgid:abc":{"displayName":"A"}}}'
    expect(resolveRosterScope({ own: OURS, url: "/api/roster", body, ...signedIn })).toEqual({
      accept: false,
      reason: "unplaceable"
    })
  })

  it("keeps an unplaceable payload once a starved session has relaxed", () => {
    const body = '{"participants":{"8:orgid:abc":{"displayName":"A"}}}'
    expect(resolveRosterScope({ own: OURS, body, ...signedInRelaxed })).toEqual({
      accept: true,
      reason: "unplaceable"
    })
  })

  it("never drops an unplaceable payload for an anonymous bot", () => {
    const body = '{"participants":{"8:orgid:abc":{"displayName":"A"}}}'
    expect(
      resolveRosterScope({ own: OURS, body, isAuthenticated: false, strict: true }).accept
    ).toBe(true)
  })

  it("accepts everything until our own conversation is identified", () => {
    expect(
      resolveRosterScope({ own: null, url: `/conversations/${THEIRS}/roster`, ...signedIn })
    ).toEqual({ accept: true, reason: "own-unknown" })
  })

  it("extracts our conversation from a raw call threadId", () => {
    expect(
      resolveRosterScope({ own: `thread:${OURS};ctx=1`, url: `/x/${THEIRS}`, ...signedIn }).accept
    ).toBe(false)
    expect(
      resolveRosterScope({ own: `thread:${OURS};ctx=1`, url: `/x/${OURS}`, ...signedIn }).accept
    ).toBe(true)
  })

  it("matches regardless of case and encoding", () => {
    expect(
      resolveRosterScope({ own: OURS.toUpperCase(), url: encodeURIComponent(OURS), ...signedIn })
    ).toEqual({ accept: true, reason: "match" })
  })

  it("is self-contained, so it survives being stringified into the page", () => {
    // The injector ships this function as source text; a closure over any
    // module-level binding would throw a ReferenceError in the browser.
    // biome-ignore lint/security/noGlobalEval: asserting the stringify contract
    const rebuilt = eval(`(${resolveRosterScope.toString()})`) as typeof resolveRosterScope
    expect(
      rebuilt({ own: OURS, url: `/c/${THEIRS}`, isAuthenticated: true, strict: false })
    ).toEqual({ accept: false, reason: "foreign" })
  })
})
