const TEAMS_HOSTS = new Set([
    'teams.microsoft.com',
    'teams.live.com',
    'teams.cloud.microsoft',
])

/** Keep provider detection and the Teams join parser on the same URL contract. */
export function isTeamsMeetingUrl(url: URL): boolean {
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        ![...TEAMS_HOSTS].some(
            (host) =>
                url.hostname === host || url.hostname.endsWith(`.${host}`),
        )
    ) {
        return false
    }

    const path = url.pathname.toLowerCase()
    const fragment = url.hash.slice(1).toLowerCase()
    const meetingPath = /^\/l\/(?:meetup-join|meeting)\//
    if (
        /^\/l\/(?:channel|team|chat|message|entity|app|file|task)(?:\/|$)/.test(
            path,
        )
    ) {
        return false
    }
    return (
        meetingPath.test(path) ||
        /^\/meet\/[^/]+/.test(path) ||
        path.startsWith('/dl/launcher/') ||
        path === '/light-meetings/launch' ||
        ((path === '/_' || path === '/v2/' || path === '/v2') &&
            (meetingPath.test(fragment) || /^\/meet\/[^/]+/.test(fragment)))
    )
}

export function parseTeamsMeetingUrl(input: string): URL {
    let value = input.trim().replace(/\\([?=&])/g, '$1')
    if (/^https%3a/i.test(value)) {
        value = decodeURIComponent(value)
    }
    // Existing Google redirect support; outer routing must also resolve wrappers.
    let url = new URL(value)
    if (url.origin === 'https://www.google.com' && url.pathname === '/url') {
        url = new URL(url.searchParams.get('q') || value)
    }
    if (!isTeamsMeetingUrl(url)) {
        throw new Error('Invalid Teams URL')
    }
    return url
}
