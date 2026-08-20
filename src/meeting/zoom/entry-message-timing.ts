/**
 * Tracks when the bot posted its Zoom entry chat message.
 *
 * The end-of-meeting denial scanner can false-positive on the bot's OWN entry
 * message: it echoes into the rendered chat list and, depending on Zoom's DOM,
 * may not sit in a container the ignore-list knows about (2026-08 Noota
 * incident: bots c97b775f / ee8053f9 killed themselves ~200-700ms after
 * sending it). Module-scoped so both ChatManager (writes) and the Zoom end
 * detector (reads) share one clock without threading an instance through.
 */

let entryMessageSentAt: number | null = null

export function markZoomEntryMessageSent(): void {
  entryMessageSentAt = Date.now()
}

export function getZoomEntryMessageSentAt(): number | null {
  return entryMessageSentAt
}

export function resetZoomEntryMessageTiming(): void {
  entryMessageSentAt = null
}