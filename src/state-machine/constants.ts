import { MeetingEndReason } from './types'

export const MEETING_CONSTANTS = {
    // Duration
    CHUNKS_PER_TRANSCRIPTION: 18,
    CHUNK_DURATION: 10_000, // 10 secondes pour chaque chunk
    
    // Timeouts
    SETUP_TIMEOUT: 30_000, // 30 secondes
    RECORDING_TIMEOUT: 3600 * 4 * 1000, // 4 heures
    INITIAL_WAIT_TIME: 1000 * 60 * 7, // 7 minutes
    SILENCE_TIMEOUT: 1000 * 60 * 10, // 10 minutes
    EMPTY_MEETING_CONFIRMATION_MS: 45_000, // 45 seconds before confirming no attendees
    CLEANUP_TIMEOUT: 1000 * 60 * 60, // 1 heure
    RESUMING_TIMEOUT: 1000 * 60 * 60, // 1 heure

    // Other constants
    FIND_END_MEETING_SLEEP: 250,
    MAX_RETRIES: 3,
    
    // Audio detection
    SOUND_LEVEL_ACTIVITY_THRESHOLD: 5, // Sound level threshold for considering activity (0-100)
    SYNC_BEEP_IGNORE_WINDOW: 9, // Ignore sounds in first 9 seconds after recording start (beep at ~4.5s + 0.8s duration + margin)
} as const

export const NORMAL_END_REASONS = [
    MeetingEndReason.ApiRequest, // User intentionally stopped recording via API
    MeetingEndReason.BotRemoved, // Bot was removed by meeting participants (expected behavior)
    MeetingEndReason.BotRemovedTooEarly, // Bot removed before minimum time but recording still completed
    MeetingEndReason.NoAttendees, // No participants joined the meeting (common scenario)
    MeetingEndReason.NoSpeaker, // No audio activity detected (silent meeting)
    MeetingEndReason.RecordingTimeout, // Maximum recording duration reached (time limit hit)
]
