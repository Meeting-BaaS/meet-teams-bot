import { parseMeetingUrlFromJoinInfos } from './teamsUrlParser'
import { detectMeetingProvider } from '../utils/detectMeetingProvider'

jest.mock('../singleton', () => ({ GLOBAL: { setError: jest.fn() } }))

describe('Teams URL compatibility', () => {
    test.each([
        'teams.microsoft.com',
        'teams.cloud.microsoft',
        'teams.live.com',
    ])('accepts short meeting URLs on %s and retains passcodes', (host) => {
        const url = `https://${host}/meet/123456789?p=a%2Bb%26c`
        expect(detectMeetingProvider(url)).toBe('Teams')
        expect(parseMeetingUrlFromJoinInfos(url)).toEqual({
            meetingId: url,
            password: 'a+b&c',
        })
    })

    test.each(['teams.microsoft.com', 'teams.cloud.microsoft'])(
        'rewrites deep links onto their own origin: %s',
        (host) => {
            const original = `https://${host}/l/meetup-join/19%3ameeting_123%40thread.v2/0?p=a%2Bb&context=%7B%22Tid%22%3A%22tenant%22%7D`
            for (const input of [original, original.replace('/l/', '/_#/l/')]) {
                expect(detectMeetingProvider(input)).toBe('Teams')
                const result = new URL(
                    parseMeetingUrlFromJoinInfos(input).meetingId,
                )
                expect(result.origin).toBe(`https://${host}`)
                expect(result.pathname).toBe('/v2/')
                const join = new URL(result.hash.slice(1), result.origin)
                expect(join.searchParams.get('context')).toBe(
                    '{"Tid":"tenant"}',
                )
                expect(join.searchParams.get('p')).toBe('a+b')
                expect(join.searchParams.get('anon')).toBe('true')
                expect(
                    parseMeetingUrlFromJoinInfos(result.toString()).meetingId,
                ).toBe(result.toString())
            }
        },
    )

    test('preserves cloud origin for light meetings', () => {
        const coords = Buffer.from(
            JSON.stringify({
                conversationId: '19:meeting_123@thread.v2',
                tenantId: 'tenant',
                messageId: '0',
            }),
        ).toString('base64')
        const result = parseMeetingUrlFromJoinInfos(
            `https://teams.cloud.microsoft/light-meetings/launch?coords=${encodeURIComponent(coords)}`,
        )
        expect(result.meetingId).toMatch(
            /^https:\/\/teams\.cloud\.microsoft\/v2\//,
        )
    })

    test('keeps personal launcher support', () => {
        const input = `https://teams.live.com/dl/launcher/launcher.html?url=${encodeURIComponent('/_#/meet/123?p=abc')}`
        expect(detectMeetingProvider(input)).toBe('Teams')
        expect(parseMeetingUrlFromJoinInfos(input)).toEqual({
            meetingId: 'https://teams.live.com/meet/123?p=abc&anon=true',
            password: 'abc',
        })
    })

    test('preserves accidental shell escaping support', () => {
        const input = 'https://teams.cloud.microsoft/meet/123\\?p\\=abc'
        expect(detectMeetingProvider(input)).toBe('Teams')
        expect(parseMeetingUrlFromJoinInfos(input).meetingId).toBe(
            'https://teams.cloud.microsoft/meet/123?p=abc',
        )
    })

    test.each([
        'https://teams.microsoft.com.evil.example/meet/123',
        'https://evilteams.live.com/meet/123',
        'https://teams.zoom.us/meet/123',
        'https://evil.example/l/meetup-join/123/0',
        'https://teams.cloud.microsoft@evil.example/meet/123',
        'https://user:password@teams.cloud.microsoft/meet/123',
        'http://teams.cloud.microsoft/meet/123',
        'https://teams.cloud.microsoft:444/meet/123',
        'https://teams.cloud.microsoft/l/channel/123',
        'https://teams.cloud.microsoft/l/chat/123',
        'https://teams.cloud.microsoft/v2/#/l/chat/123',
        'https://teams.cloud.microsoft/',
    ])('rejects non-meeting or untrusted URLs: %s', (url) => {
        expect(() => detectMeetingProvider(url)).toThrow(
            'Unsupported meeting provider',
        )
        expect(() => parseMeetingUrlFromJoinInfos(url)).toThrow(
            'Invalid Teams URL',
        )
    })
})
