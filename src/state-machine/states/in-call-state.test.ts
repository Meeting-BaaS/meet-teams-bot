import { InCallState } from './in-call-state'
import { ResumingState } from './resuming-state'
import { MeetingContext, MeetingStateType } from '../types'
import { GLOBAL } from '../../singleton'
import { SpeakersObserver } from '../../meeting/speakersObserver'
import { SpeakerManager } from '../../speaker-manager'

jest.mock('../../browser/page-logger', () => ({ listenPage: jest.fn() }))
jest.mock('../../events', () => ({ Events: {} }))
jest.mock('../../meeting/htmlCleaner', () => ({ HtmlCleaner: jest.fn() }))
jest.mock('../../meeting/meet', () => ({ sendEntryMessage: jest.fn() }))
jest.mock('../../meeting/meet/audio-capture', () => ({
    verifyMeetAudioCapture: jest.fn(),
}))
jest.mock('../../recording/ScreenRecorder', () => ({
    ScreenRecorderManager: {},
}))
jest.mock('../../singleton', () => ({
    GLOBAL: { get: jest.fn(), getEndReason: jest.fn() },
}))
jest.mock('../../meeting/speakersObserver', () => ({
    SpeakersObserver: jest.fn(),
}))
jest.mock('../../speaker-manager', () => ({
    SpeakerManager: { start: jest.fn(), getInstance: jest.fn() },
}))
jest.mock('../../meeting/teams/network-interception', () => ({
    resumeTeamsNetworkInterception: jest.fn(),
    pauseTeamsNetworkInterception: jest.fn(),
}))

describe('in-call UI speaker bridge', () => {
    let context: MeetingContext
    let state: InCallState
    let startObserving: jest.Mock
    let manager: {
        handleUiBridgeUpdate: jest.Mock
        handleSpeakerUpdate: jest.Mock
    }

    beforeEach(() => {
        jest.clearAllMocks()
        context = { playwrightPage: {} } as MeetingContext
        state = new InCallState(context, MeetingStateType.InCall)
        manager = {
            handleUiBridgeUpdate: jest.fn(),
            handleSpeakerUpdate: jest.fn(),
        }
        ;(SpeakerManager.getInstance as jest.Mock).mockReturnValue(manager)
        ;(GLOBAL.get as jest.Mock).mockReturnValue({
            meetingProvider: 'Teams',
            recording_mode: 'speaker_view',
            bot_name: 'Recorder',
        })
        startObserving = jest.fn().mockResolvedValue(undefined)
        ;(SpeakersObserver as jest.Mock).mockImplementation(() => ({
            startObserving,
            isCurrentlyObserving: () => true,
        }))
    })

    it('shares pending startup and stores only one observer', async () => {
        let finish!: () => void
        startObserving.mockReturnValue(
            new Promise<void>((resolve) => {
                finish = resolve
            }),
        )
        const first = (state as any).startUIBasedObservation()
        let secondFinished = false
        const second = (state as any).startUIBasedObservation().then(() => {
            secondFinished = true
        })
        await Promise.resolve()
        expect(secondFinished).toBe(false)
        expect(SpeakersObserver).toHaveBeenCalledTimes(1)
        finish()
        await Promise.all([first, second])
        await (state as any).startUIBasedObservation()
        expect(SpeakersObserver).toHaveBeenCalledTimes(1)
        expect(context.speakersObserver).toBeDefined()
    })

    it('allows retry after startup failure', async () => {
        ;(SpeakersObserver as jest.Mock).mockImplementationOnce(() => ({
            startObserving,
            isCurrentlyObserving: () => false,
        }))
        startObserving.mockRejectedValueOnce(new Error('page unavailable'))
        await expect((state as any).startUIBasedObservation()).rejects.toThrow(
            'page unavailable',
        )
        expect(context.speakersObserver?.isCurrentlyObserving()).toBe(false)
        await (state as any).startUIBasedObservation()
        expect(SpeakersObserver).toHaveBeenCalledTimes(2)
    })

    it.each(['Meet', 'Teams'])(
        'routes %s UI evidence through arbitration',
        async (platform) => {
            ;(GLOBAL.get as jest.Mock).mockReturnValue({
                meetingProvider: platform,
            })
            await (state as any).startUIBasedObservation()
            const callback = startObserving.mock.calls[0][3]
            const speakers = [
                { name: 'Guest', id: 1, timestamp: 1000, isSpeaking: true },
            ]
            await callback(speakers)
            expect(manager.handleUiBridgeUpdate).toHaveBeenLastCalledWith(
                speakers,
                false,
            )
            ;(state as any)[
                platform === 'Meet'
                    ? 'meetNetworkFallbackTriggered'
                    : 'teamsNetworkFallbackTriggered'
            ] = true
            await callback(speakers)
            expect(manager.handleUiBridgeUpdate).toHaveBeenLastCalledWith(
                speakers,
                true,
            )
            expect(manager.handleSpeakerUpdate).not.toHaveBeenCalled()
        },
    )

    it('starts the Teams UI bridge alongside a healthy network path', async () => {
        jest.spyOn(
            state as any,
            'tryTeamsNetworkInterception',
        ).mockResolvedValue(true)
        await (state as any).startSpeakersObservation()
        expect(startObserving).toHaveBeenCalledTimes(1)
        expect(context.networkFallback).toBe(state)
    })

    it('replaces a stopped observer instead of skipping fallback', async () => {
        context.speakersObserver = {
            isCurrentlyObserving: () => false,
        } as SpeakersObserver
        await (state as any).startUIBasedObservation()
        expect(startObserving).toHaveBeenCalledTimes(1)
    })

    it('exposes pending startup to pause and suppresses late callbacks', async () => {
        let finish!: () => void
        startObserving.mockReturnValue(
            new Promise<void>((resolve) => {
                finish = resolve
            }),
        )
        const stopObserving = jest.fn().mockImplementation(async () => {
            finish()
        })
        ;(SpeakersObserver as jest.Mock).mockImplementationOnce(() => ({
            startObserving,
            stopObserving,
            isCurrentlyObserving: () => false,
        }))
        const startup = (state as any).startUIBasedObservation()
        expect(context.speakersObserver).toBeDefined()
        context.isPaused = true
        await context.speakersObserver!.stopObserving()
        await startup
        await startObserving.mock.calls[0][3]([])
        expect(manager.handleUiBridgeUpdate).not.toHaveBeenCalled()
        expect(stopObserving).toHaveBeenCalled()
    })

    it('does not start a delayed fallback while paused', async () => {
        context.isPaused = true
        await (state as any).startUIBasedObservation()
        expect(SpeakersObserver).not.toHaveBeenCalled()
    })

    it('retries failed UI startup after retirement with a cooldown and cap', async () => {
        jest.useFakeTimers().setSystemTime(1_000_000)
        try {
            ;(state as any).teamsNetworkFallbackTriggered = true
            ;(state as any).lastUiObservationAttemptAt = Date.now()
            const retry = jest
                .spyOn(state as any, 'startUIBasedObservation')
                .mockRejectedValue(new Error('page unavailable'))
            jest.setSystemTime(1_029_999)
            await state.requestFallback('diarization-stale')
            expect(retry).not.toHaveBeenCalled()
            for (let i = 1; i <= 5; i++) {
                jest.setSystemTime(1_000_000 + 30_000 * i)
                await state.requestFallback('diarization-stale')
            }
            expect(retry).toHaveBeenCalledTimes(3)
            expect(state.isFallbackTriggered()).toBe(true)
        } finally {
            jest.useRealTimers()
        }
    })

    it.each([false, true])(
        'preserves arbitration on resume when retired=%s',
        async (retired) => {
            jest.useFakeTimers()
            try {
                context.speakersObserver = {
                    startObserving,
                } as unknown as SpeakersObserver
                context.networkFallback = {
                    isFallbackTriggered: () => retired,
                } as any
                const resumed = new ResumingState(
                    context,
                    MeetingStateType.Resuming,
                )
                await (resumed as any).resumeRecording()
                const speakers = [
                    { name: 'Guest', id: 1, timestamp: 1000, isSpeaking: true },
                ]
                await startObserving.mock.calls[0][3](speakers)
                expect(manager.handleUiBridgeUpdate).toHaveBeenCalledWith(
                    speakers,
                    retired,
                )
                expect(manager.handleSpeakerUpdate).not.toHaveBeenCalled()
            } finally {
                jest.clearAllTimers()
                jest.useRealTimers()
            }
        },
    )
})
