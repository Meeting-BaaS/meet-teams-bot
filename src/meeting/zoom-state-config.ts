import { MeetingEndReason } from "../state-machine/types"
import type { StateDetectionConfig } from "../utils/meeting-state-detector"

/**
 * Zoom Web Client (browser) state-detection config (live-DOM-verified).
 *
 * Key subtlety: Zoom renders the waiting room INSIDE `.meeting-app` with live
 * mic-preview audio, so `.meeting-app`/audio presence alone false-positives as
 * "in meeting". The provider checks the waiting-room text FIRST, then in-meeting,
 * and the in-meeting selectors are all in-meeting-only (never pre-join/waiting).
 */
export const ZOOM_STATE_CONFIG: StateDetectionConfig = {
  providerName: "Zoom Web",
  denialPatterns: [
    {
      // Post-Join anti-bot wall. Keyed to the meeting/account (verified identical
      // from datacenter AND residential IPs), so retrying always re-hits it.
      texts: [
        "automated bots aren't allowed",
        "automated bots aren’t allowed", // curly-apostrophe variant Zoom renders
        "must use Zoom RTMS",
        "detected you may be a bot"
      ],
      reason: MeetingEndReason.ZoomAnonymousJoinNotAllowed,
      logPrefix: "XXXXXXXXXXXXXXXXXX Zoom anonymous-join wall (anonymous/automated join not allowed)",
      errorMessage:
        "Zoom rejected the anonymous recording bot for this meeting — recommend recording via Zoom RTMS / the native SDK"
    },
    {
      // Host-restricted entry: only authenticated Zoom users may join. The
      // #input-for-name field never renders, so fail fast as LoginRequired.
      texts: [
        "sign in to join this meeting",
        "only authenticated users can join",
        "this meeting requires authentication"
      ],
      reason: MeetingEndReason.LoginRequired,
      logPrefix: "Zoom requires an authenticated account to join",
      errorMessage: "Zoom meeting restricted to authenticated users"
    },
    {
      texts: [
        "This meeting has been ended by host",
        "host ended the meeting",
        "ended by the host",
        "removed from the meeting",
        "You have been removed",
        "meeting has ended",
        "Meeting has ended"
      ],
      reason: MeetingEndReason.BotRemoved,
      logPrefix: "XXXXXXXXXXXXXXXXXX Zoom removed the bot / meeting ended",
      errorMessage: "Bot removed or Zoom meeting ended"
    }
  ],
  waitingRoomPattern: {
    // The waiting room has no unique class — only text. Substring match survives
    // minor copy changes.
    selectors: [
      "text=Please wait, the meeting host will let you in soon",
      "text=Please wait",
      "text=Waiting for the host to start this meeting",
      "text=Waiting for the host to start the meeting",
      "text=waiting room",
      "text=Host has joined",
      "text=will let you in",
      "text=admitted shortly"
    ],
    threshold: 1,
    checkVisibility: false
  },
  inMeetingPattern: {
    // Any ONE confirms admission (waiting-room text is checked first, so these
    // can't false-positive there). Leave is the primary signal, but Zoom auto-hides
    // the footer that holds it — so we also accept a rendered in-meeting video tile
    // and the video/share layout, which never appear pre-join or in the waiting
    // room and don't auto-hide. checkVisibility keeps hidden pre-join DOM out.
    selectors: [
      'button[aria-label="Leave"]',
      ".single-main-container__video-frame",
      ".single-suspension-container__video-frame",
      "#video-share-layout video-player"
    ],
    threshold: 1,
    checkVisibility: true
  }
}
