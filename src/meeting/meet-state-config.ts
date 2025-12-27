import { MeetingEndReason } from '../state-machine/types'
import { StateDetectionConfig } from '../utils/meeting-state-detector'

/**
 * Google Meet State Detection Configuration
 */
export const MEET_STATE_CONFIG: StateDetectionConfig = {
    providerName: 'Google Meet',
    denialPatterns: [
        {
            texts: ["You can't join this video call"],
            reason: MeetingEndReason.BotNotAccepted,
            logPrefix: 'XXXXXXXXXXXXXXXXXX Google Meet itself has denied entry',
            errorMessage: 'Google Meet has denied entry',
        },
        {
            texts: ['No one responded to your request to join the call'],
            reason: MeetingEndReason.TimeoutWaitingToStart,
            logPrefix: 'Google Meet itself has timed out',
            errorMessage:
                'Google Meet has timed out while waiting for the bot to join the meeting',
        },
        {
            texts: [
                'denied',
                "You've been removed",
                'we encountered a problem joining',
                "You can't join",
                'You left the meeting',
                'Your sign-in credentials might have changed',
            ],
            reason: MeetingEndReason.BotNotAccepted,
            logPrefix: 'XXXXXXXXXXXXXXXXXX User has denied entry',
            errorMessage: 'User has denied entry',
        },
    ],
    waitingRoomPattern: {
        selectors: [
            'text="Asking to join"',
            'text="Your request to join"',
            'text="Waiting for the host"',
            'text="waiting to be let in"',
            'text="Instead of waiting to be let in"',
            'text="Please wait until a meeting host brings you into the call"',
            '[aria-label*="waiting"]',
            '[aria-label*="Please wait until"]',
            '[aria-label*="brings you into"]',
        ],
        threshold: 1,
        checkVisibility: false,
    },
    inMeetingPattern: {
        selectors: [
            'div[role="region"][aria-label="Call controls"]',
            'nav button[aria-label="People"][role="button"]',
            'nav button[aria-label="Show everyone"][role="button"]',
            'nav button[data-panel-id="1"][role="button"]',
            'button[aria-label="Chat with everyone"]',
            '[data-participant-id]',
            '[data-self-name]',
            'div[data-participant-id]',
        ],
        threshold: 4, // Increased from 3 to 4 to require chat button (prevents false positives in waiting room)
        checkVisibility: true, // Check DOM presence only, not visibility - helps with fast admissions
    },
}
