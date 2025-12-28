import type { BrowserContext, Page } from "@playwright/test"
import type { output } from "zod"
import type {
  BotMessageSchema,
  MeetingPlatformSchema,
  RecordingModeSchema
} from "./utils/meeting-params-schema"

// Support both PascalCase and snake_case for recording_mode
export type RecordingMode = output<typeof RecordingModeSchema>

export interface MeetingProviderInterface {
  openMeetingPage(
    browserContext: BrowserContext,
    link: string,
    streaming_input: string | undefined
  ): Promise<Page>
  joinMeeting(page: Page, cancelCheck: () => boolean, onJoinSuccess: () => void): Promise<void>
  findEndMeeting(page: Page): Promise<boolean>
  parseMeetingUrl(meeting_url: string): Promise<{ meetingId: string; password: string }>
  getMeetingLink(
    meeting_id: string,
    _password: string,
    _role: number,
    _bot_name: string,
    _enter_message?: string
  ): string
  closeMeeting(page: Page): Promise<void>
}

export type MeetingParams = output<typeof BotMessageSchema>

export type StopRecordParams = {
  meeting_url: string
  user_id: number
}

export type SpeakerData = {
  name: string
  id: number
  timestamp: number
  isSpeaking: boolean
}
export type MeetingProvider = output<typeof MeetingPlatformSchema>

export type Participant = {
  name: string
  id: number | null
}

export type ArtifactType = "audio" | "video" | "screenshots" | "diarization"
export type ArtifactErrorCode =
  | "FILE_NOT_FOUND"
  | "UPLOAD_FAILED"
  | "FILE_TOO_SMALL"
  | "UNKNOWN_ERROR"
  | "NOT_SUPPORTED"

export type ArtifactKey = {
  s3Key: string | null
  filePath: string
  extension: string
  uploaded: boolean
  uploadedAt: string | null
  type: ArtifactType
  errorCode: ArtifactErrorCode | null
  errorMessage: string | null
}

// Streaming transcription types
// Re-export TranscriptionProvider from voice-router-dev for use in other modules
export type { TranscriptionProvider } from "voice-router-dev"

// Subset of providers that support real-time streaming
export type StreamingTranscriptionProvider = "gladia" | "deepgram" | "assemblyai"

export type StreamingTranscriptionOptions = {
  language?: string
  interim_results?: boolean
  diarization?: boolean
  word_timestamps?: boolean
  punctuation?: boolean
  profanity_filter?: boolean
  custom_vocabulary?: string[]
  endpointing_ms?: number
}

export type StreamingTranscriptionConfig = {
  provider: StreamingTranscriptionProvider
  api_key?: string
  output_url: string
  websocket_timeout_ms?: number
  encoding?: string
  sample_rate?: number
  model?: string // Provider-specific model (e.g., 'nova-2' for Deepgram multilingual)
  options?: StreamingTranscriptionOptions
}

// Enhanced speaker data for network-level detection
export type EnhancedSpeakerData = SpeakerData & {
  odaId?: string
  participantId?: string
  displayName?: string
  fullName?: string
  profilePicture?: string
  isNetworkDetected?: boolean
}
