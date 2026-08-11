import type { BrowserContext, Page } from "@playwright/test"
import type { BrandingHandle } from "../branding"
import type { SimpleDialogObserver } from "../services/dialog-observer/simple-dialog-observer"
import type { Streaming } from "../streaming"
import type { MeetingProviderInterface } from "../types"
import type { PathManager } from "../utils/PathManager"

export enum MeetingStateType {
  Initialization = "initialization",
  WaitingRoom = "waitingRoom",
  InCall = "inCall",
  Recording = "recording",
  Cleanup = "cleanup",
  Error = "error",
  Terminated = "terminated"
}

export enum MeetingEndReason {
  // Normal end reasons
  BotRemoved = "botRemoved",
  NoAttendees = "noAttendees",
  NoSpeaker = "noSpeaker",
  AllParticipantsLeft = "allParticipantsLeft",
  RecordingTimeout = "recordingTimeout",
  ApiRequest = "apiRequest",

  // Pre-recording stop (bot exited before recording started)
  ExitingMeetingBeforeRecord = "exitingMeetingBeforeRecord",

  // Error end reasons
  BotRemovedTooEarly = "botRemovedTooEarly",
  BotNotAccepted = "botNotAccepted",
  CannotJoinMeeting = "cannotJoinMeeting",
  TimeoutWaitingToStart = "timeoutWaitingToStart",
  InvalidMeetingUrl = "invalidMeetingUrl",
  StreamingSetupFailed = "streamingSetupFailed",
  LoginRequired = "loginRequired",
  // Authenticated Meet bot (SAML SSO) — failure modes the api-server distinguishes.
  // SamlRejected triggers workspace-level auto-disable; Timeout is treated as transient.
  MeetLoginFailedSamlRejected = "meetLoginFailedSamlRejected",
  MeetLoginFailedTimeout = "meetLoginFailedTimeout",
  // Zoom web-client (browser) specific failures. ZoomAnonymousJoinNotAllowed is
  // the post-Join anti-bot wall ("automated bots aren't allowed … must use Zoom
  // RTMS") — the host account rejects anonymous/automated browser joins. Retried
  // on a fresh exit IP (see main.ts); the durable fix is Zoom RTMS / the native
  // SDK. Maps to the api-server's ZOOM_ANONYMOUS_JOIN_NOT_ALLOWED error code.
  ZoomAnonymousJoinNotAllowed = "zoomAnonymousJoinNotAllowed",
  ZoomPasscodeRequired = "zoomPasscodeRequired",
  // The /wc/<id>/join URL server-side-redirected to zoom.us/webinar/register/… :
  // the webinar requires per-registrant registration (name+email → personal tk=
  // link), so an anonymous join can never succeed from any pod/IP. Terminal.
  ZoomWebinarRegistrationRequired = "zoomWebinarRegistrationRequired",
  // Authenticated Teams bot (username/password) — failure modes the api-server distinguishes.
  // Invalid/Captcha/Mfa flip the teams_login to invalid (per-account); Timeout is transient.
  TeamsLoginFailedInvalidCredentials = "teamsLoginFailedInvalidCredentials",
  TeamsLoginFailedCaptcha = "teamsLoginFailedCaptcha",
  TeamsLoginFailedMfaRequired = "teamsLoginFailedMfaRequired",
  TeamsLoginFailedTimeout = "teamsLoginFailedTimeout",
  // Residential proxy could not be established (e.g. Decodo pool at capacity
  // during a launch burst). Retryable: a requeued attempt lands later when the
  // pool has headroom, instead of joining direct from a datacenter IP.
  ProxyUnavailable = "proxyUnavailable",
  Internal = "internalError"
}

// Get human-readable error message from error code
export function getErrorMessageFromCode(errorCode: MeetingEndReason): string {
  switch (errorCode) {
    case MeetingEndReason.BotRemoved:
      return "Bot was removed from the meeting."
    case MeetingEndReason.NoAttendees:
      return "No attendees joined the meeting."
    case MeetingEndReason.NoSpeaker:
      return "No speakers detected during recording."
    case MeetingEndReason.AllParticipantsLeft:
      return "All participants left the meeting."
    case MeetingEndReason.RecordingTimeout:
      return "Recording timeout reached."
    case MeetingEndReason.ApiRequest:
      return "Recording stopped via API request."
    case MeetingEndReason.ExitingMeetingBeforeRecord:
      return "Bot exited before recording started."
    case MeetingEndReason.BotRemovedTooEarly:
      return "Bot was removed too early; the video is too short."
    case MeetingEndReason.BotNotAccepted:
      return "Bot was not accepted into the meeting."
    case MeetingEndReason.CannotJoinMeeting:
      return "Cannot join meeting - meeting is not reachable."
    case MeetingEndReason.TimeoutWaitingToStart:
      return "Timeout waiting to start recording."
    case MeetingEndReason.InvalidMeetingUrl:
      return "Invalid meeting URL provided."
    case MeetingEndReason.StreamingSetupFailed:
      return "Failed to set up streaming audio."
    case MeetingEndReason.ProxyUnavailable:
      return "Residential proxy unavailable (pool at capacity or unreachable)."
    case MeetingEndReason.LoginRequired:
      return "Login required to access the meeting."
    case MeetingEndReason.MeetLoginFailedSamlRejected:
      return "Google rejected our SAML assertion (cert mismatch most likely). Workspace auto-disabled."
    case MeetingEndReason.MeetLoginFailedTimeout:
      return "SAML round-trip with Google did not complete in time."
    case MeetingEndReason.ZoomAnonymousJoinNotAllowed:
      return "This Zoom meeting rejected the recording bot because it joined anonymously — the host's account blocks anonymous/automated browser joins. We recommend recording it via Zoom RTMS (or the native SDK with a user-authorized credential)."
    case MeetingEndReason.ZoomPasscodeRequired:
      return "Zoom meeting requires a passcode that was not supplied in the meeting URL (?pwd=)."
    case MeetingEndReason.ZoomWebinarRegistrationRequired:
      return "This Zoom webinar requires registration: Zoom redirected the join URL to its registration page, so the bot cannot join anonymously. Register the bot first and use the personalized join link (tk=) from the confirmation, or disable required registration for the webinar."
    case MeetingEndReason.TeamsLoginFailedInvalidCredentials:
      return "Microsoft rejected the account email/password. Update the teams_login credentials."
    case MeetingEndReason.TeamsLoginFailedCaptcha:
      return "Microsoft presented a captcha the bot could not solve during sign-in."
    case MeetingEndReason.TeamsLoginFailedMfaRequired:
      return "Microsoft requested MFA during sign-in; the bot account must be MFA-free."
    case MeetingEndReason.TeamsLoginFailedTimeout:
      return "Microsoft sign-in did not complete in time."
    case MeetingEndReason.Internal:
      return "Internal error occurred during recording."
    default:
      return "An error occurred during recording."
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

  // Pause/Resume — tracks which sections to trim in post-processing
  pauseWindows: Array<{ start: number; end: number | null }>
  currentPauseStart: number | null

  // Streaming
  streamingService?: Streaming

  // Speakers observation
  speakersObserver?: import("../meeting/speakersObserver").SpeakersObserver

  // Chat observation
  chatObserver?: import("../meeting/chatObserver").ChatObserver

  // HTML cleanup
  htmlCleaner?: import("../meeting/htmlCleaner").HtmlCleaner

  // Dialog observer
  dialogObserver?: SimpleDialogObserver

  // Proxy
  proxyUrl?: string
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
