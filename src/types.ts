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
  joinMeeting(
    page: Page,
    cancelCheck: () => boolean,
    onJoinSuccess: () => void,
    dialogObserver?: import("./services/dialog-observer/simple-dialog-observer").SimpleDialogObserver
  ): Promise<void>
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
  id: number // Sequential user ID (0 for UI-based detection, 1+ for network-based)
  timestamp: number
  isSpeaking: boolean
}
export type MeetingProvider = output<typeof MeetingPlatformSchema>

export type Participant = {
  name: string // Full name (stable identifier from network, or display name from UI)
  id: number | null // Our sequential ID (1, 2, 3...)
  // Network-detected fields (optional)
  displayName?: string // Display name shown in UI (if different from name)
  profilePicture?: string // Profile picture URL
  odaId?: string // ODA ID from network (if available)
  participantId?: string // Participant ID from network payload (for debugging/correlation, different from our sequential id)
  isNetworkDetected?: boolean // Flag to indicate network vs UI detection
}

export type ChatMessageData = {
  text: string
  senderName: string
  senderId: number | null
  timestamp: number
  messageId: string
  deviceId?: string // Internal: used for participant lookup (Meet), not sent in webhook
}

export type SendChatMessageParams = {
  message: string
}

export type ArtifactType = "audio" | "video" | "screenshots" | "diarization" | "chat_messages"
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
