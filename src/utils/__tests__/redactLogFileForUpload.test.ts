import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { redactLogFileForUpload } from "../Logger"
import { PiiRedactor } from "../PiiRedactor"

/**
 * redactLogFileForUpload streams the file through the redactor and renames the
 * result over the original. These tests pin the two properties that rewrite
 * buys us — byte-fidelity and atomicity — against the whole-file
 * read/split/join it replaced.
 */

/** The implementation this replaced; used as the byte-fidelity oracle. */
function redactWholeFile(content: string): string {
  return content
    .split("\n")
    .map((line) => PiiRedactor.redact(line))
    .join("\n")
}

let tempDir: string

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pii-log-"))
})

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

beforeEach(() => {
  delete process.env.DISABLE_LOG_PII_REDACTION
  PiiRedactor.reset()
  PiiRedactor.registerBotName("Acme Notetaker")
  PiiRedactor.registerSpeaker("John Doe")
  PiiRedactor.registerSpeaker("田中太郎")
})

afterAll(() => {
  PiiRedactor.reset()
})

let fileCounter = 0
function writeTempFile(content: string): string {
  const filePath = path.join(tempDir, `log-${fileCounter++}.log`)
  fs.writeFileSync(filePath, content, "utf-8")
  return filePath
}

describe("redactLogFileForUpload", () => {
  it("redacts PII in place", async () => {
    const filePath = writeTempFile("John Doe joined from john@acme.com\n")
    await expect(redactLogFileForUpload(filePath)).resolves.toBe(true)
    expect(fs.readFileSync(filePath, "utf-8")).toBe("<SPEAKER_1> joined from <EMAIL>\n")
  })

  // Each case is a byte-fidelity trap the streaming rewrite could fall into:
  // a dropped or added trailing newline, a collapsed blank line, or an empty
  // file turned into a stray "\n".
  const fidelityCases: Array<[string, string]> = [
    ["trailing newline", "John Doe spoke\nsecond line\n"],
    ["no trailing newline", "John Doe spoke\nsecond line"],
    ["blank lines preserved", "John Doe\n\n\nsecond\n\n"],
    ["single line, no newline", "John Doe"],
    ["empty file", ""],
    ["only newlines", "\n\n\n"],
    ["unicode names", "田中太郎 said hi\nJohn Doe replied\n"]
  ]

  it.each(fidelityCases)("is byte-identical to whole-file redaction (%s)", async (_n, content) => {
    const filePath = writeTempFile(content)
    await expect(redactLogFileForUpload(filePath)).resolves.toBe(true)
    expect(fs.readFileSync(filePath, "utf-8")).toBe(redactWholeFile(content))
  })

  it("handles multi-byte characters and long lines spanning read-stream chunks", async () => {
    // The read stream emits 64 KiB chunks, so this deliberately straddles
    // several boundaries with multi-byte characters and one line longer than a
    // whole chunk — the cases a naive chunk-splitter corrupts.
    const long = `${"田中太郎 ".repeat(20000)}John Doe`
    const content = `${long}\nJohn Doe é ü 田中太郎\n${long}\n`
    expect(content.length).toBeGreaterThan(200_000)

    const filePath = writeTempFile(content)
    await expect(redactLogFileForUpload(filePath)).resolves.toBe(true)
    const result = fs.readFileSync(filePath, "utf-8")

    expect(result).toBe(redactWholeFile(content))
    expect(result).not.toContain("John Doe")
    expect(result).not.toContain("田中太郎")
  })

  it("leaves no temp file behind on success", async () => {
    const filePath = writeTempFile("John Doe\n")
    await redactLogFileForUpload(filePath)
    expect(fs.existsSync(`${filePath}.redacting`)).toBe(false)
  })

  it("reports failure and leaves the original untouched when the file is unreadable", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      const missing = path.join(tempDir, "does-not-exist.log")
      await expect(redactLogFileForUpload(missing)).resolves.toBe(false)
      expect(fs.existsSync(missing)).toBe(false)
      expect(fs.existsSync(`${missing}.redacting`)).toBe(false)
    } finally {
      consoleError.mockRestore()
    }
  })

  it("is idempotent — a second pass changes nothing", async () => {
    const filePath = writeTempFile(
      "John Doe met 田中太郎 at https://meet.google.com/abc-defg-hij\n"
    )
    await redactLogFileForUpload(filePath)
    const once = fs.readFileSync(filePath, "utf-8")
    await redactLogFileForUpload(filePath)
    expect(fs.readFileSync(filePath, "utf-8")).toBe(once)
  })
})
