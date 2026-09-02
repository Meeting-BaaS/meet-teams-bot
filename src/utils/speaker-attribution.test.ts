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
      "SPEAKER SEP Test",
      false
    )

    expect(result.map((s) => s.isSpeaking)).toEqual([false, true])
  })

  it("keeps the bot in the roster rather than dropping it", () => {
    const result = silenceBotSpeaker(
      [speaker("Notetaker", true), speaker("Johnny", false)],
      "Notetaker",
      false
    )

    expect(result.map((s) => s.name)).toEqual(["Notetaker", "Johnny"])
  })

  it("matches the bot regardless of case and surrounding whitespace", () => {
    const result = silenceBotSpeaker(
      [speaker("  MeetingBaas Bot ", true)],
      "meetingbaas bot",
      false
    )

    expect(result[0].isSpeaking).toBe(false)
  })

  it("leaves every human speaker untouched", () => {
    const humans = [speaker("Amr El Shimy", true), speaker("Johnny", true)]

    expect(silenceBotSpeaker(humans, "SPEAKER SEP Test", false)).toEqual(humans)
  })

  it("returns the input untouched when the bot name is unknown", () => {
    const speakers = [speaker("Amr El Shimy", true)]

    expect(silenceBotSpeaker(speakers, undefined, false)).toBe(speakers)
    expect(silenceBotSpeaker(speakers, "   ", false)).toBe(speakers)
  })

  it("leaves a bot that streams audio into the meeting speaking", () => {
    // A voice agent holds the floor for real: silencing it would delete its own
    // half of the conversation from the transcript.
    const result = silenceBotSpeaker(
      [speaker("Voice Agent", true), speaker("Amr El Shimy", false)],
      "Voice Agent",
      true
    )

    expect(result.map((s) => s.isSpeaking)).toEqual([true, false])
  })

  it("does not resurrect a bot that was already silent", () => {
    const result = silenceBotSpeaker([speaker("Bot", false)], "Bot", false)

    expect(result[0].isSpeaking).toBe(false)
  })
})

describe("silenceBotSpeaker self marker", () => {
  it("silences a self-marked speaker whose displayed name is not bot_name", () => {
    // SSO login: the bot displays the Google account's name.
    const result = silenceBotSpeaker(
      [{ name: "MeetingBaaS's Notetaker", id: 0, timestamp: 1, isSpeaking: true, isSelf: true }],
      "Amr's Notetaker",
      false
    )
    expect(result[0].isSpeaking).toBe(false)
  })

  it("keeps a self-marked voice agent speaking", () => {
    const result = silenceBotSpeaker(
      [{ name: "Voice Agent", id: 0, timestamp: 1, isSpeaking: true, isSelf: true }],
      "Voice Agent",
      true
    )
    expect(result[0].isSpeaking).toBe(true)
  })
})
