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
  `https?:\\/\\/(?:meet\\.google\\.com|teams\\.microsoft\\.com\\/l\\/meetup-join|teams\\.live\\.com\\/meet)\\/${URL_CHARS}+`,
  "gi"
)

// Streaming endpoints (may carry credentials in userinfo or stream keys).
const STREAM_URL_RE = new RegExp(`\\b(?:wss?|rtmps?):\\/\\/${URL_CHARS}+`, "gi")

// Any other http(s) URL — SSO pages (query can embed the account email),
// customer webhook endpoints, etc.
const URL_RE = new RegExp(`\\bhttps?:\\/\\/${URL_CHARS}+`, "gi")

// JWTs: eyJ<header>.<payload>.<signature> (also matches truncated forms).
const JWT_RE = /\beyJ[A-Za-z0-9_=-]+(?:\.[A-Za-z0-9_=-]+){0,2}/g

// Bearer <value> in headers. (?!<) keeps already-redacted values intact.
const BEARER_RE = /\b(Bearer\s+)(?!<)[A-Za-z0-9._~+/=-]+/g

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
const PHONE_INTL_RE = /\+\d{1,3}(?:[ .-]?\d{1,4}){2,7}(?!\d)/g
const PHONE_US_PAREN_RE = /\(\d{3}\)[ .-]?\d{3}[ .-]?\d{4}\b/g
const PHONE_US_SEP_RE = /\b\d{3}[.-]\d{3}[.-]\d{4}\b/g

// IPv4 (port is kept — it's not PII and helps debugging).
const IP_V4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g

// Chat message content fields in JSON-shaped chat log lines. Applied only
// by redactChatLine() at chat call sites, never as a generic pattern.
const CHAT_TEXT_FIELD_RE = /("(?:text|content|message)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi

// Trailing sentence punctuation should not be swallowed into URL placeholders.
const TRAILING_PUNCT_RE = /[.,;:!?]+$/

function urlReplacer(placeholder: string): (match: string) => string {
  return (match: string) => {
    const trailing = match.match(TRAILING_PUNCT_RE)
    return trailing ? placeholder + trailing[0] : placeholder
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Participants literally named after JSON/JS literals must still be masked
// in prose ("Speaker joined: null") without corrupting real JSON values
// ({"foo": null}). Real JSON literal values always follow `"<key>":`.
const RESERVED_LITERALS = new Set(["null", "undefined", "true", "false", "nan", "none"])

function buildNameRegex(variant: string): RegExp {
  const escaped = escapeRegExp(variant)
  const jsonLiteralGuard = RESERVED_LITERALS.has(variant.toLowerCase()) ? '(?<!"\\s*:\\s*)' : ""
  // Custom unicode-aware word boundaries: \b is ASCII-only and misbehaves
  // around CJK names; these lookarounds also keep "Mark" from matching
  // inside "bookmark"/"marker".
  return new RegExp(
    `${jsonLiteralGuard}(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
    "giu"
  )
}

interface DictionaryEntry {
  regex: RegExp
  placeholder: string
}

class PiiRedactorService {
  /** speaker name -> stable placeholder (insertion order => <SPEAKER_n>) */
  private speakerMap = new Map<string, string>()
  private botNames = new Set<string>()
  /** compiled dictionary, rebuilt lazily after registrations */
  private dictionary: DictionaryEntry[] | null = null

  private isDisabled(): boolean {
    return process.env.DISABLE_LOG_PII_REDACTION === "true"
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
      placeholder = `<SPEAKER_${this.speakerMap.size + 1}>`
      this.speakerMap.set(key, placeholder)
      this.dictionary = null
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
      this.dictionary = null
    }
  }

  /** Clear all registered names. Intended for tests. */
  public reset(): void {
    this.speakerMap.clear()
    this.botNames.clear()
    this.dictionary = null
  }

  private getDictionary(): DictionaryEntry[] {
    if (this.dictionary) return this.dictionary

    const entries: DictionaryEntry[] = []
    const add = (name: string, placeholder: string) => {
      entries.push({ regex: buildNameRegex(name), placeholder })
      // Also match URL-encoded occurrences (e.g. ?displayName=John%20Doe).
      const encoded = encodeURIComponent(name)
      if (encoded !== name) {
        entries.push({ regex: buildNameRegex(encoded), placeholder })
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

    this.dictionary = entries
    return entries
  }

  /**
   * Redact PII from a log line (or whole log file content).
   * Applies static pattern passes, then the registered-name dictionary.
   * Idempotent: already-redacted placeholders pass through unchanged.
   */
  public redact(text: string): string {
    if (this.isDisabled()) return text
    if (typeof text !== "string" || text.length === 0) return text

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

    // Dictionary pass (bot name first, then speakers, longest-first).
    for (const entry of this.getDictionary()) {
      out = out.replace(entry.regex, entry.placeholder)
    }

    return out
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
    const withoutChatText = text.replace(CHAT_TEXT_FIELD_RE, '$1"<CHAT_TEXT>"')
    return this.redact(withoutChatText)
  }
}

/** Singleton redactor shared by all log choke points. */
export const PiiRedactor = new PiiRedactorService()
