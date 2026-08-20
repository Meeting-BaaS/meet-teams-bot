import { MeetingEndReason } from "../state-machine/types"
import type { StateDetectionConfig } from "../utils/meeting-state-detector"
import { CHAT_IGNORE_SELECTORS } from "./zoom/chat-selectors"

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
        "You have been removed",
        "meeting has ended",
        "Meeting has ended"
      ],
      reason: MeetingEndReason.BotRemoved,
      logPrefix: "XXXXXXXXXXXXXXXXXX Zoom removed the bot / meeting ended",
      errorMessage: "Bot removed or Zoom meeting ended",
      // POSITIVE scoping: these phrases must ONLY count inside genuine Zoom
      // end-of-meeting UI (modal / full-page end screen). They are never scanned
      // on the general page, so chat content — including the bot's own entry
      // message — can never trip BotRemoved again, even in a chat container the
      // ignore-list does not (yet) know about. Deliberately narrow: the generic
      // [class*="modal"] was rejected in review because it also matches
      // settings/feedback modals, which must never be treated as end-of-meeting
      // UI.
      //
      // Accepted residual risk (deliberate, false-negative-averse): `.zm-modal`
      // is Zoom's generic modal class, so a hypothetical non-removal dialog
      // rendering one of these phrases would still match. Tightening further
      // (e.g. requiring a `modal-body-title` descendant) risks MISSING genuine
      // removals when Zoom's markup shifts — a bot lingering in a dead meeting
      // is worse than a rare early exit. Keep this broad enough to always catch
      // the real removal modal.
      scopeSelectors: [
        ".zm-modal",
        '[class*="meeting-ended"]',
        '[class*="ended-meeting"]',
        '[class*="end-screen"]',
        '[class*="leave-page"]'
      ]
    }
  ],
  // Never treat chat content as a meeting-end signal. The bot's own entry chat
  // message contains "…the bot can be removed from the meeting upon simple
  // request.", which tripped the BotRemoved denial pattern ~200ms after the
  // message was sent — the bot killed itself 1-2s after joining. Any participant
  // typing "removed from the meeting"/"meeting has ended" into chat (message or
  // the compose box) would do the same. Genuine removal/meeting-ended UI is a
  // Zoom modal / full-page overlay, never inside a chat subtree. The list is
  // shared with ZoomChatObserver (single source of truth) so it can't drift.
  denialIgnoreWithinSelectors: [...CHAT_IGNORE_SELECTORS],
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
