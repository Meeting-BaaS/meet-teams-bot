/**
 * Display name for a Teams participant tile.
 *
 * Read from a live meeting (work account in a personal-Teams meeting, 2026-09-18):
 *   data-tid              = "Amr El Shimy"
 *   participant-info-nametag = "Amr El Shimy"
 *   aria-label            = "Amr El Shimy External unfamiliar, video is on, Context menu is available"
 *
 * Only aria-label carries Teams' account badges ("External", "Unfamiliar", "Guest") and
 * state, and parsing it is what put "Amr El Shimy External unfamiliar" in transcripts.
 * The nametag and data-tid hold the name alone, so they are read first and no text is
 * stripped — a participant really called "Bot Unfamiliar" keeps their name.
 *
 * SELF-CONTAINED: stringified into the page by the speakers observer.
 */
export function resolveTeamsTileName(parts: {
  nametags?: Array<string | null | undefined>
  dataTid?: string | null
  ariaLabel?: string | null
}): string {
  // data-tid holds the display name on a participant tile, but Teams also uses it for
  // structural nodes ("menur1j", "participant-info"); those are never a name.
  const isStructuralTid = (tid: string): boolean =>
    /^(?:roster|participant|calling|video|voice|menu)[a-z0-9-]*$/i.test(tid) ||
    tid.endsWith("-stream") ||
    tid.endsWith("-outline")

  // Teams writes a guest's label in brackets after the name ("Jonny (Guest)"). Only the
  // bracketed form is dropped, so it matches the caption author text as before; bare words
  // are left alone because they can be the name itself.
  const withoutBracketedLabel = (name: string): string => {
    const bracketed = /\s*\((?:guest|external|unverified|unfamiliar)\)\s*$/i
    let out = name.trim()
    // Stacked labels ("Jonny (Guest) (Unverified)") peel one at a time.
    while (bracketed.test(out)) out = out.replace(bracketed, "").trim()
    return out
  }

  for (const nametag of parts.nametags ?? []) {
    const text = (nametag ?? "").trim()
    if (text) return withoutBracketedLabel(text)
  }
  const tid = (parts.dataTid ?? "").trim()
  // An email in data-tid is PII on some builds, never a display name.
  if (tid && !tid.includes("@") && !isStructuralTid(tid)) return withoutBracketedLabel(tid)
  return withoutBracketedLabel(((parts.ariaLabel ?? "").split(",")[0] ?? "").trim())
}
