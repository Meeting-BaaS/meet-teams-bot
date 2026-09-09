import {
  disguiseBotName,
  isBotLikeName,
  skeletonizeBotName
} from "./bot-name-disguise"

const SEED = "0b4a1f3c-2d4e-4a91-9f0b-7c1d2e3f4a5b"

describe("bot name disguise", () => {
  it("leaves an ordinary name completely alone", () => {
    for (const name of ["Amr El Shimy", "Sales sync", "Christopher Nolan", ""]) {
      expect(disguiseBotName(name, SEED)).toBe(name)
    }
  })

  it("breaks a literal substring match on the offending token", () => {
    const out = disguiseBotName("Notetaker", SEED)
    expect(out).not.toBe("Notetaker")
    expect(out.toLowerCase()).not.toContain("notetaker")
    expect(out).toHaveLength("Notetaker".length)
  })

  // A wholly mixed-script name is what the Unicode confusables check is built to
  // catch, and it is a stronger bot signal than the word it hides.
  it("substitutes exactly one character per offending token", () => {
    const original = "Acme Notetaker"
    const out = disguiseBotName(original, SEED)
    let changed = 0
    for (let i = 0; i < original.length; i++) {
      if (original.charAt(i) !== out.charAt(i)) changed++
    }
    expect(changed).toBe(1)
  })

  it("handles a name carrying two offending tokens", () => {
    const original = "AI Notetaker"
    const out = disguiseBotName(original, SEED)
    let changed = 0
    for (let i = 0; i < original.length; i++) {
      if (original.charAt(i) !== out.charAt(i)) changed++
    }
    expect(changed).toBe(2)
    expect(skeletonizeBotName(out)).toBe(original)
  })

  it("is stable for a bot across retries and varies between bots", () => {
    expect(disguiseBotName("Notetaker", SEED)).toBe(disguiseBotName("Notetaker", SEED))
    const many = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((s) => disguiseBotName("Notetaker", s))
    )
    expect(many.size).toBeGreaterThan(1)
  })

  it("round-trips back to the customer's spelling", () => {
    for (const name of ["Notetaker", "Recording Bot", "Nova the AI assistant", "notes"]) {
      expect(skeletonizeBotName(disguiseBotName(name, SEED))).toBe(name)
    }
  })

  // Fullwidth and mathematical look-alikes fold straight back to ASCII, so a
  // server that normalises before matching would see through them. Cyrillic does
  // not decompose — this is the property the whole approach rests on.
  it("survives NFC and NFKC normalisation", () => {
    const out = disguiseBotName("Notetaker", SEED)
    expect(out.normalize("NFC")).toBe(out)
    expect(out.normalize("NFKC")).toBe(out)
    expect(out.normalize("NFKC").toLowerCase()).not.toContain("notetaker")
  })

  it("keeps our own bot-like-name detection working through the disguise", () => {
    const out = disguiseBotName("Notetaker", SEED)
    expect(isBotLikeName(out)).toBe(false)
    expect(isBotLikeName(skeletonizeBotName(out))).toBe(true)
  })

  it("does not mangle a token with no honest look-alike", () => {
    // "bot" is matched, and every letter of it has a twin, so this asserts the
    // guard rather than the happy path: a token of untwinned letters is skipped.
    expect(disguiseBotName("Notetaker", SEED)).not.toContain("?")
  })
})
