import type { SpeakerData } from "../types"

/**
 * A recording bot is a participant, never a speaker.
 *
 * Its own row in the meeting UI can read as permanently talking: a production
 * Meet bot ran a whole 14-minute call with its own row flagged speaking on every
 * single observer callback. The diarization opened one segment for the bot at
 * the first callback and never saw a speaker change again, so the meeting
 * finished with exactly one segment carrying the bot's name — and downstream
 * that is either a transcript in the bot's name or, when the provider disagrees,
 * anonymous "Speaker N" labels.
 *
 * A recording bot's microphone is deactivated before it joins, so a speaking
 * reading for it is always a UI artifact rather than audio. That is exactly what
 * botCanSpeak decides: a bot streaming audio into the meeting genuinely holds
 * the floor, and silencing it would delete the agent's own turns from the
 * transcript — the half of the conversation those bots exist to record.
 *
 * Matching is by name because that is all the UI observer knows about identity.
 * A human who happens to share the bot's name is silenced too; that costs one
 * participant's attribution, where the bug it prevents costs the whole meeting.
 *
 * @param speakers - Speaker states as observed
 * @param botName - The bot's display name in this meeting
 * @param botCanSpeak - Whether this bot streams audio into the meeting
 */
export function silenceBotSpeaker(
  speakers: SpeakerData[],
  botName: string | undefined,
  botCanSpeak: boolean
): SpeakerData[] {
  if (botCanSpeak) return speakers
  if (!botName?.trim() && !speakers.some((speaker) => speaker.isSelf === true)) {
    return speakers
  }

  // isSelf comes from the platform's own self marker and is name-independent —
  // it catches the SSO case where the bot displays the login account's name
  // instead of bot_name and name matching misses it entirely.
  return speakers.map((speaker) =>
    speaker.isSpeaking && (speaker.isSelf === true || isBotName(speaker.name, botName))
      ? { ...speaker, isSpeaking: false }
      : speaker
  )
}

/**
 * Whether an observed participant is the bot itself.
 *
 * Callers that register speakers somewhere silenceBotSpeaker cannot reach —
 * the global speaker registry is append-only — must consult this first, or the
 * bot lands in the final payload as a speaker and no later pass can take it
 * back out.
 *
 * @param name - Observed participant name
 * @param botName - The bot's display name in this meeting
 */
export function isBotName(name: string | undefined, botName: string | undefined): boolean {
  const normalizedBotName = botName?.trim().toLowerCase()
  if (!normalizedBotName) return false

  return name?.trim().toLowerCase() === normalizedBotName
}
