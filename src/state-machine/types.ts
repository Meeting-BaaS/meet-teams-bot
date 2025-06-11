import { MeetingParams } from '../types'

import { BrowserContext, Page } from '@playwright/test'
import { BrandingHandle } from '../branding'
import { MeetingHandle } from '../meeting'
import { ScreenRecorder } from '../recording/ScreenRecorder'
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

export enum RecordingEndReason {
    ManualStop = 'manual_stop',
    BotRemoved = 'bot_removed',
    NoAttendees = 'no_attendees',
    NoSpeaker = 'no_speaker',
    RecordingTimeout = 'recording_timeout',
    ApiRequest = 'api_request',
}

export interface MeetingContext {
    // Références aux objets principaux
    meetingHandle: MeetingHandle
    params: MeetingParams
    provider: MeetingProviderInterface

    // Pages et contexte du navigateur
    playwrightPage?: Page
    backgroundPage?: Page
    browserContext?: BrowserContext

    // Timers et intervalles
    meetingTimeoutInterval?: NodeJS.Timeout
    startTime?: number
    lastSpeakerTime?: number
    noSpeakerDetectedTime?: number

    // État de la réunion
    attendeesCount?: number
    firstUserJoined?: boolean

    // Processus et ressources
    brandingProcess?: BrandingHandle
    mediaRecorderActive?: boolean

    // Gestion des erreurs et statut
    error?: Error
    endReason?: RecordingEndReason
    retryCount?: number

    // Identifiants et tokens
    extensionId?: string
    meetingId?: string
    meetingPassword?: string

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

    // Screen recording
    screenRecorder?: ScreenRecorder

    errorTime?: number
    hasResumed?: boolean
    speakers?: string[]
    dialogObserverInterval?: NodeJS.Timeout
    dialogObserverHeartbeat?: NodeJS.Timeout
    lastActivityTime?: number
    lastFrameTime?: number

    // Méthodes pour la gestion globale des observateurs
    startGlobalDialogObserver?: () => void
    stopGlobalDialogObserver?: () => void

    meetingUrl?: string
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
