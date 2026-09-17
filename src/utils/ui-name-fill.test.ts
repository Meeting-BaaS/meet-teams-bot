import { chooseLiveFillName, pickFreshUiSpeakerName } from "./ui-name-fill"

describe("pickFreshUiSpeakerName", () => {
  const speaker = (name: string, isSpeaking: boolean, isSelf?: boolean) => ({
    name,
    isSpeaking,
    isSelf
  })

  it("returns the name when exactly one named speaker is active", () => {
    expect(
      pickFreshUiSpeakerName({
        observed: [speaker("Alice", true), speaker("Bob", false)],
        excludedNames: []
      })
    ).toBe("Alice")
  })

  it("returns null when two named speakers are active", () => {
    expect(
      pickFreshUiSpeakerName({
        observed: [speaker("Alice", true), speaker("Bob", true)],
        excludedNames: []
      })
    ).toBeNull()
  })

  it("returns null when a named speaker and an active Unknown row share the floor", () => {
    expect(
      pickFreshUiSpeakerName({
        observed: [speaker("Alice", true), speaker("Unknown", true)],
        excludedNames: []
      })
    ).toBeNull()
  })

  it("returns null when every active speaker is Unknown", () => {
    expect(
      pickFreshUiSpeakerName({
        observed: [speaker("Unknown", true)],
        excludedNames: []
      })
    ).toBeNull()
  })

  it("never names the bot via its self marker", () => {
    expect(
      pickFreshUiSpeakerName({
        observed: [speaker("Google Account Name", true, true)],
        excludedNames: []
      })
    ).toBeNull()
  })

  it("excludes bot_name and the learned self display name", () => {
    expect(
      pickFreshUiSpeakerName({
        observed: [speaker("SPEAKER SEP Test", true)],
        excludedNames: ["SPEAKER SEP Test"]
      })
    ).toBeNull()
  })

  it("ignores non-speaking entries and empty names", () => {
    expect(
      pickFreshUiSpeakerName({
        observed: [speaker("", true), speaker("Bob", false)],
        excludedNames: []
      })
    ).toBeNull()
  })
})

describe("chooseLiveFillName", () => {
  const evidence = { name: "Alice", at: 1_000 }

  it("fills when one unresolved speaker is the only one speaking and evidence is fresh", () => {
    expect(
      chooseLiveFillName({
        networkSpeakingCount: 1,
        unresolvedSpeakingCount: 1,
        evidence,
        now: 2_000
      })
    ).toBe("Alice")
  })

  it("does not fill when several unresolved speakers are active", () => {
    expect(
      chooseLiveFillName({
        networkSpeakingCount: 2,
        unresolvedSpeakingCount: 2,
        evidence,
        now: 2_000
      })
    ).toBeNull()
  })

  it("does not fill when a resolved speaker is active next to the unresolved one", () => {
    expect(
      chooseLiveFillName({
        networkSpeakingCount: 2,
        unresolvedSpeakingCount: 1,
        evidence,
        now: 2_000
      })
    ).toBeNull()
  })

  it("does not fill without evidence", () => {
    expect(
      chooseLiveFillName({
        networkSpeakingCount: 1,
        unresolvedSpeakingCount: 1,
        evidence: null,
        now: 2_000
      })
    ).toBeNull()
  })

  it("does not fill once the evidence expired", () => {
    expect(
      chooseLiveFillName({
        networkSpeakingCount: 1,
        unresolvedSpeakingCount: 1,
        evidence,
        now: 1_000 + 5_001
      })
    ).toBeNull()
  })

  it("fills at the freshness boundary", () => {
    expect(
      chooseLiveFillName({
        networkSpeakingCount: 1,
        unresolvedSpeakingCount: 1,
        evidence,
        now: 1_000 + 5_000
      })
    ).toBe("Alice")
  })
})
