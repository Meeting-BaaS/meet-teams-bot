import type { SpeakerData } from "../types"
import { silenceBotSpeaker } from "./speaker-attribution"

const at = 1785941000000

function speaker(name: string, isSpeaking: boolean): SpeakerData {
  return { name, id: 0, timestamp: at, isSpeaking }
}

describe("silenceBotSpeaker", () => {
  it("never lets the bot hold the floor", () => {
    // The production failure: the bot's own row read as speaking on every
    // callback, so the diarization opened one segment for it and never changed
    // speaker again for the rest of the meeting.
    const result = silenceBotSpeaker(
      [speaker("SPEAKER SEP Test", true), speaker("Amr El Shimy", true)],
      "SPEAKER SEP Test"
    )

    expect(result.map((s) => s.isSpeaking)).toEqual([false, true])
  })

  it("keeps the bot in the roster rather than dropping it", () => {
    const result = silenceBotSpeaker([speaker("Notetaker", true), speaker("Johnny", false)], "Notetaker")

    expect(result.map((s) => s.name)).toEqual(["Notetaker", "Johnny"])
  })

  it("matches the bot regardless of case and surrounding whitespace", () => {
    const result = silenceBotSpeaker([speaker("  MeetingBaas Bot ", true)], "meetingbaas bot")

    expect(result[0].isSpeaking).toBe(false)
  })

  it("leaves every human speaker untouched", () => {
    const humans = [speaker("Amr El Shimy", true), speaker("Johnny", true)]

    expect(silenceBotSpeaker(humans, "SPEAKER SEP Test")).toEqual(humans)
  })

  it("returns the input untouched when the bot name is unknown", () => {
    const speakers = [speaker("Amr El Shimy", true)]

    expect(silenceBotSpeaker(speakers, undefined)).toBe(speakers)
    expect(silenceBotSpeaker(speakers, "   ")).toBe(speakers)
  })

  it("does not resurrect a bot that was already silent", () => {
    const result = silenceBotSpeaker([speaker("Bot", false)], "Bot")

    expect(result[0].isSpeaking).toBe(false)
  })
})
