/**
 * PII redaction for bot log output.
 *
 * Every log line that can end up in a file shared outside our infra
 * (bot.log / logs.log via winston, sound.log, speaker_separation.log,
 * browser console relay) must pass through `PiiRedactor.redact()` before
 * being written or uploaded to S3.
 *
 * Two layers:
 *  1. Static pattern passes — meeting URLs, generic URLs, streaming URLs,
 *     JWTs / bearer tokens / secret-ish KEY=VALUE pairs, AWS credentials,
 *     emails, phone numbers, IPs, user GUIDs with key context.
 *  2. Dictionary pass — names registered at runtime (observed speakers,
 *     chat senders, the bot's own name) are replaced by stable
 *     placeholders (<SPEAKER_n> / <BOT_NAME>).
 *
 * Product artifacts (diarization.jsonl, chat_messages.json, recordings)
 * are intentionally NOT redacted — only log lines about them are.
 *
 * Escape hatch: set DISABLE_LOG_PII_REDACTION=true to bypass redaction
 * entirely (e.g. for local debugging).
 */

import { randomBytes } from "node:crypto"

// ---------------------------------------------------------------------------
// Pattern passes (static, always applied)
// ---------------------------------------------------------------------------

// Characters that can belong to a URL in a log line. Quotes, parens and
// angle brackets terminate the match so URLs embedded in JSON strings or
// stack traces ("(https://...)") don't swallow surrounding syntax.
const URL_CHARS = `[^\\s"'<>()\`]`

// Meeting URLs: Google Meet (xxx-xxxx-xxx incl. query params), Teams
// enterprise meetup-join links (incl. URL-encoded context carrying tenant
// and organizer ids) and Teams consumer links (numeric id + passcode).
const MEETING_URL_RE = new RegExp(
  `https?:\\/\\/(?:meet\\.google\\.com|teams\\.microsoft\\.com\\/l\\/meetup-join|(?:teams\\.live\\.com|teams\\.microsoft\\.com)\\/meet)\\/${URL_CHARS}+`,
  "gi"
)

// Streaming endpoints (may carry credentials in userinfo or stream keys).
const STREAM_URL_RE = new RegExp(`\\b(?:wss?|rtmps?):\\/\\/${URL_CHARS}+`, "gi")

// Any other http(s) URL — SSO pages (query can embed the account email),
// customer webhook endpoints, etc.
const URL_RE = new RegExp(`\\bhttps?:\\/\\/${URL_CHARS}+`, "gi")

// JWTs: eyJ<header>.<payload>.<signature> (also matches truncated forms).
const JWT_RE = /\beyJ[A-Za-z0-9_=-]+(?:\.[A-Za-z0-9_=-]+){0,2}/g

// Bearer <value> in headers, any casing. (?!<) keeps already-redacted
// values intact.
const BEARER_RE = /\b(Bearer\s+)(?!<)[A-Za-z0-9._~+/=-]+/gi

// AWS access key ids.
const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g

// 40-char base64-ish blobs (AWS secret access key shape). Only redacted
// when nearby context looks credential-related, to avoid eating arbitrary
// 40-char identifiers.
const SECRET_RE = /(?<![A-Za-z0-9+/=<])[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/=])/g
const SECRET_CONTEXT_RE = /aws|secret|access[_ -]?key|<AWS_KEY>/i

// KEY=VALUE / "key": "value" where the key name looks secret-ish.
const KEY_VALUE_RE =
  /((?:"|')?[\w.-]*(?:token|key|secret|password|pwd|credential)[\w.-]*(?:"|')?\s*[=:]\s*)("?)(?!<)([^\s"',;&}\]]+)/gi

// GUIDs bound to a user-identifying key (organizerId, userId, tenantId...).
// Deliberately narrow: bot_uuid and other correlation UUIDs must survive.
const USER_ID_RE =
  /(\b(?:organizer|user|participant|tenant|member|o|t)_?id"?\s*[=:]\s*"?)(?!<)[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/gi

// Emails, incl. plus-addressing, multi-level TLDs and URL-encoded @ (%40).
const EMAIL_RE = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

// Phone numbers. All variants require either a leading "+" or separator
// punctuation so bare digit runs (unix timestamps, meeting ids) never match.
// The intl form additionally requires >= 7 digits total: signed decimals in
// metrics ("Growth: +0.50 MB in 30.0s") must not match (seen in prod logs).
const PHONE_INTL_RE = /\+(?=(?:[ .-]?\d){7,15}(?!\d))\d{1,3}(?:[ .-]?\d{1,4}){2,7}(?!\d)/g
const PHONE_US_PAREN_RE = /\(\d{3}\)[ .-]?\d{3}[ .-]?\d{4}\b/g
const PHONE_US_SEP_RE = /\b\d{3}[.-]\d{3}[.-]\d{4}\b/g

// IPv4 (port is kept — it's not PII and helps debugging).
const IP_V4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g

// Chat message content fields in JSON-shaped chat log lines. Applied only
// by redactChatLine() at chat call sites, never as a generic pattern.
const CHAT_TEXT_FIELD_RE = /("(?:text|content|message)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi

// Trailing sentence punctuation should not be swallowed into URL placeholders.
const TRAILING_PUNCT_RE = /[.,;:!?]+$/

// Per-process random salt for URL placeholder tags. Salted so a tag cannot
// be dictionary-confirmed against a candidate URL from outside the log
// bundle; per-process (= per bot run, all log files of a run share it) so
// the same URL always maps to the same tag within a run and distinct URLs
// stay distinguishable — redirect chains and parser transforms remain
// debuggable without disclosing any URL.
//
// CSPRNG, not Math.random(): the salt is the only thing standing between a tag
// and an offline dictionary attack, and V8's Math.random() state is recoverable
// from a handful of observed outputs.
const URL_TAG_SALT = randomBytes(16).toString("hex")

/** FNV-1a 32-bit over salt+url, folded to 4 hex chars. */
function urlTag(url: string): string {
  const s = URL_TAG_SALT + url
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h = h >>> 0
  return (((h >>> 16) ^ h) & 0xffff).toString(16).padStart(4, "0")
}

function urlReplacer(placeholder: string): (match: string) => string {
  const base = placeholder.slice(0, -1) // "<URL>" -> "<URL"
  return (match: string) => {
    const trailing = match.match(TRAILING_PUNCT_RE)
    // Tag the URL without its trailing punctuation so "…url" and "…url."
    // resolve to the same tag.
    const core = trailing ? match.slice(0, match.length - trailing[0].length) : match
    const tagged = `${base}#${urlTag(core)}>`
    return trailing ? tagged + trailing[0] : tagged
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Participants literally named after JSON/JS literals must still be masked
// in prose ("Speaker joined: null") without corrupting real JSON values
// ({"foo": null}). Real JSON literal values always follow `"<key>":`.
const RESERVED_LITERALS = new Set(["null", "undefined", "true", "false", "nan", "none"])

function buildNamePattern(variant: string): string {
  const escaped = escapeRegExp(variant)
  const jsonLiteralGuard = RESERVED_LITERALS.has(variant.toLowerCase()) ? '(?<!"\\s*:\\s*)' : ""
  // Identifier-looking names ("name", "id", "user_id") get a key-position
  // guard so they cannot rewrite JSON/struct field names. Applied only to
  // identifier shapes: guarding every name would leak "John Doe: hello"
  // caption-style lines.
  const keyGuard = /^[a-z_][a-z0-9_]*$/.test(variant) ? '(?!"?\\s*:)' : ""
  // Custom unicode-aware word boundaries: \b is ASCII-only and misbehaves
  // around CJK names; these lookarounds also keep "Mark" from matching
  // inside "bookmark"/"marker".
  return `${jsonLiteralGuard}(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])${keyGuard}`
}

// A dictionary entry is an unanchored find/replace applied to every log line,
// so a name that also occurs as ordinary log text corrupts unrelated output.
// Display names are end-user controlled, so this has to hold for adversarial
// input too: the word boundaries above are letter/digit/underscore based, and
// `:` `.` `,` are none of those, so a participant named "56" rewrites the
// seconds field of every ISO timestamp ("12:34:<SPEAKER_1>.789Z") and one named
// "100" eats byte counts, durations and levels across sound.log and bot.log.
//
// Names rejected here still receive a stable <SPEAKER_n> — callers use it as a
// display label — they are only kept out of the replacement dictionary.
const MIN_DICTIONARY_NAME_LENGTH = 2
// Dial-in participants can surface as a bare digit string. Those are real PII,
// and at this width they no longer collide with counters, ports or levels, so
// they stay in the dictionary. The threshold matches PHONE_INTL_RE's own floor.
const MIN_DIGITS_WITHOUT_LETTER = 7

function isDictionarySafe(name: string): boolean {
  if (name.length < MIN_DICTIONARY_NAME_LENGTH) return false
  if (/\p{L}/u.test(name)) return true
  const digitCount = name.replace(/[^0-9]/g, "").length
  return digitCount >= MIN_DIGITS_WITHOUT_LETTER
}

/**
 * The registered-name dictionary compiled into a handful of alternations, so
 * redact() runs a few scans per line instead of one per registered name (the
 * dictionary can hold hundreds of names, and redact() is on the synchronous
 * path of every single log line).
 *
 * Chunked rather than one giant alternation: past roughly 300 alternatives V8
 * stops compiling the pattern to native code and falls back to the bytecode
 * interpreter, which measured ~7x SLOWER than the per-name loop it replaces.
 * At 64 the pattern stays in the fast path with a wide margin.
 *
 * Chunks are applied in order and each chunk's alternatives are in priority
 * order (bot names first, then longest name first). JS alternation is
 * first-match-wins at a given position, so this preserves exactly the
 * precedence the per-name loop had.
 */
const DICTIONARY_CHUNK_SIZE = 64

/**
 * Key a matched name back to its placeholder. The alternation matches under
 * Unicode case folding, which is wider than toLowerCase(): a name registered
 * with a medial sigma ("...σ") matches log text carrying the word-final form
 * ("...ς") — routine for Greek names — yet the two lower-case to different
 * strings. Fold those together so the match resolves to the right speaker
 * rather than falling through to the generic placeholder below.
 */
function dictionaryKey(name: string): string {
  return name.normalize("NFC").toLowerCase().replace(/ς/g, "σ")
}

/**
 * Used when a name matched the dictionary but could not be resolved to its
 * placeholder. Redaction is fail-closed, so an unresolved match is still
 * masked — returning the matched text would leak the very name that matched.
 */
const UNRESOLVED_NAME_PLACEHOLDER = "<REDACTED_NAME>"

interface CompiledDictionary {
  regexes: RegExp[]
  /** dictionaryKey(matched text) -> placeholder */
  lookup: Map<string, string>
}

function compileDictionary(
  patterns: string[],
  lookup: Map<string, string>
): CompiledDictionary | null {
  const regexes: RegExp[] = []
  let dropped = 0

  for (let i = 0; i < patterns.length; i += DICTIONARY_CHUNK_SIZE) {
    const chunk = patterns.slice(i, i + DICTIONARY_CHUNK_SIZE)
    try {
      regexes.push(new RegExp(`(?:${chunk.join("|")})`, "giu"))
    } catch {
      // One unrepresentable name (e.g. a lone surrogate in a display name)
      // must not disable the dictionary for every other participant.
      // Re-validate this chunk pattern by pattern and drop only the offenders.
      const usable = chunk.filter((pattern) => {
        try {
          new RegExp(pattern, "giu")
          return true
        } catch {
          return false
        }
      })
      dropped += chunk.length - usable.length
      if (usable.length > 0) {
        try {
          regexes.push(new RegExp(`(?:${usable.join("|")})`, "giu"))
        } catch {
          dropped += usable.length
        }
      }
    }
  }

  if (dropped > 0) {
    console.warn(`PiiRedactor: dropped ${dropped} unrepresentable name pattern(s)`)
  }
  return regexes.length === 0 ? null : { regexes, lookup }
}

// Above MAX_SPEAKERS, new names no longer get a distinct stable placeholder
// but are STILL added to the dictionary (as <SPEAKER_OVERFLOW>) — otherwise
// their raw names would leak wherever they later appear in log content.
// MAX_TOTAL_NAMES is the absolute backstop on dictionary growth.
const MAX_SPEAKERS = 500
const MAX_TOTAL_NAMES = 5000
let speakerOverflowWarned = false

class PiiRedactorService {
  /** speaker name -> stable placeholder (insertion order => <SPEAKER_n>) */
  private speakerMap = new Map<string, string>()
  private botNames = new Set<string>()
  /**
   * Registered names that must not become dictionary entries because matching
   * them globally would corrupt unrelated log text (see isDictionarySafe).
   */
  private unsafeNames = new Set<string>()
  /** compiled dictionary, rebuilt lazily after registrations */
  private dictionary: CompiledDictionary | null = null
  private dictionaryDirty = true

  private enforcedWarned = false

  private isDisabled(): boolean {
    if (process.env.DISABLE_LOG_PII_REDACTION !== "true") return false
    // Hard guard: when logs are shipped outside the cluster (promtail ->
    // external Loki, self-host installs federating to our Grafana), the
    // escape hatch must not win — one env flip would leak raw PII off-site.
    // PII_REDACTION_ENFORCED is set by the deployment charts, never locally.
    if (process.env.PII_REDACTION_ENFORCED === "true") {
      if (!this.enforcedWarned) {
        this.enforcedWarned = true
        console.warn(
          "DISABLE_LOG_PII_REDACTION ignored: PII_REDACTION_ENFORCED is set (logs leave the cluster)"
        )
      }
      return false
    }
    return true
  }

  /**
   * Register an observed participant/speaker name. Returns the stable
   * placeholder assigned to that name (same name -> same placeholder).
   */
  public registerSpeaker(name: string): string {
    if (typeof name !== "string") return ""
    const key = name.trim()
    if (key.length === 0) return ""
    // The bot itself often shows up in the participants list; keep it
    // mapped to <BOT_NAME> instead of burning a speaker slot.
    if (this.botNames.has(key)) return "<BOT_NAME>"
    let placeholder = this.speakerMap.get(key)
    if (!placeholder) {
      if (this.speakerMap.size >= MAX_TOTAL_NAMES) {
        // Absolute backstop; far beyond any real meeting.
        return "<SPEAKER_OVERFLOW>"
      }
      if (this.speakerMap.size >= MAX_SPEAKERS) {
        if (!speakerOverflowWarned) {
          speakerOverflowWarned = true
          console.warn(
            `PiiRedactor: speaker registry full (${MAX_SPEAKERS}), new names map to <SPEAKER_OVERFLOW>`
          )
        }
        // Still registered so the raw name gets redacted from log content.
        placeholder = "<SPEAKER_OVERFLOW>"
      } else {
        placeholder = `<SPEAKER_${this.speakerMap.size + 1}>`
      }
      this.speakerMap.set(key, placeholder)
      // Short/letterless names keep their stable placeholder but never enter
      // the replacement dictionary — matching "56" or "100" globally would
      // shred timestamps and counters in every log file.
      if (!isDictionarySafe(key)) this.unsafeNames.add(key)
      this.dictionaryDirty = true
    }
    return placeholder
  }

  /**
   * Register the bot's display name. Bot names frequently contain end-user
   * names ("Sales Call Recorder for Jane Smith") so they are replaced
   * before speaker names.
   */
  public registerBotName(name: string): void {
    if (typeof name !== "string") return
    const key = name.trim()
    if (key.length === 0) return
    if (!this.botNames.has(key)) {
      this.botNames.add(key)
      // Same global-match hazard as speaker names (a bot literally named "42").
      if (!isDictionarySafe(key)) this.unsafeNames.add(key)
      this.dictionaryDirty = true
    }
  }

  /** Clear all registered names. Intended for tests. */
  public reset(): void {
    this.speakerMap.clear()
    this.botNames.clear()
    this.unsafeNames.clear()
    this.dictionary = null
    this.dictionaryDirty = true
  }

  private getDictionary(): CompiledDictionary | null {
    if (!this.dictionaryDirty) return this.dictionary
    this.dictionaryDirty = false

    const patterns: string[] = []
    const lookup = new Map<string, string>()
    const add = (name: string, placeholder: string) => {
      if (this.unsafeNames.has(name)) return
      // Also match URL-encoded occurrences (e.g. ?displayName=John%20Doe).
      // encodeURIComponent throws on lone surrogates, which a mangled DOM read
      // can produce; a name we cannot encode must not take the whole redactor
      // down, so fall back to the raw form only.
      let encoded = name
      try {
        encoded = encodeURIComponent(name)
      } catch {
        encoded = name
      }
      for (const variant of encoded === name ? [name] : [name, encoded]) {
        // First registration wins, mirroring the alternation's own precedence.
        const key = dictionaryKey(variant)
        if (lookup.has(key)) continue
        lookup.set(key, placeholder)
        patterns.push(buildNamePattern(variant))
      }
    }

    // Bot names first (they can contain speaker names), then speakers.
    // Longest-name-first inside each group so "Jane Smith-Jones" wins
    // over "Jane Smith".
    const bots = Array.from(this.botNames).sort((a, b) => b.length - a.length)
    for (const name of bots) add(name, "<BOT_NAME>")

    const speakers = Array.from(this.speakerMap.entries()).sort(
      (a, b) => b[0].length - a[0].length
    )
    for (const [name, placeholder] of speakers) add(name, placeholder)

    this.dictionary = patterns.length === 0 ? null : compileDictionary(patterns, lookup)
    return this.dictionary
  }

  /**
   * Redact PII from a log line (or whole log file content).
   * Applies static pattern passes, then the registered-name dictionary.
   * Idempotent: already-redacted placeholders pass through unchanged.
   */
  public redact(text: string): string {
    if (this.isDisabled()) return text
    if (typeof text !== "string" || text.length === 0) return text

    try {
      let out = text

      // URLs first: they can embed emails, names and tokens that would
      // otherwise be partially matched by later passes.
      out = out.replace(MEETING_URL_RE, urlReplacer("<MEETING_URL>"))
      out = out.replace(STREAM_URL_RE, urlReplacer("<STREAM_URL>"))
      out = out.replace(URL_RE, urlReplacer("<URL>"))

      // Credentials.
      out = out.replace(JWT_RE, "<TOKEN>")
      out = out.replace(BEARER_RE, "$1<TOKEN>")
      out = out.replace(AWS_KEY_RE, "<AWS_KEY>")
      out = out.replace(SECRET_RE, (match, offset: number, whole: string) => {
        const context = whole.slice(Math.max(0, offset - 120), offset + match.length + 40)
        return SECRET_CONTEXT_RE.test(context) ? "<SECRET>" : match
      })
      out = out.replace(KEY_VALUE_RE, "$1$2<TOKEN>")

      // Identifiers.
      out = out.replace(USER_ID_RE, "$1<USER_ID>")
      out = out.replace(EMAIL_RE, "<EMAIL>")
      out = out.replace(PHONE_INTL_RE, "<PHONE>")
      out = out.replace(PHONE_US_PAREN_RE, "<PHONE>")
      out = out.replace(PHONE_US_SEP_RE, "<PHONE>")
      out = out.replace(IP_V4_RE, "<IP>")

      // Dictionary pass: registered names (bot names first, then speakers
      // longest-first) batched into a few alternations instead of one scan
      // per name.
      const dictionary = this.getDictionary()
      if (dictionary) {
        const { lookup } = dictionary
        for (const regex of dictionary.regexes) {
          out = out.replace(
            regex,
            (match) => lookup.get(dictionaryKey(match)) ?? UNRESOLVED_NAME_PLACEHOLDER
          )
        }
      }

      return out
    } catch (_error) {
      // Fail closed: never return the original (potentially PII-bearing) text.
      return "<REDACTION_FAILED>"
    }
  }

  /**
   * Redact a chat-related log line: chat message content fields
   * ("text"/"content"/"message" in JSON-shaped lines) are replaced with
   * <CHAT_TEXT>, then the regular redaction pass runs (masking the sender
   * via the registered speaker dictionary).
   *
   * Use this at every call site that logs chat payloads. The
   * chat_messages.json product artifact itself must stay untouched.
   */
  public redactChatLine(text: string): string {
    if (this.isDisabled()) return text
    if (typeof text !== "string" || text.length === 0) return text
    // Same fail-closed contract as redact(): never surface the raw line.
    let withoutChatText: string
    try {
      withoutChatText = text.replace(CHAT_TEXT_FIELD_RE, '$1"<CHAT_TEXT>"')
    } catch {
      return "<REDACTION_FAILED>"
    }
    return this.redact(withoutChatText)
  }
}

/** Singleton redactor shared by all log choke points. */
export const PiiRedactor = new PiiRedactorService()
