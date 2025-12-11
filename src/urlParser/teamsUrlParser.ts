import { GLOBAL } from '../singleton'
import { MeetingEndReason } from '../state-machine/types'
import { formatError } from '../utils/Logger'

interface TeamsUrlComponents {
    meetingId: string
    password: string
}

function convertLightMeetingToStandard(url: URL): string {
    const coords = url.searchParams.get('coords')
    if (!coords) {
        GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
        throw new Error('Missing coordinates in Teams URL')
    }

    try {
        const decodedCoords = JSON.parse(decodeURIComponent(atob(coords)))
        const { conversationId, tenantId, messageId, organizerId } =
            decodedCoords
        if (!conversationId || !tenantId || !messageId) {
            GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
            throw new Error('Invalid Teams URL structure')
        }

        // Build the working link format directly instead of standard format
        const context = {
            Tid: tenantId,
            ...(organizerId ? { Oid: organizerId } : {}),
        }

        return `https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/${conversationId}/${messageId}?context=${encodeURIComponent(JSON.stringify(context))}&anon=true`
    } catch (e) {
        console.error('🥕❌ Error converting light meeting URL:', formatError(e))
        GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
        throw new Error('Failed to convert Teams light meeting URL')
    }
}

function transformTeamsLink(originalLink: string): string {
    try {
        // Check if it's already in the working format
        if (originalLink.includes('/v2/?meetingjoin=true')) {
            return originalLink
        }

        const url = new URL(originalLink)

        // Handle light-meetings format
        if (url.pathname.includes('/light-meetings/launch')) {
            console.log(
                '🥕➡️ Detected light-meetings URL, converting to working format',
            )
            return convertLightMeetingToStandard(url)
        }

        // Extract the important parts from the original URL
        const regex =
            /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/(.*?)\/(\d+)\?context=(.*?)(?:$|&)/
        const match = originalLink.match(regex)

        if (!match || match.length < 4) {
            return originalLink
        }

        const [_, threadId, timestamp, context] = match

        // Build the working link format
        return `https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/${threadId}/${timestamp}?context=${context}&anon=true`
    } catch (error) {
        console.error('Error transforming Teams link:', formatError(error))
        return originalLink
    }
}

export function parseMeetingUrlFromJoinInfos(
    meeting_url: string,
): TeamsUrlComponents {
    try {
        if (!meeting_url) {
            GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
            throw new Error('No meeting URL provided')
        }

        console.log('Parsing meeting URL:', meeting_url)

        // Remove accidental shell escaping (backslashes before URL special chars)
        meeting_url = meeting_url.replace(/\\([?=&])/g, '$1')

        // Handle Google redirect URLs
        if (meeting_url.startsWith('https://www.google.com/url')) {
            const url = new URL(meeting_url)
            meeting_url = url.searchParams.get('q') || meeting_url
        }

        // Decode URL if needed
        if (meeting_url.startsWith('https%3A')) {
            meeting_url = decodeURIComponent(meeting_url)
        }

        const url = new URL(meeting_url)

        // Handle teams.live.com URLs
        if (url.hostname.includes('teams.live.com')) {
            const meetPath = url.pathname.split('/meet/')[1]
            if (!meetPath) {
                GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
                throw new Error('Invalid Teams live URL format')
            }
            return {
                meetingId: meeting_url,
                password: url.searchParams.get('p') || '',
            }
        }

        // Handle teams.microsoft.com URLs
        if (url.hostname.includes('teams.microsoft.com')) {
            console.log(
                `🥕🥕🥕 Detected teams.microsoft.com URL ${meeting_url}\n, transforming to more compatible format 🥕🥕🥕`,
            )
            // Transform the URL to the more compatible format
            const transformedUrl = transformTeamsLink(meeting_url)
            console.log('Using transformed Teams URL:', transformedUrl)
            return {
                meetingId: transformedUrl,
                password: '',
            }
        }

        GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
        throw new Error('Invalid Teams URL')
    } catch (error) {
        GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
        throw error
    }
}

// // Export for testing
// export const __testing = {
//     convertLightMeetingToStandard,
//     convertStandardToLightMeeting
// }
