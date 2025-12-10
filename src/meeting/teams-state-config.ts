import { MeetingEndReason } from '../state-machine/types'
import { StateDetectionConfig } from '../utils/meeting-state-detector'

/**
 * Microsoft Teams State Detection Configuration
 */
export const TEAMS_STATE_CONFIG: StateDetectionConfig = {
    providerName: 'Microsoft Teams',
    denialPatterns: [
        {
            texts: [
                'Sorry, but you were denied access to the meeting.'
            ],
            reason: MeetingEndReason.BotNotAccepted,
            logPrefix: 'XXXXXXXXXXXXXXXXXX Teams has denied entry',
            errorMessage: 'Teams has denied entry',
        },
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
            'button[id*="hangup"]',
        ],
        threshold: 3,
        checkVisibility: false,
    },
}
