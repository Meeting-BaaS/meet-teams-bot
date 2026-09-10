import { envVars } from "../config/env-vars"

/**
 * Zoom rejects display names containing notetaker tokens by literal substring match,
 * so swap one letter per token for a Cyrillic look-alike. Applied once in GLOBAL.set,
 * never at the API, so every roster comparison sees the same string.
 */

// A source string, not a RegExp: a shared /g/ regex carries lastIndex between calls.
const BOT_LIKE_SOURCE =
  "note ?taker|recorder|recording|transcri|\\bbots?\\b|\\bai\\b|assistant|\\bnotes?\\b"

/** NFKC-stable Latin → Cyrillic look-alikes; letters without an exact twin are omitted. */
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

/** Map substituted characters back to Latin; use before matching on what a name says. */
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

// Stable per bot, so retries keep the same spelling.
function seedHash(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return h
}

/** Swap one character in each bot-like token for its Cyrillic twin. */
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
