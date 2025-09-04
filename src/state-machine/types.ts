import { BrowserContext, Page } from '@playwright/test'
import { BrandingHandle } from '../branding'
import { SimpleDialogObserver } from '../services/dialog-observer/simple-dialog-observer'
import { Streaming } from '../streaming'
import { MeetingProviderInterface } from '../types'
import { PathManager } from '../utils/PathManager'

export enum MeetingStateType {
    Initialization = 'initialization',
    WaitingRoom = 'waitingRoom',
    InCall = 'inCall',
    Recording = 'recording',
    Paused = 'paused',
    Resuming = 'resuming',
    Cleanup = 'cleanup',
    Error = 'error',
    Terminated = 'terminated',
}

export enum MeetingEndReason {
    // Normal end reasons
    BotRemoved = 'botRemoved',
    NoAttendees = 'noAttendees',
    NoSpeaker = 'noSpeaker',
    RecordingTimeout = 'recordingTimeout',
    ApiRequest = 'apiRequest',

    // Error end reasons
    BotRemovedTooEarly = 'botRemovedTooEarly',
    BotNotAccepted = 'botNotAccepted',
    CannotJoinMeeting = 'cannotJoinMeeting',
    TimeoutWaitingToStart = 'timeoutWaitingToStart',
    InvalidMeetingUrl = 'invalidMeetingUrl',
    StreamingSetupFailed = 'streamingSetupFailed',
    LoginRequired = 'loginRequired',
    Internal = 'internalError',
}

// Get human-readable error message from error code
export function getErrorMessageFromCode(errorCode: MeetingEndReason): string {
    switch (errorCode) {
        case MeetingEndReason.BotRemoved:
            return 'Bot was removed from the meeting.'
        case MeetingEndReason.NoAttendees:
            return 'No attendees joined the meeting.'
        case MeetingEndReason.NoSpeaker:
            return 'No speakers detected during recording.'
        case MeetingEndReason.RecordingTimeout:
            return 'Recording timeout reached.'
        case MeetingEndReason.ApiRequest:
            return 'Recording stopped via API request.'
        case MeetingEndReason.BotRemovedTooEarly:
            return 'Bot was removed too early; the video is too short.'
        case MeetingEndReason.BotNotAccepted:
            return 'Bot was not accepted into the meeting.'
        case MeetingEndReason.CannotJoinMeeting:
            return 'Cannot join meeting - meeting is not reachable.'
        case MeetingEndReason.TimeoutWaitingToStart:
            return 'Timeout waiting to start recording.'
        case MeetingEndReason.InvalidMeetingUrl:
            return 'Invalid meeting URL provided.'
        case MeetingEndReason.StreamingSetupFailed:
            return 'Failed to set up streaming audio.'
        case MeetingEndReason.LoginRequired:
            return 'Login required to access the meeting.'
        case MeetingEndReason.Internal:
            return 'Internal error occurred during recording.'
        default:
            return 'An error occurred during recording.'
    }
}

export interface MeetingContext {
    // Main object references
    provider: MeetingProviderInterface

    // Pages et contexte du navigateur
    playwrightPage?: Page
    browserContext?: BrowserContext

    // Timers et intervalles
    startTime?: number
    lastSpeakerTime?: number
    noSpeakerDetectedTime?: number

    // État de la réunion
    attendeesCount?: number
    firstUserJoined?: boolean

    // Processus et ressources
    brandingProcess?: BrandingHandle

    // PathManager
    pathManager?: PathManager

    // Recording state (Play/Pause)
    isPaused?: boolean
    pauseStartTime?: number
    totalPauseDuration?: number
    lastRecordingState?: {
        timestamp?: number
        attendeesCount?: number
        lastSpeakerTime?: number
        noSpeakerDetectedTime?: number
    }

    // Streaming
    streamingService?: Streaming

    // Speakers observation
    speakersObserver?: import('../meeting/speakersObserver').SpeakersObserver

    // HTML cleanup
    htmlCleaner?: import('../meeting/htmlCleaner').HtmlCleaner

    // Dialog observer
    dialogObserver?: SimpleDialogObserver
}

export interface StateTransition {
    nextState: MeetingStateType
    context: MeetingContext
}

export interface ParticipantState {
    attendeesCount: number
    firstUserJoined: boolean
    lastSpeakerTime?: number | null
    noSpeakerDetectedTime?: number | null
}

export type StateExecuteResult = Promise<StateTransition>
