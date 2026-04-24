import { MeetingEndReason } from "./types"

export const MEETING_CONSTANTS = {
  // Durées
  CHUNKS_PER_TRANSCRIPTION: 18,
  CHUNK_DURATION: 10_000, // 10 secondes pour chaque chunk
  // TRANSCRIBE_DURATION: 10_000 * MEETING_CONSTANTS.CHUNKS_PER_TRANSCRIPTION, // 3 minutes pour chaque transcription

  // Timeouts
  SETUP_TIMEOUT: 30_000, // 30 secondes
  RECORDING_TIMEOUT: 3600 * 4 * 1000, // 4 heures
  INITIAL_WAIT_TIME: 1000 * 60 * 7, // 7 minutes
  EMPTY_MEETING_CONFIRMATION_MS: 45_000, // 45 seconds before confirming no attendees
  // Outer cleanup timeout. Typical cleanup runs in 2–15 minutes; the headroom
  // exists so pathologically slow object-store uploads don't cut cleanup short
  // before it completes. If this does fire, cleanup-state mirrors the bot's
  // working directory to EFS before transitioning to Terminated so a
  // reconciliation job can push the built output files to S3 later.
  //
  // The outer process SIGKILL lives in sqs-consumer via the
  // REDIS_SESSION_EXPIRATION_SEC env var (set from helm chart values); keep
  // this timeout below that so our own EFS-mirror path gets a chance to run.
  CLEANUP_TIMEOUT: 1000 * 60 * 60, // 1 hour
  RESUMING_TIMEOUT: 1000 * 60 * 60, // 1 heure
  DEFAULT_SILENCE_TIMEOUT_SECONDS: 600, // 10 minutes - default fallback when global value is nil
  DEFAULT_NOONE_JOINED_TIMEOUT_SECONDS: 600, // 10 minutes - default fallback matching API server default

  // Autres constantes
  FIND_END_MEETING_SLEEP: 250,
  MAX_RETRIES: 3
} as const

export const NORMAL_END_REASONS = [
  MeetingEndReason.ApiRequest, // User intentionally stopped recording via API
  MeetingEndReason.BotRemoved, // Bot was removed by meeting participants (expected behavior)
  MeetingEndReason.BotRemovedTooEarly, // Bot removed before minimum time but recording still completed
  MeetingEndReason.NoAttendees, // No participants joined the meeting (common scenario)
  MeetingEndReason.NoSpeaker, // No audio activity detected (silent meeting)
  MeetingEndReason.AllParticipantsLeft, // All human participants left the meeting
  MeetingEndReason.RecordingTimeout // Maximum recording duration reached (time limit hit)
]
