import { envVars } from "../config/env-vars"

/**
 * Bot display-name disguise.
 *
 * Zoom hosts — and Zoom's own join path — auto-reject participants whose display
 * name contains an obvious notetaker token. That block is a literal substring
 * match, so replacing ONE letter of the offending token with a
 * visually-identical letter from another script defeats it while the name still
 * reads exactly the same to a human in the participant list.
 *
 * Three things this deliberately does NOT do.
 *
 * It does not run at the API layer. What the customer stored, searches for and
 * gets back in webhooks stays exactly as they typed it; only the string this bot
 * types into the join form changes. The rewrite happens once, in GLOBAL.set, so
 * every place the bot compares itself against the meeting's own roster —
 * isBotName(), the Zoom tile cleaner, the speaker registry, the chat echo
 * dedup, the timeline leading-gap retrofit — sees the same string on both sides.
 * Rewriting at the typing site instead would leave a Latin name in config and a
 * Cyrillic one in the DOM, and the bot would appear in the customer's own
 * transcript as a speaker.
 *
 * It does not substitute every letter. A wholly mixed-script name is flagged in
 * microseconds by the Unicode confusables/skeleton algorithm, and "this name is
 * built from three scripts" is a far higher-confidence bot signal than "this
 * name says Notetaker" — real people are called that too. One character per
 * offending token is the least that breaks a literal match.
 *
 * It does not use fullwidth or mathematical look-alikes. NFKC folds those back
 * to ASCII, so anything that normalises before matching sees straight through
 * them. Cyrillic letters have no compatibility decomposition and survive both
 * NFC and NFKC unchanged.
 */

// The tokens that get a name auto-rejected. Kept as a source string rather than
// a RegExp so callers can build their own flags — a /g/ regex reused with
// .test() carries lastIndex between calls and silently alternates true/false.
const BOT_LIKE_SOURCE =
  "note ?taker|recorder|recording|transcri|\\bbots?\\b|\\bai\\b|assistant|\\bnotes?\\b"

/**
 * Latin → Cyrillic look-alikes. Every pair here is NFKC-stable and renders
 * identically (or near enough that no reader would notice) in the fonts a
 * meeting client uses. Letters with no honest twin — n, t, r, d, g, l, u, v, w,
 * z — are deliberately absent: a "close enough" substitution is visible to a
 * person, which defeats the point.
 */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  a: "а", // CYRILLIC SMALL LETTER A
  c: "с", // CYRILLIC SMALL LETTER ES
  e: "е", // CYRILLIC SMALL LETTER IE
  i: "і", // CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I
  j: "ј", // CYRILLIC SMALL LETTER JE
  o: "о", // CYRILLIC SMALL LETTER O
  p: "р", // CYRILLIC SMALL LETTER ER
  s: "ѕ", // CYRILLIC SMALL LETTER DZE
  x: "х", // CYRILLIC SMALL LETTER HA
  y: "у", // CYRILLIC SMALL LETTER U
  A: "А",
  B: "В",
  C: "С",
  E: "Е",
  H: "Н",
  I: "І",
  J: "Ј",
  K: "К",
  M: "М",
  O: "О",
  P: "Р",
  S: "Ѕ",
  T: "Т",
  X: "Х",
  Y: "У"
}

const SKELETON: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(HOMOGLYPHS).map(([latin, cyrillic]) => [cyrillic, latin]))
)

/** True when the name carries a token hosts reject. Case-insensitive. */
export function isBotLikeName(name: string): boolean {
  return new RegExp(BOT_LIKE_SOURCE, "i").test(name)
}

/**
 * Map every substituted character back to its Latin original.
 *
 * Anything that reasons about what the name SAYS rather than what was typed
 * must skeletonise first — otherwise the disguise blinds our own bot-like-name
 * detection, and we lose the signal this feature exists to act on.
 */
export function skeletonizeBotName(name: string): string {
  if (typeof name !== "string" || name.length === 0) return name
  let out = ""
  for (const ch of name) out += SKELETON[ch] ?? ch
  return out
}

/** Which platforms disguise the display name. Empty (the default) = none. */
export function shouldDisguiseBotName(platform: string): boolean {
  const allow = envVars.HOMOGLYPH_NAME_PLATFORMS.split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
  if (allow.length === 0) return false
  return allow.includes("all") || allow.includes(platform.toLowerCase())
}

// Same rolling hash the proxy country rotation uses: stable for a bot across
// every SQS requeue and in-pod relaunch, so a bot that was rejected under one
// spelling is not silently retried under another and the arm stays attributable.
function seedHash(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return h
}

/**
 * Swap one character in each bot-like token for its Cyrillic twin.
 *
 * Returns the name unchanged when it carries no such token (most names), or when
 * the token holds no substitutable letter — a disguise that changes nothing is
 * better than one that mangles a name into something a human would query.
 */
export function disguiseBotName(name: string, seed: string): string {
  if (typeof name !== "string" || name.length === 0) return name
  const matches = [...name.matchAll(new RegExp(BOT_LIKE_SOURCE, "gi"))]
  if (matches.length === 0) return name

  let hash = seedHash(seed)
  const swaps = new Map<number, string>()
  for (const match of matches) {
    const start = match.index
    if (start === undefined) continue
    const token = match[0]
    const candidates: number[] = []
    for (let i = 0; i < token.length; i++) {
      if (HOMOGLYPHS[token.charAt(i)]) candidates.push(start + i)
    }
    if (candidates.length === 0) continue
    hash = (hash * 31 + token.length) >>> 0
    const at = candidates[hash % candidates.length] as number
    const replacement = HOMOGLYPHS[name.charAt(at)]
    if (replacement) swaps.set(at, replacement)
  }
  if (swaps.size === 0) return name

  let out = ""
  for (let i = 0; i < name.length; i++) out += swaps.get(i) ?? name.charAt(i)
  return out
}
