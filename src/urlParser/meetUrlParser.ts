import { GLOBAL } from '../singleton'
import { MeetingEndReason } from '../state-machine/types'

interface MeetUrlComponents {
    meetingId: string
    password: string // Empty string for Meet
}

export async function parseMeetingUrlFromJoinInfos(
    meeting_url: string,
): Promise<MeetUrlComponents> {
    let cleanUrl = meeting_url.trim()
    cleanUrl = cleanUrl.replace(/^"(.*)"$/, '$1')
    // Remove accidental shell escaping (backslashes before URL special chars)
    cleanUrl = cleanUrl.replace(/\\([?=&])/g, '$1')

    // Handle URLs starting with just "meet"
    if (cleanUrl.startsWith('meet.')) {
        cleanUrl = `https://${cleanUrl}`
    }

    const urlSplitted = cleanUrl.split(/\s+/)
    const meetCodeRegex =
        /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})((?:\?.*)?$)/

    try {
        const meetUrl = urlSplitted.find((s) => s.includes('meet.google.com'))
        if (!meetUrl) {
            GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
            throw new Error('No Google Meet URL found')
        }

        const match = meetUrl.match(meetCodeRegex)
        if (!match) {
            GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
            throw new Error('Invalid Google Meet URL format')
        }

        // Reconstruct the URL in standard format
        const [, meetCode, queryParams = ''] = match
        const standardUrl = `https://meet.google.com/${meetCode}${queryParams}`

        return {
            meetingId: standardUrl,
            password: '',
        }
    } catch (error) {
        GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
        throw error
    }
}
