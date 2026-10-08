import type { SpeakerData as BaseSpeakerData } from './types'
import { UNKNOWN_SPEAKER } from './types'

export type SpeakerData = BaseSpeakerData & { isSelf?: boolean }
export {
    createSequentialIdManager,
    generateStableUserId,
} from './utils/speaker-id'

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
    botCanSpeak: boolean,
): SpeakerData[] {
    if (botCanSpeak) return speakers
    if (
        !botName?.trim() &&
        !speakers.some((speaker) => speaker.isSelf === true)
    ) {
        return speakers
    }

    // isSelf comes from the platform's own self marker and is name-independent —
    // it catches the SSO case where the bot displays the login account's name
    // instead of bot_name and name matching misses it entirely.
    return speakers.map((speaker) =>
        speaker.isSpeaking &&
        (speaker.isSelf === true || isBotName(speaker.name, botName))
            ? { ...speaker, isSpeaking: false }
            : speaker,
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
export function isBotName(
    name: string | undefined,
    botName: string | undefined,
): boolean {
    const normalizedBotName = botName?.trim().toLowerCase()
    if (!normalizedBotName) return false

    return name?.trim().toLowerCase() === normalizedBotName
}

/**
 * How long a piece of UI name evidence stays usable for live fills.
 *
 * The UI observer emits only on speaker CHANGES (full-state snapshots), and
 * Meet's network path detects the same turn 3–5.3s later — the documented
 * median gap between the UI indicator and the first network segment. A TTL at
 * or below that gap makes most turns unfillable: in prod (bot 0799c68d,
 * ~70min, six participants) exactly one fill fired all call. This window must
 * comfortably exceed that lag; newer snapshots still replace or clear the
 * evidence, so staleness stays bounded by the next DOM change.
 */
export const UI_NAME_FILL_MAX_AGE_MS = 12_000

/**
 * The single named person the UI observer currently sees speaking, or null.
 *
 * Counts EVERY active non-self, non-excluded row before accepting the name —
 * `[Alice speaking, Unknown speaking]` has two people active and yields null,
 * even though only one of them is named. Self rows (the bot's own marker) and
 * excluded names (bot_name / learned self identity) never qualify.
 */
export function pickFreshUiSpeakerName(params: {
    observed: Pick<SpeakerData, 'name' | 'isSpeaking' | 'isSelf'>[]
    excludedNames: string[]
}): string | null {
    const excluded = new Set(
        params.excludedNames.map((name) => name.trim().toLowerCase()),
    )
    const active = params.observed.filter(
        (speaker) =>
            speaker.isSpeaking === true &&
            speaker.isSelf !== true &&
            !(speaker.name && excluded.has(speaker.name.trim().toLowerCase())),
    )
    if (active.length !== 1) return null
    const name = active[0].name
    if (!name || name === UNKNOWN_SPEAKER) return null
    return name
}

/**
 * The name to fill into an unresolved (Unknown) network speaker, or null.
 *
 * Guards, in order:
 *  - the update holds exactly one speaking network speaker overall, so a
 *    resolved speaker active next to the unresolved one can never lend it a
 *    name (that would double-name one voice);
 *  - that sole speaker is the unresolved one;
 *  - the UI evidence is fresh (≤ maxAgeMs).
 *
 * Resolved network names are never candidates; callers only fill Unknown ones.
 */
export function chooseLiveFillName(params: {
    networkSpeakingCount: number
    unresolvedSpeakingCount: number
    evidence: { name: string; at: number } | null
    now: number
    maxAgeMs?: number
}): string | null {
    if (
        params.networkSpeakingCount !== 1 ||
        params.unresolvedSpeakingCount !== 1
    )
        return null
    const { evidence } = params
    if (!evidence || !evidence.name) return null
    const maxAge = params.maxAgeMs ?? UI_NAME_FILL_MAX_AGE_MS
    const age = params.now - evidence.at
    if (!Number.isFinite(age) || age < 0 || age > maxAge) return null
    return evidence.name
}
