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
