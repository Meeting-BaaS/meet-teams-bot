import { MeetingEndReason } from "../state-machine/types"
import type { StateDetectionConfig } from "../utils/meeting-state-detector"

/**
 * Zoom Web Client (browser) state-detection configuration.
 *
 * Selectors/text ported from vexa `join/zoom/selectors.ts` (live-DOM-verified).
 * Consumed by createStateDetector() the same way MEET_STATE_CONFIG /
 * TEAMS_STATE_CONFIG are.
 *
 * Two hard subtleties baked into the ZoomProvider, not this config:
 *  1. The anti-bot wall ("automated bots aren't allowed … must use Zoom RTMS")
 *     maps to a NON-RETRYABLE ZoomRequiresRtms — see denialPatterns below.
 *  2. Zoom renders the waiting room INSIDE `.meeting-app`, and mic-preview audio
 *     stays live across pre-join → waiting-room, so `.meeting-app`/audio presence
 *     alone false-positives as "in meeting". The in-meeting signal here is
 *     therefore the Leave button ONLY (footer-only, never renders pre-join or in
 *     the waiting room); the provider runs the waiting-room text check first.
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
      reason: MeetingEndReason.ZoomRequiresRtms,
      logPrefix: "XXXXXXXXXXXXXXXXXX Zoom anti-bot wall (RTMS required)",
      errorMessage:
        "Zoom blocks automated browser joins for this meeting and requires RTMS"
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
    // Zoom waiting room has no unique CSS class — only text strings. Substring
    // match (unquoted text=) survives minor copy changes.
    selectors: [
      "text=Please wait, the meeting host will let you in soon",
      "text=Please wait",
      "text=Waiting for the host to start this meeting",
      "text=Waiting for the host to start the meeting",
      "text=waiting room",
      "text=Host has joined"
    ],
    threshold: 1,
    checkVisibility: false
  },
  inMeetingPattern: {
    // Leave button ONLY. This footer control never renders pre-join or in the
    // waiting room, so a single reliable indicator beats a threshold of weaker
    // ones (which false-positive inside `.meeting-app`). checkVisibility=true so
    // a hidden-but-present Leave button in the pre-join DOM can't match.
    selectors: ['button[aria-label="Leave"]'],
    threshold: 1,
    checkVisibility: true
  }
}
