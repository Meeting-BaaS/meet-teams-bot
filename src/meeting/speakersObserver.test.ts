import type { Page } from '@playwright/test'

const mockStart = jest.fn()
const mockStop = jest.fn()
jest.mock('./teams/speakersObserver', () => ({
    TeamsSpeakersObserver: jest.fn().mockImplementation(() => ({
        startObserving: mockStart,
        stopObserving: mockStop,
    })),
}))
jest.mock('./meet/speakersObserver', () => ({
    MeetSpeakersObserver: jest.fn().mockImplementation(() => ({
        startObserving: mockStart,
        stopObserving: mockStop,
    })),
}))

import { SpeakersObserver } from './speakersObserver'
import { TeamsSpeakersObserver } from './teams/speakersObserver'

describe('SpeakersObserver startup', () => {
    let observer: SpeakersObserver
    const start = () =>
        observer.startObserving(
            {} as Page,
            'speaker_view',
            'Recorder',
            jest.fn(),
        )

    beforeEach(() => {
        jest.useFakeTimers()
        jest.clearAllMocks()
        mockStart.mockReset().mockResolvedValue(undefined)
        mockStop.mockReset().mockResolvedValue(undefined)
        jest.spyOn(console, 'log').mockImplementation(() => {})
        jest.spyOn(console, 'warn').mockImplementation(() => {})
        observer = new SpeakersObserver('Teams')
    })

    afterEach(async () => {
        await observer.stopObserving()
        expect(jest.getTimerCount()).toBe(0)
        jest.restoreAllMocks()
        jest.useRealTimers()
    })

    it('keeps startup pending until a failed initialization actually recovers', async () => {
        mockStart.mockRejectedValueOnce(new Error('Transient failure'))
        let settled = false
        const startup = start().then(() => {
            settled = true
        })
        await jest.advanceTimersByTimeAsync(4999)
        expect(settled).toBe(false)
        expect(observer.isCurrentlyObserving()).toBe(false)
        await jest.advanceTimersByTimeAsync(1)
        await startup
        expect(mockStart).toHaveBeenCalledTimes(2)
        expect(observer.isCurrentlyObserving()).toBe(true)
    })

    it('deduplicates concurrent callers through retries', async () => {
        mockStart.mockRejectedValueOnce(new Error('Transient failure'))
        const first = start()
        const second = start()
        await jest.advanceTimersByTimeAsync(5000)
        await Promise.all([first, second])
        expect(TeamsSpeakersObserver).toHaveBeenCalledTimes(1)
        expect(mockStart).toHaveBeenCalledTimes(2)
    })

    it('rejects after bounded retries and permits a subsequent fresh startup', async () => {
        mockStart.mockRejectedValue(new Error('Unavailable'))
        const failed = start().catch((error: Error) => error)
        await jest.advanceTimersByTimeAsync(15000)
        expect(await failed).toEqual(new Error('Unavailable'))
        expect(mockStart).toHaveBeenCalledTimes(4)
        expect(observer.isCurrentlyObserving()).toBe(false)
        mockStart.mockResolvedValue(undefined)
        await start()
        expect(observer.isCurrentlyObserving()).toBe(true)
        expect(TeamsSpeakersObserver).toHaveBeenCalledTimes(2)
    })

    it('cancels a pending retry on stop without resurrecting the observer', async () => {
        mockStart.mockRejectedValue(new Error('Unavailable'))
        const startup = start().catch((error: Error) => error)
        await jest.advanceTimersByTimeAsync(0)
        await observer.stopObserving()
        expect(await startup).toEqual(new Error('Observer startup cancelled'))
        await jest.advanceTimersByTimeAsync(20000)
        expect(mockStart).toHaveBeenCalledTimes(1)
        expect(observer.isCurrentlyObserving()).toBe(false)
    })

    it('does not publish success if stop races an in-flight initialization', async () => {
        let complete: () => void = () => {}
        mockStart.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    complete = resolve
                }),
        )
        const startup = start().catch((error: Error) => error)
        const stopping = observer.stopObserving()
        complete()
        expect(await startup).toEqual(new Error('Observer startup cancelled'))
        await stopping
        expect(observer.isCurrentlyObserving()).toBe(false)
    })

    it.each(['throw', 'reject'])(
        'preserves the original startup failure when cleanup fails by %s',
        async (kind) => {
            const original = new Error('Original startup failure')
            mockStart.mockRejectedValue(original)
            mockStop.mockImplementation(() => {
                if (kind === 'throw') throw new Error('Cleanup failure')
                return Promise.reject(new Error('Cleanup failure'))
            })
            const startup = start().catch((error: Error) => error)
            await jest.advanceTimersByTimeAsync(15000)
            expect(await startup).toBe(original)
            expect(mockStart).toHaveBeenCalledTimes(4)
            expect(observer.isCurrentlyObserving()).toBe(false)
        },
    )

    it('makes legacy fire-and-forget stop non-rejecting', async () => {
        await start()
        mockStop.mockRejectedValue(new Error('Cleanup failure'))
        void observer.stopObserving()
        await jest.advanceTimersByTimeAsync(0)
        expect(observer.isCurrentlyObserving()).toBe(false)
        await expect(observer.stopObserving()).resolves.toBeUndefined()
    })

    it('waits for fire-and-forget cleanup before an immediate restart', async () => {
        await start()
        let complete: () => void = () => {}
        mockStop.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    complete = resolve
                }),
        )
        void observer.stopObserving()
        const resumed = start()
        await jest.advanceTimersByTimeAsync(0)
        expect(mockStart).toHaveBeenCalledTimes(1)
        complete()
        await resumed
        expect(mockStart).toHaveBeenCalledTimes(2)
        expect(observer.isCurrentlyObserving()).toBe(true)
    })

    it('rejects a stopped generation before a caller can register its context', async () => {
        let complete: () => void = () => {}
        mockStart.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    complete = resolve
                }),
        )
        const context: { observer?: SpeakersObserver } = {}
        const startup = start()
            .then(() => {
                context.observer = observer
            })
            .catch((error: Error) => error)
        complete()
        // Let provider startup finish, then stop before the guarded startup promise settles.
        await Promise.resolve()
        const stopping = observer.stopObserving()
        expect(await startup).toEqual(new Error('Observer startup cancelled'))
        await stopping
        expect(context.observer).toBeUndefined()
    })

    it('propagates exhausted Meet initialization failures too', async () => {
        observer = new SpeakersObserver('Meet')
        mockStart.mockRejectedValue(new Error('Meet unavailable'))
        const failed = start().catch((error: Error) => error)
        await jest.advanceTimersByTimeAsync(15000)
        expect(await failed).toEqual(new Error('Meet unavailable'))
        expect(observer.isCurrentlyObserving()).toBe(false)
    })
})
