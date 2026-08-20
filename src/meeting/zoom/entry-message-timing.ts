/**
 * Tracks when the bot posted its Zoom entry chat message.
 *
 * The end-of-meeting denial scanner can false-positive on the bot's OWN entry
 * message: it echoes into the rendered chat list and, depending on Zoom's DOM,
 * may not sit in a container the ignore-list knows about (2026-08 production
 * incident: bots killed themselves ~200-700ms after sending it). Module-scoped
 * so both the in-call state machine (writes, on the ENTRY message only) and
 * the Zoom end detector (reads) share one clock without threading an instance
 * through.
 */

let entryMessageSentAt: number | null = null

/**
 * Record that the bot just posted its Zoom entry chat message. Called by the
 * in-call state machine after a successful entry-message send (zoom only) —
 * deliberately NOT on other mid-meeting chat sends, so the grace window cannot
 * be re-armed by API-triggered messages.
 */
export function markZoomEntryMessageSent(): void {
  entryMessageSentAt = Date.now()
}

/**
 * Timestamp (ms epoch) of the last entry-message send, or null if none was
 * sent this session. Read by zoom.ts findEndMeeting to suppress denial matches
 * during the post-send grace window.
 */
export function getZoomEntryMessageSentAt(): number | null {
  return entryMessageSentAt
}

/**
 * Clear the entry-message timestamp (e.g. on a fresh bot session).
 */
export function resetZoomEntryMessageTiming(): void {
  entryMessageSentAt = null
}
