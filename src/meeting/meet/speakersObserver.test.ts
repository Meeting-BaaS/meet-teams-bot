import type { Page } from '@playwright/test'
import { runInNewContext } from 'vm'
import { MeetSpeakersObserver } from './speakersObserver'
import { SpeakersObserver } from '../speakersObserver'

const mockSnapshot = jest.fn().mockResolvedValue(undefined)
jest.mock('../../services/html-snapshot-service', () => ({
    HtmlSnapshotService: {
        getInstance: () => ({ captureSnapshot: mockSnapshot }),
    },
}))

function harness() {
    const panel = { querySelectorAll: () => [] }
    const frames: Array<{ contentDocument: object }> = []
    const document = {
        body: {},
        visibilityState: 'visible',
        querySelector: (selector: string) =>
            selector === "[aria-label='Participants']" ? panel : null,
        querySelectorAll: (selector: string) =>
            selector === 'iframe' ? frames : [],
    }
    const observe = jest.fn()
    const observers: Array<{
        observe: jest.Mock
        disconnect: jest.Mock
        callback: Function
    }> = []
    const window: Record<string, any> = {}
    const sandbox = {
        window,
        document,
        console,
        Date,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        MutationObserver: class {
            observe = jest.fn((...args: unknown[]) => observe(...args))
            disconnect = jest.fn()
            constructor(public callback: Function) {
                observers.push(this)
            }
        },
    }
    const evaluate = (fn: Function, arg?: unknown) =>
        runInNewContext(`(${fn.toString()})(argument)`, {
            ...sandbox,
            argument: arg,
        })
    const inject = jest.fn(async (fn: Function, arg: unknown) =>
        evaluate(fn, arg),
    )
    const page = {
        exposeFunction: jest.fn(
            async (name: string, callback: (...args: any[]) => unknown) => {
                if (window[name]) throw new Error('Function already registered')
                window[name] = callback
            },
        ),
        evaluate: jest.fn(async (fn: Function, arg?: unknown) =>
            arg === undefined ? evaluate(fn) : inject(fn, arg),
        ),
    }
    return { page, window, observe, observers, frames, inject }
}

describe('Meet observer initialization and binding lifecycle', () => {
    let h: ReturnType<typeof harness>
    let observer: MeetSpeakersObserver
    let callback: jest.Mock
    const makeObserver = (listener = callback) =>
        new MeetSpeakersObserver(
            h.page as unknown as Page,
            'speaker_view',
            'Recorder',
            listener,
        )

    beforeEach(() => {
        jest.useFakeTimers().setSystemTime(1000000)
        for (const method of ['log', 'warn', 'debug', 'info'] as const) {
            jest.spyOn(console, method).mockImplementation(() => {})
        }
        mockSnapshot.mockReset().mockResolvedValue(undefined)
        h = harness()
        callback = jest.fn().mockResolvedValue(undefined)
        observer = makeObserver()
    })

    afterEach(async () => {
        await observer.stopObserving()
        h.window.meetObserverCleanup?.()
        expect(jest.getTimerCount()).toBe(0)
        jest.restoreAllMocks()
        jest.useRealTimers()
    })

    it('awaits actual browser setup and the first callback', async () => {
        let complete: () => void = () => {}
        callback.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    complete = resolve
                }),
        )
        let ready = false
        const startup = observer.startObserving().then(() => {
            ready = true
        })
        await jest.advanceTimersByTimeAsync(0)
        expect(ready).toBe(false)
        expect(h.observe).toHaveBeenCalledTimes(1)
        complete()
        await startup
        expect(ready).toBe(true)
        expect(jest.getTimerCount()).toBe(1)
    })

    it('reuses the exposed binding after a failed evaluation', async () => {
        h.inject.mockRejectedValueOnce(
            new Error('Execution context was destroyed'),
        )
        await expect(observer.startObserving()).rejects.toThrow(
            'Execution context was destroyed',
        )
        await observer.startObserving()
        expect(h.page.exposeFunction).toHaveBeenCalledTimes(1)
        expect(callback).toHaveBeenCalledTimes(1)
    })

    it('does not cache a failed binding registration', async () => {
        h.page.exposeFunction.mockRejectedValueOnce(new Error('Page not ready'))
        await expect(observer.startObserving()).rejects.toThrow(
            'Page not ready',
        )
        await observer.startObserving()
        expect(h.page.exposeFunction).toHaveBeenCalledTimes(2)
    })

    it('rejects failed DOM observer setup without detached browser retries', async () => {
        h.observe.mockImplementationOnce(() => {
            throw new Error('Detached document')
        })
        await expect(observer.startObserving()).rejects.toThrow(
            'Meet mutation observer initialization failed',
        )
        expect(jest.getTimerCount()).toBe(0)
        await observer.startObserving()
        expect(h.page.exposeFunction).toHaveBeenCalledTimes(1)
        expect(callback).toHaveBeenCalledTimes(1)
    })

    it('cleans up partial iframe setup and preserves its original failure', async () => {
        const frameDocument = {}
        h.frames.push({ contentDocument: frameDocument })
        const original = new Error('Iframe unavailable')
        h.observe.mockImplementation((target) => {
            if (target === frameDocument) throw original
        })
        await expect(observer.startObserving()).rejects.toBe(original)
        expect(jest.getTimerCount()).toBe(0)
        expect(
            h.observers.every((item) => item.disconnect.mock.calls.length > 0),
        ).toBe(true)
        h.observe.mockReset()
        await observer.startObserving()
        expect(h.page.exposeFunction).toHaveBeenCalledTimes(1)
    })

    it('disconnects iframe content observers as well as the main/discovery observers', async () => {
        h.frames.push({ contentDocument: {} })
        await observer.startObserving()
        expect(h.observers).toHaveLength(3)
        await observer.stopObserving()
        expect(
            h.observers.every((item) => item.disconnect.mock.calls.length > 0),
        ).toBe(true)
        callback.mockClear()
        for (const item of h.observers) item.callback([])
        await jest.advanceTimersByTimeAsync(20000)
        expect(callback).not.toHaveBeenCalled()
    })

    it('deduplicates concurrent starts', async () => {
        await Promise.all([
            observer.startObserving(),
            observer.startObserving(),
        ])
        expect(h.page.exposeFunction).toHaveBeenCalledTimes(1)
        expect(h.inject).toHaveBeenCalledTimes(1)
        expect(jest.getTimerCount()).toBe(1)
    })

    it('routes the persistent binding to a replacement callback on resume', async () => {
        await observer.startObserving()
        await observer.stopObserving()
        callback.mockClear()
        await h.window.meetSpeakersChanged([])
        expect(callback).not.toHaveBeenCalled()
        const resumed = jest.fn().mockResolvedValue(undefined)
        observer = makeObserver(resumed)
        await observer.startObserving()
        expect(h.page.exposeFunction).toHaveBeenCalledTimes(1)
        expect(resumed).toHaveBeenCalledTimes(1)
        expect(callback).not.toHaveBeenCalled()
    })

    it('does not let a stopped old instance clean up a replacement', async () => {
        await observer.startObserving()
        const old = observer
        observer = makeObserver(jest.fn())
        await observer.startObserving()
        await old.stopObserving()
        expect(jest.getTimerCount()).toBe(1)
    })

    it('cancels startup during People panel preparation before registering a binding', async () => {
        let complete: () => void = () => {}
        h.page.evaluate.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    complete = resolve
                }),
        )
        const startup = observer.startObserving().catch((error: Error) => error)
        const stopping = observer.stopObserving()
        complete()
        expect(await startup).toEqual(new Error('Observer startup cancelled'))
        await stopping
        expect(h.page.exposeFunction).not.toHaveBeenCalled()
        expect(h.inject).not.toHaveBeenCalled()
    })

    it('cancels startup during binding registration before browser injection', async () => {
        let complete: () => void = () => {}
        h.page.exposeFunction.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    complete = resolve
                }),
        )
        const startup = observer.startObserving().catch((error: Error) => error)
        await jest.advanceTimersByTimeAsync(0)
        const stopping = observer.stopObserving()
        complete()
        expect(await startup).toEqual(new Error('Observer startup cancelled'))
        await stopping
        expect(h.inject).not.toHaveBeenCalled()
    })

    it('cancels in-flight startup without registering context or leaving timers behind', async () => {
        let complete: () => void = () => {}
        callback.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    complete = resolve
                }),
        )
        const context: { observer?: MeetSpeakersObserver } = {}
        const startup = observer
            .startObserving()
            .then(() => {
                context.observer = observer
            })
            .catch((error: Error) => error)
        await jest.advanceTimersByTimeAsync(0)
        const stopping = observer.stopObserving()
        complete()
        expect(await startup).toEqual(new Error('Observer startup cancelled'))
        await stopping
        expect(context.observer).toBeUndefined()
        expect(jest.getTimerCount()).toBe(0)
    })

    it('does not treat diagnostic snapshot failure as observer failure', async () => {
        mockSnapshot.mockRejectedValueOnce(new Error('Snapshot unavailable'))
        await observer.startObserving()
        expect(callback).toHaveBeenCalledTimes(1)
        expect(jest.getTimerCount()).toBe(1)
    })

    it('does not reject an unawaited stop if page cleanup throws synchronously', async () => {
        await observer.startObserving()
        h.page.evaluate.mockImplementationOnce(() => {
            throw new Error('Page closed')
        })
        void observer.stopObserving()
        await jest.advanceTimersByTimeAsync(0)
        h.window.meetObserverCleanup()
    })

    it('recovers through the real wrapper using the original exposed binding', async () => {
        const wrapper = new SpeakersObserver('Meet')
        h.inject.mockRejectedValueOnce(new Error('Transient navigation'))
        let ready = false
        const startup = wrapper
            .startObserving(
                h.page as unknown as Page,
                'speaker_view',
                'Recorder',
                callback,
            )
            .then(() => {
                ready = true
            })
        await jest.advanceTimersByTimeAsync(4999)
        expect(ready).toBe(false)
        expect(wrapper.isCurrentlyObserving()).toBe(false)
        await jest.advanceTimersByTimeAsync(1)
        await startup
        expect(wrapper.isCurrentlyObserving()).toBe(true)
        expect(h.page.exposeFunction).toHaveBeenCalledTimes(1)
        await wrapper.stopObserving()
    })
})
