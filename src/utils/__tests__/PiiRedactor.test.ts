import * as fs from "node:fs"
import * as path from "node:path"
import { PiiRedactor } from "../PiiRedactor"

/**
 * Edge-case spec: pii-edge-cases.csv (copied from the repo-level
 * pii-log-edge-cases.csv). Rows with bot in {meet, teams, all} apply to
 * this bot.
 *
 * Excluded rows and why:
 *  - 9, 10, 43: product-artifact policy decisions (diarization.jsonl,
 *    chat_messages.json, screenshots/HTML snapshots). Artifacts are
 *    intentionally NOT redacted; only log lines about them are.
 *  - all bot=zoom rows (23-28, 29, 30-33, 44): zoom-bot (Rust) sources,
 *    out of scope for this repo.
 *
 * Row 11 (category "chat") is asserted through redactChatLine() instead of
 * redact(): per design, <CHAT_TEXT> is applied at chat call sites (e.g.
 * src/server.ts "Chat message result:"), not as a generic pattern pass.
 */

const CSV_PATH = path.join(__dirname, "pii-edge-cases.csv")
const APPLICABLE_BOTS = new Set(["meet", "teams", "all"])
const SKIPPED_IDS = new Set(["9", "10", "43"])

interface CsvRow {
  id: string
  bot: string
  category: string
  source_ref: string
  example_raw: string
  expected_redacted: string
  notes: string
  status: string
}

/** Minimal RFC-4180 CSV parser (quoted fields, "" escapes, embedded newlines). */
function parseCsv(content: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < content.length; i++) {
    const c = content[i]
    if (inQuotes) {
      if (c === '"') {
        if (content[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ",") {
      row.push(field)
      field = ""
    } else if (c === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else if (c !== "\r") {
      field += c
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.length > 1)
}

/** The CSV encodes newlines inside examples as literal \n sequences. */
function unescapeNewlines(text: string): string {
  return text.replace(/\\n/g, "\n")
}

function loadRows(): CsvRow[] {
  const content = fs.readFileSync(CSV_PATH, "utf-8")
  const [header, ...records] = parseCsv(content)
  return records.map((fields) => {
    const row = {} as Record<string, string>
    header.forEach((name, i) => {
      row[name] = fields[i] ?? ""
    })
    return row as unknown as CsvRow
  })
}

const allRows = loadRows()
const applicableRows = allRows.filter(
  (row) => APPLICABLE_BOTS.has(row.bot) && !SKIPPED_IDS.has(row.id)
)

function registerFixtureDictionary(): void {
  PiiRedactor.reset()
  // Bot names first: they may contain person names and must win.
  PiiRedactor.registerBotName("Acme Notetaker")
  PiiRedactor.registerBotName("Sales Call Recorder for Jane Smith")
  // Speakers in this exact order => stable SPEAKER_1..6 numbering.
  expect(PiiRedactor.registerSpeaker("John Doe")).toBe("<SPEAKER_1>")
  expect(PiiRedactor.registerSpeaker("Jane Smith")).toBe("<SPEAKER_2>")
  expect(PiiRedactor.registerSpeaker("田中太郎")).toBe("<SPEAKER_3>")
  expect(PiiRedactor.registerSpeaker('O\'Brien, John "JJ"')).toBe("<SPEAKER_4>")
  expect(PiiRedactor.registerSpeaker("Mark")).toBe("<SPEAKER_5>")
  expect(PiiRedactor.registerSpeaker("null")).toBe("<SPEAKER_6>")
  expect(PiiRedactor.registerSpeaker("name")).toBe("<SPEAKER_7>")
}

/**
 * URL placeholders carry a per-process random correlation tag
 * (<MEETING_URL#ab12>). The CSV documents the un-tagged canonical form;
 * strip tags before comparing.
 */
function stripUrlTags(text: string): string {
  return text.replace(/<(MEETING_URL|STREAM_URL|URL)#[0-9a-f]{4}>/g, "<$1>")
}

function redactRow(row: CsvRow): string {
  const raw = unescapeNewlines(row.example_raw)
  const out =
    row.category === "chat" ? PiiRedactor.redactChatLine(raw) : PiiRedactor.redact(raw)
  return stripUrlTags(out)
}

describe("PiiRedactor CSV edge cases", () => {
  beforeAll(() => {
    delete process.env.DISABLE_LOG_PII_REDACTION
    registerFixtureDictionary()
  })

  afterAll(() => {
    PiiRedactor.reset()
  })

  it("finds the expected applicable rows in the CSV", () => {
    expect(allRows.length).toBe(54)
    expect(applicableRows.length).toBe(33)
  })

  test.each(applicableRows.map((row) => [row.id, row.category, row]))(
    "row %s (%s) redacts to the expected output",
    (_id, _category, row) => {
      const expected = unescapeNewlines((row as CsvRow).expected_redacted)
      expect(redactRow(row as CsvRow)).toBe(expected)
    }
  )

  it("leaves no raw PII in any redacted output (sweep)", () => {
    const rawPii = [
      "John Doe",
      "John%20Doe",
      "Jane Smith",
      "田中太郎",
      "O'Brien",
      "Acme Notetaker",
      "Sales Call Recorder",
      "john@acme.com",
      "john.doe",
      "orga@acme.com",
      "zak@customer.io",
      "meet.google.com",
      "teams.microsoft.com/l/meetup-join",
      "teams.live.com/meet",
      "accounts.google.com",
      "hooks.customer-acme.com",
      "stream.customer.io",
      "s3cret",
      "eyJhbGciOiJIUzI1NiJ9",
      "AKIAIOSFODNN7EXAMPLE",
      "wJalrXUtnFEMI",
      "sk_live_9f8e7d6c",
      "g-abc123",
      "wh_live_abc123",
      "+33 6 12 34 56 78",
      "(555) 123-4567",
      "192.168.1.42",
      "84.101.23.7",
      "deadbeef-aaaa-bbbb-cccc-000011112222",
      "see you at 5",
    ]
    for (const row of applicableRows) {
      const output = redactRow(row)
      for (const pii of rawPii) {
        expect(output).not.toContain(pii)
      }
    }
  })
})

describe("PiiRedactor behavior", () => {
  beforeEach(() => {
    delete process.env.DISABLE_LOG_PII_REDACTION
    registerFixtureDictionary()
  })

  afterAll(() => {
    delete process.env.DISABLE_LOG_PII_REDACTION
    PiiRedactor.reset()
  })

  it("assigns stable placeholders (same name -> same n)", () => {
    expect(PiiRedactor.registerSpeaker("John Doe")).toBe("<SPEAKER_1>")
    expect(PiiRedactor.registerSpeaker("New Person")).toBe("<SPEAKER_8>")
    expect(PiiRedactor.registerSpeaker("New Person")).toBe("<SPEAKER_8>")
  })

  it("maps the bot's own name to <BOT_NAME> even via registerSpeaker", () => {
    expect(PiiRedactor.registerSpeaker("Acme Notetaker")).toBe("<BOT_NAME>")
  })

  it("does not corrupt real JSON null values (reserved-word speaker)", () => {
    expect(PiiRedactor.redact('{"sender_id": null, "who": "null"}')).toBe(
      '{"sender_id": null, "who": "<SPEAKER_6>"}'
    )
  })

  it("is idempotent on already-redacted output", () => {
    const once = PiiRedactor.redact(
      'Error details: {"meetingUrl":"https://meet.google.com/abc-defg-hij","botName":"Acme Notetaker"}'
    )
    expect(PiiRedactor.redact(once)).toBe(once)
  })

  it("keeps bot_uuid UUIDs for log correlation", () => {
    const line = 'payload bot_uuid=5e672408-3aef-460b-a4d0-5cd47c09708c diarization_v2=false'
    expect(PiiRedactor.redact(line)).toBe(line)
  })

  it("respects the DISABLE_LOG_PII_REDACTION escape hatch", () => {
    process.env.DISABLE_LOG_PII_REDACTION = "true"
    const line = "Inviting participant john.doe+test@sub.acme.co.uk to see John Doe"
    expect(PiiRedactor.redact(line)).toBe(line)
    expect(PiiRedactor.redactChatLine(line)).toBe(line)
    delete process.env.DISABLE_LOG_PII_REDACTION
    expect(PiiRedactor.redact(line)).toBe(
      "Inviting participant <EMAIL> to see <SPEAKER_1>"
    )
  })
})

describe("PII_REDACTION_ENFORCED guard", () => {
  afterEach(() => {
    delete process.env.DISABLE_LOG_PII_REDACTION
    delete process.env.PII_REDACTION_ENFORCED
  })

  it("escape hatch works when not enforced", () => {
    process.env.DISABLE_LOG_PII_REDACTION = "true"
    const raw = "mail john@acme.com"
    expect(PiiRedactor.redact(raw)).toBe(raw)
  })

  it("enforced mode overrides the escape hatch", () => {
    process.env.DISABLE_LOG_PII_REDACTION = "true"
    process.env.PII_REDACTION_ENFORCED = "true"
    expect(PiiRedactor.redact("mail john@acme.com")).toBe("mail <EMAIL>")
  })
})

describe("URL correlation tags", () => {
  beforeAll(() => {
    delete process.env.DISABLE_LOG_PII_REDACTION
  })

  const TAGGED = /^<MEETING_URL#[0-9a-f]{4}>$/

  it("emits a 4-hex tag on every URL placeholder", () => {
    expect(PiiRedactor.redact("https://meet.google.com/abc-defg-hij")).toMatch(TAGGED)
    expect(PiiRedactor.redact("https://example.com/x")).toMatch(/^<URL#[0-9a-f]{4}>$/)
    expect(PiiRedactor.redact("wss://stream.example.com/k")).toMatch(
      /^<STREAM_URL#[0-9a-f]{4}>$/
    )
  })

  it("same URL -> same tag; different URL -> different tag", () => {
    const a1 = PiiRedactor.redact("https://meet.google.com/abc-defg-hij")
    const a2 = PiiRedactor.redact("https://meet.google.com/abc-defg-hij")
    const b = PiiRedactor.redact("https://meet.google.com/zzz-zzzz-zzz")
    expect(a1).toBe(a2)
    expect(b).not.toBe(a1)
  })

  it("trailing punctuation does not change the tag", () => {
    const plain = PiiRedactor.redact("go to https://meet.google.com/abc-defg-hij")
    const punct = PiiRedactor.redact("go to https://meet.google.com/abc-defg-hij.")
    expect(punct).toBe(`${plain}.`)
  })

  it("re-redaction leaves tagged placeholders unchanged (idempotent)", () => {
    const once = PiiRedactor.redact("url https://meet.google.com/abc-defg-hij done")
    expect(PiiRedactor.redact(once)).toBe(once)
  })
})

/**
 * A dictionary entry is an unanchored find/replace over every log line, and
 * display names are end-user controlled. A name that also occurs as ordinary
 * log text must therefore never enter the dictionary.
 */
describe("dictionary safety for short and numeric names", () => {
  beforeEach(() => {
    delete process.env.DISABLE_LOG_PII_REDACTION
    PiiRedactor.reset()
  })

  afterAll(() => {
    PiiRedactor.reset()
  })

  it("does not let a numeric display name rewrite ISO timestamps", () => {
    PiiRedactor.registerSpeaker("56")
    // sound-level-monitor writes exactly this shape into sound.log.
    expect(PiiRedactor.redact("2026-08-04T12:34:56.789Z,42")).toBe("2026-08-04T12:34:56.789Z,42")
  })

  it("does not let a numeric display name eat counters, sizes and ports", () => {
    PiiRedactor.registerSpeaker("100")
    expect(PiiRedactor.redact("uploaded 100 MB in 100 ms (port 8100)")).toBe(
      "uploaded 100 MB in 100 ms (port 8100)"
    )
  })

  it("does not let a single-character display name rewrite prose", () => {
    PiiRedactor.registerSpeaker("A")
    expect(PiiRedactor.redact("A new participant joined")).toBe("A new participant joined")
  })

  it("still hands unsafe names a stable, distinct placeholder", () => {
    // Callers use the return value as a display label, so it must stay stable
    // and must not collide with another speaker's label.
    expect(PiiRedactor.registerSpeaker("56")).toBe("<SPEAKER_1>")
    expect(PiiRedactor.registerSpeaker("Real Name")).toBe("<SPEAKER_2>")
    expect(PiiRedactor.registerSpeaker("56")).toBe("<SPEAKER_1>")
  })

  it("still redacts a bare dial-in phone number", () => {
    PiiRedactor.registerSpeaker("5551234567")
    expect(PiiRedactor.redact("caller 5551234567 joined")).toBe("caller <SPEAKER_1> joined")
  })

  it("still redacts a two-character CJK surname", () => {
    PiiRedactor.registerSpeaker("田中")
    expect(PiiRedactor.redact("speaker 田中 joined")).toBe("speaker <SPEAKER_1> joined")
  })

  it("keeps an unsafe bot name out of the dictionary too", () => {
    PiiRedactor.registerBotName("42")
    expect(PiiRedactor.redact("retry 42 of 42")).toBe("retry 42 of 42")
  })
})

describe("unicode case-folding matches resolve to a placeholder", () => {
  beforeEach(() => {
    delete process.env.DISABLE_LOG_PII_REDACTION
    PiiRedactor.reset()
  })

  afterAll(() => {
    PiiRedactor.reset()
  })

  it("folds medial and word-final Greek sigma to the same speaker", () => {
    // The alternation matches under Unicode case folding, which treats σ and ς
    // as equal; the placeholder lookup has to agree, or the name leaks through.
    expect(PiiRedactor.registerSpeaker("Νίκοσ")).toBe("<SPEAKER_1>")
    const out = PiiRedactor.redact("speaker Νίκος joined")
    expect(out).toBe("speaker <SPEAKER_1> joined")
    expect(out).not.toContain("Νίκος")
  })

  it("never returns the raw matched name when it cannot be resolved", () => {
    PiiRedactor.registerSpeaker("Νίκοσ")
    // Whatever the fold, the matched text must not survive into the output.
    for (const variant of ["Νίκος", "Νίκοσ", "ΝΊΚΟΣ"]) {
      const out = PiiRedactor.redact(`speaker ${variant} joined`)
      expect(out).not.toContain(variant)
      expect(out).toMatch(/<SPEAKER_1>|<REDACTED_NAME>/)
    }
  })
})

describe("speaker registry overflow bounds", () => {
  beforeEach(() => {
    delete process.env.DISABLE_LOG_PII_REDACTION
    PiiRedactor.reset()
  })

  afterAll(() => {
    PiiRedactor.reset()
  })

  const nameAt = (i: number) => `Overflow Person Number ${i}`

  it("assigns distinct placeholders up to MAX_SPEAKERS, then <SPEAKER_OVERFLOW>", () => {
    for (let i = 0; i < 499; i++) PiiRedactor.registerSpeaker(nameAt(i))
    // 500th distinct name is the last to get its own number.
    expect(PiiRedactor.registerSpeaker("Last Numbered Person")).toBe("<SPEAKER_500>")
    expect(PiiRedactor.registerSpeaker("First Overflow Person")).toBe("<SPEAKER_OVERFLOW>")
  })

  it("still redacts names registered past MAX_SPEAKERS", () => {
    for (let i = 0; i < 500; i++) PiiRedactor.registerSpeaker(nameAt(i))
    PiiRedactor.registerSpeaker("Zaphod Beeblebrox")
    // The whole point of registering past the cap: the raw name must not leak.
    expect(PiiRedactor.redact("Zaphod Beeblebrox started speaking")).toBe(
      "<SPEAKER_OVERFLOW> started speaking"
    )
  })

  it("stops registering at MAX_TOTAL_NAMES, leaving later names unredacted", () => {
    for (let i = 0; i < 5000; i++) PiiRedactor.registerSpeaker(nameAt(i))
    expect(PiiRedactor.registerSpeaker("Way Past The Backstop")).toBe("<SPEAKER_OVERFLOW>")
    // Documented gap, pinned deliberately: past the absolute backstop a name is
    // NOT added to the dictionary, so it survives in log content. The cap keeps
    // dictionary growth (and redact() cost) bounded on a pathological run.
    expect(PiiRedactor.redact("Way Past The Backstop spoke")).toBe("Way Past The Backstop spoke")
  })
})
