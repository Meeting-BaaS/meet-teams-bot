import { BrowserContext, Page } from '@playwright/test'

type SpeechToTextProvider = 'Default' | 'Gladia' | 'RunPod'

// Support both PascalCase and snake_case for recording_mode
export type RecordingMode =
    | 'speaker_view'
    | 'gallery_view'
    | 'audio_only'
    | 'SpeakerView'
    | 'GalleryView'
    | 'AudioOnly'

export interface SpeechToTextApiParameter {
    provider: SpeechToTextProvider
    api_key: string
}

export interface AutomaticLeave {
    // The number of seconds after which the bot will automatically leave the call, if it has not been let in from the waiting room.
    waiting_room_timeout: number
    // The number of seconds after which the bot will automatically leave the call, if it has joined the meeting but no other participant has joined.
    noone_joined_timeout: number
    // The number of seconds after which the bot will automatically leave the call, if there were other participants in the call who have all left.
    // everyone_left_timeout?: number
    // The number of seconds after which the bot will automatically leave the call, if it has joined the call but not started recording.
    // in_call_not_recording_timeout?: number
    // The number of seconds after which the bot will automatically leave the call, if it has joined the call and started recording it. This can be used to enforce a maximum recording time limit for a bot. There is no default value for this parameter, meaning a bot will continue to record for as long as the meeting lasts.
    // in_call_recording_timeout?: number
    // The number of seconds after which the bot will automatically leave the call, if it has joined the call but has not started recording. For e.g This can occur due to bot being denied permission to record(Zoom meetings).
    // recording_permission_denied_timeout?: number
}

export interface RecognizerTranscript {
    speaker: string
    start_time: number
    lang?: string
    end_time?: number
    user_id?: number
}

export interface BotFailedRequest {
    webhook_url?: string // send it everytime
    message: string // mandatory
    error_code: string // mandatory
}

export interface BotSuccessRequest {
    webhook_url?: string // from request message
    speech_to_text?: SpeechToTextApiParameter // from request message
    transcription_custom_parameters?: any // from request message
    diarization_v2: boolean // false
    transcription_fail_count?: number // none
    diarization_fail_count?: number // none
    media_duration_sec: number
}

export interface MeetingProviderInterface {
    openMeetingPage(
        browserContext: BrowserContext,
        link: string,
        streaming_input: string | undefined,
    ): Promise<Page>
    joinMeeting(
        page: Page,
        cancelCheck: () => boolean,
        onJoinSuccess: () => void,
    ): Promise<void>
    findEndMeeting(page: Page): Promise<boolean>
    parseMeetingUrl(
        meeting_url: string,
    ): Promise<{ meetingId: string; password: string }>
    getMeetingLink(
        meeting_id: string,
        _password: string,
        _role: number,
        _bot_name: string,
        _enter_message?: string,
    ): string
    closeMeeting(page: Page): Promise<void>
}

export type MeetingParams = {
    bot_uuid: string
    secret: string
    meeting_url: string
    bots_api_key: string // api_key from InputParameters (used by core server for client webhooks)
    bot_name: string
    custom_branding_bot_path?: string
    speech_to_text_api_parameters?: SpeechToTextApiParameter
    bots_webhook_url?: string // webhook_url from InputParameters
    streaming_input?: string
    streaming_output?: string
    streaming_audio_frequency?: number
    enter_message?: string
    automatic_leave: AutomaticLeave
    recording_mode: RecordingMode
    zoom_sdk_id?: string // Custom zoom SDK keys feature
    zoom_sdk_pwd?: string // Custom zoom SDK keys feature
    transcription_custom_parameters?: any
    core_server_url?: string // Only for no-serverless mode. If null, serverless mode
}

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
export type MeetingProvider = 'Meet' | 'Teams' | 'Zoom'
