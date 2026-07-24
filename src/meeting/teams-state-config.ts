import { MeetingEndReason } from "../state-machine/types"
import type { StateDetectionConfig } from "../utils/meeting-state-detector"

/**
 * Microsoft Teams State Detection Configuration
 */
export const TEAMS_STATE_CONFIG: StateDetectionConfig = {
  providerName: "Microsoft Teams",
  denialPatterns: [
    {
      texts: ["Sorry, but you were denied access to the meeting."],
      reason: MeetingEndReason.BotNotAccepted,
      logPrefix: "XXXXXXXXXXXXXXXXXX Teams has denied entry",
      errorMessage: "Teams has denied entry"
    },
    {
      // In-page anonymous-join verification modal. Teams renders this over the
      // pre-join screen instead of redirecting to login.microsoft.com, so the
      // URL-based isOnMicrosoftLoginPage check never trips and the bot would
      // otherwise sit at pre-join until the 600s waiting-room timer fires.
      texts: ["We need to verify your info before you can join"],
      reason: MeetingEndReason.LoginRequired,
      logPrefix: "XXXXXXXXXXXXXXXXXX Teams requires sign-in to join",
      errorMessage: "Teams requires participants to be authenticated before joining"
    }
  ],
  // Teams doesn't have a distinct waiting room pattern detection
  // It's handled through the denial patterns above
  waitingRoomPattern: undefined,
  inMeetingPattern: {
    selectors: [
      // React button is a good indicator
      'button:has-text("React")',
      // Raise hand button
      'button#raisehands-button:has-text("Raise")',
      // Chat button
      'button[aria-label*="chat"]',
      'button[title*="chat"]',
      // Participant indicators
      '[data-tid="roster-button"]',
      'button[id*="hangup"]'
    ],
    threshold: 3,
    checkVisibility: false
  },
  // Launcher screen: teams(.microsoft.com|.cloud.microsoft)/dl/launcher/... offers to
  // open the desktop app; the bot stays on the web by clicking one of these. Several
  // label/markup variants across tenants and the old/new domains, so match any.
  continueOnBrowserPattern: {
    selectors: [
      'button:has-text("Continue on this browser")',
      'a:has-text("Continue on this browser")',
      '[data-tid="joinOnWeb"]',
      'button:has-text("Join on the web instead")',
      'a:has-text("Join on the web instead")',
      'button:has-text("Watch on the web instead")',
      'button:has-text("Use the web app instead")'
    ],
    threshold: 2,
    checkVisibility: true
  },
  // Pre-join screen: where the (signed-in or guest) participant commits to joining.
  // "Join now" is the common label; the data-tid / id are stable fallbacks if the
  // visible text is localized or changes.
  preJoinPattern: {
    selectors: [
      'button:has-text("Join now")',
      'button[data-tid="prejoin-join-button"]',
      "#prejoin-join-button",
      'button[aria-label*="Join now" i]',
      'button[title*="Join now" i]',
      'button:has-text("Join")'
    ],
    threshold: 2,
    checkVisibility: true
  }
}
