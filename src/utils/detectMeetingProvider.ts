import { MeetingProvider } from '../types'
import { parseTeamsMeetingUrl } from './teamsMeetingUrl'

export function detectMeetingProvider(url: string): MeetingProvider {
    try {
        parseTeamsMeetingUrl(url)
        return 'Teams'
    } catch {
        // Not a supported Teams meeting; keep the existing Meet route.
    }
    if (url.includes('https://meet')) {
        return 'Meet'
    } else {
        throw new Error('Unsupported meeting provider')
    }
}
