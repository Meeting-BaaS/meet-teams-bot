import { JoinError, JoinErrorCode } from '../types'

interface MeetUrlComponents {
    meetingId: string
    password: string // Empty string for Meet
}

export async function parseMeetingUrlFromJoinInfos(
    meeting_url: string,
): Promise<MeetUrlComponents> {
    let cleanUrl = meeting_url.trim()
    cleanUrl = cleanUrl.replace(/^"(.*)"$/, '$1')

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
            throw new JoinError(JoinErrorCode.InvalidMeetingUrl)
        }

        const match = meetUrl.match(meetCodeRegex)
        if (!match) {
            throw new JoinError(JoinErrorCode.InvalidMeetingUrl)
        }

        // Reconstruct the URL in standard format
        const [, meetCode, queryParams = ''] = match
        const standardUrl = `https://meet.google.com/${meetCode}${queryParams}`

        return {
            meetingId: standardUrl,
            password: '',
        }
    } catch (error) {
        throw new JoinError(JoinErrorCode.InvalidMeetingUrl)
    }
}
