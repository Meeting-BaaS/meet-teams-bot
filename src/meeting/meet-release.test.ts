import { MeetProvider } from './meet'
import { GLOBAL } from '../singleton'
import type { Page } from '@playwright/test'

jest.mock('../recording/ScreenRecorder', () => ({ ScreenRecorderManager: {} }))
jest.mock('../services/html-snapshot-service', () => ({
    HtmlSnapshotService: {},
}))
jest.mock('../singleton', () => ({
    GLOBAL: { get: jest.fn(), getParticipantNames: jest.fn() },
}))

describe('Meet meeting-end signals', () => {
    let provider: MeetProvider
    let content: string
    let page: Page

    beforeEach(() => {
        jest.useFakeTimers().setSystemTime(1_000_000)
        provider = new MeetProvider()
        content = ''
        page = {
            evaluate: jest.fn().mockResolvedValue('complete'),
            isClosed: () => false,
            url: () => 'https://meet.google.com/abc-defg-hij',
            content: async () => content,
        } as unknown as Page
        ;(GLOBAL.get as jest.Mock).mockReturnValue({ automatic_leave: {} })
        ;(GLOBAL.getParticipantNames as jest.Mock).mockReturnValue(['Guest'])
    })

    afterEach(() => {
        jest.clearAllTimers()
        jest.useRealTimers()
    })

    it('allows a transient reconnect to recover and resets the timer', async () => {
        content =
            'You lost your network connection. Trying to reconnect. Return to home'
        expect(await provider.findEndMeeting(page)).toBe(false)
        jest.setSystemTime(1_039_999)
        expect(await provider.findEndMeeting(page)).toBe(false)
        content = 'Meeting restored'
        expect(await provider.findEndMeeting(page)).toBe(false)
        content = 'Trying to reconnect. Return to home'
        jest.setSystemTime(1_050_000)
        expect(await provider.findEndMeeting(page)).toBe(false)
        jest.setSystemTime(1_090_000)
        expect(await provider.findEndMeeting(page)).toBe(true)
    })

    it('ends promptly on removal without a reconnect overlay', async () => {
        content = "You've been removed. Return to home"
        expect(await provider.findEndMeeting(page)).toBe(true)
    })

    it('holds the alone banner for the default 30 seconds', async () => {
        content = 'No one else is here'
        expect(await provider.findEndMeeting(page)).toBe(false)
        jest.setSystemTime(1_029_999)
        expect(await provider.findEndMeeting(page)).toBe(false)
        jest.setSystemTime(1_030_000)
        expect(await provider.findEndMeeting(page)).toBe(true)
    })

    it('leaves the initial empty-room timeout to RecordingState', async () => {
        ;(GLOBAL.getParticipantNames as jest.Mock).mockReturnValue([])
        ;(GLOBAL.get as jest.Mock).mockReturnValue({
            automatic_leave: {
                noone_joined_timeout: 600,
                everyone_left_timeout: 30,
            },
        })
        content = 'No one else is here'
        expect(await provider.findEndMeeting(page)).toBe(false)
        jest.setSystemTime(1_599_000)
        expect(await provider.findEndMeeting(page)).toBe(false)
    })

    it('resets the alone countdown when another participant returns', async () => {
        ;(GLOBAL.get as jest.Mock).mockReturnValue({
            automatic_leave: { everyone_left_timeout: 60 },
        })
        content = 'No one else is here'
        expect(await provider.findEndMeeting(page)).toBe(false)
        jest.setSystemTime(1_040_000)
        expect(await provider.findEndMeeting(page)).toBe(false)
        content = 'Someone returned'
        expect(await provider.findEndMeeting(page)).toBe(false)
        content = 'No one else is here'
        expect(await provider.findEndMeeting(page)).toBe(false)
        jest.setSystemTime(1_100_000)
        expect(await provider.findEndMeeting(page)).toBe(true)
    })
})
