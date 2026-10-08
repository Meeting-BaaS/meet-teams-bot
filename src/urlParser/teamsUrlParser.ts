import { GLOBAL } from '../singleton'
import { MeetingEndReason } from '../state-machine/types'
import { formatError } from '../utils/Logger'
import { parseTeamsMeetingUrl } from '../utils/teamsMeetingUrl'

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
        // TODO: decodeURIComponent after atob is unnecessary (searchParams.get already URL-decodes)
        // and could cause URIError if decoded JSON contains % characters. Left as-is for now since
        // this has been working in production for ~1 year.
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

        return `${url.origin}/v2/?meetingjoin=true#/l/meetup-join/${conversationId}/${messageId}?context=${encodeURIComponent(JSON.stringify(context))}&anon=true`
    } catch (e) {
        console.error(
            '🥕❌ Error converting light meeting URL:',
            formatError(e),
        )
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
        const joinUrl = url.hash.startsWith('#/l/meetup-join/')
            ? new URL(url.hash.slice(1), url.origin)
            : url
        const match = joinUrl.pathname.match(
            /^\/l\/meetup-join\/([^/]+)\/(\d+)$/,
        )
        const context = joinUrl.searchParams.get('context')

        if (!match || !context) {
            return originalLink
        }

        const [_, threadId, timestamp] = match
        joinUrl.searchParams.set('anon', 'true')

        // Build the working link format
        return `${url.origin}/v2/?meetingjoin=true#/l/meetup-join/${threadId}/${timestamp}?${joinUrl.searchParams.toString()}`
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

        const url = parseTeamsMeetingUrl(meeting_url)
        meeting_url = url.toString()

        // Handle teams.live.com URLs
        if (url.hostname === 'teams.live.com') {
            // Handle launcher/deep-link wrapper URLs
            // e.g. teams.live.com/dl/launcher/launcher.html?url=/_#/meet/123?p=abc&anon=true
            if (url.pathname.startsWith('/dl/launcher/')) {
                const embeddedPath = url.searchParams.get('url')
                if (embeddedPath) {
                    const meetMatch = embeddedPath.match(/\/meet\/(\d+)/)
                    const pMatch = embeddedPath.match(/[?&]p=([^&]+)/)
                    if (meetMatch) {
                        const directUrl = `https://teams.live.com/meet/${meetMatch[1]}${pMatch ? `?p=${pMatch[1]}&anon=true` : '?anon=true'}`
                        console.log(
                            `Detected Teams launcher URL, resolved to: ${directUrl}`,
                        )
                        return {
                            meetingId: directUrl,
                            password: pMatch ? pMatch[1] : '',
                        }
                    }
                }
                GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
                throw new Error(
                    'Invalid Teams launcher URL: could not extract meeting info',
                )
            }

            // Handle personal/free Teams light-meetings launcher URLs
            // e.g. teams.live.com/light-meetings/launch?coords=<base64>&p=abc&anon=true
            // The coords param is base64-encoded JSON with meetingCode + passcode
            if (url.pathname.includes('/light-meetings/launch')) {
                const coords = url.searchParams.get('coords')
                if (coords) {
                    try {
                        const decoded = JSON.parse(atob(coords))
                        if (decoded.meetingCode) {
                            const passcode =
                                decoded.passcode ||
                                url.searchParams.get('p') ||
                                ''
                            const directUrl = `https://teams.live.com/meet/${decoded.meetingCode}${passcode ? `?p=${passcode}&anon=true` : '?anon=true'}`
                            console.log(
                                `Detected Teams light-meetings launcher URL, resolved to: ${directUrl}`,
                            )
                            return {
                                meetingId: directUrl,
                                password: passcode,
                            }
                        }
                    } catch (e) {
                        console.error(
                            'Error parsing light-meetings coords:',
                            formatError(e),
                        )
                    }
                }
                GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
                throw new Error(
                    'Invalid Teams light-meetings URL: could not extract meeting info from coords',
                )
            }

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

        // The URL helper has validated the host and meeting shape.
        if (url.hostname !== 'teams.live.com') {
            console.log(
                `Detected Teams URL on ${url.hostname}, transforming to browser join format`,
            )
            // Transform the URL to the more compatible format
            const transformedUrl = transformTeamsLink(meeting_url)
            console.log('Using transformed Teams URL:', transformedUrl)
            return {
                meetingId: transformedUrl,
                password: url.searchParams.get('p') || '',
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
