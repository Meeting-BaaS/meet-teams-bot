import type { MeetingParams } from './types'

describe('on-prem recording modes', () => {
    it.each([
        ['Meet', 'GalleryView', 'gallery_view'],
        ['Meet', 'gallery_view', 'gallery_view'],
        ['Teams', 'gallery_view', 'speaker_view'],
        ['Meet', 'AudioOnly', 'audio_only'],
    ])(
        'normalizes %s %s to %s',
        (meetingProvider, recording_mode, expected) => {
            jest.isolateModules(() => {
                const { GLOBAL } = require('./singleton')
                GLOBAL.set({
                    meeting_url: 'https://meet.google.com/abc-defg-hij',
                    bot_uuid: 'test-bot',
                    meetingProvider,
                    recording_mode,
                } as MeetingParams)
                expect(GLOBAL.get().recording_mode).toBe(expected)
            })
        },
    )
})
