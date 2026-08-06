import type { SpeakerData } from "../types"

/**
 * The bot is a participant, never a speaker.
 *
 * Its own row in the meeting UI can read as permanently talking: a production
 * Meet bot ran a whole 14-minute call with its own row flagged speaking on every
 * single observer callback. The diarization opened one segment for the bot at
 * the first callback and never saw a speaker change again, so the meeting
 * finished with exactly one segment carrying the bot's name — and downstream
 * that is either a transcript in the bot's name or, when the provider disagrees,
 * anonymous "Speaker N" labels.
 *
 * The bot's microphone is deactivated before it joins, so a speaking reading for
 * it is always a UI artifact rather than audio.
 *
 * Matching is by name because that is all the UI observer knows about identity.
 * A human who happens to share the bot's name is silenced too; that costs one
 * participant's attribution, where the bug it prevents costs the whole meeting.
 *
 * @param speakers - Speaker states as observed
 * @param botName - The bot's display name in this meeting
 */
export function silenceBotSpeaker(speakers: SpeakerData[], botName: string | undefined): SpeakerData[] {
  const normalizedBotName = botName?.trim().toLowerCase()
  if (!normalizedBotName) return speakers

  return speakers.map((speaker) =>
    speaker.isSpeaking && speaker.name?.trim().toLowerCase() === normalizedBotName
      ? { ...speaker, isSpeaking: false }
      : speaker
  )
}
