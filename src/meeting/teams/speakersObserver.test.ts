import type { Page } from '@playwright/test'
import { runInNewContext } from 'vm'
import { TeamsSpeakersObserver } from './speakersObserver'
import { SpeakersObserver } from '../speakersObserver'

const mockSnapshot = jest.fn().mockResolvedValue(undefined)
jest.mock('../../services/html-snapshot-service', () => ({
    HtmlSnapshotService: {
        getInstance: () => ({ captureSnapshot: mockSnapshot }),
    },
}))

class ElementStub {
    clientWidth = 640
    clientHeight = 360
    textContent = ''
    innerText = ''
    click = jest.fn()
    constructor(private attrs: Record<string, string> = {}) {}
    getAttribute(name: string) {
        return this.attrs[name] ?? null
    }
    hasAttribute(name: string) {
        return name in this.attrs
    }
    closest() {
        return null
    }
    querySelector() {
        return null
    }
    querySelectorAll() {
        return []
    }
}

function harness() {
    const tile = new ElementStub({
        'data-tid': 'Alice',
        'data-stream-type': 'Video',
    })
    const captionButton = new ElementStub()
    const nodes = new Map<string, ElementStub>([
        ['#closed-captions-button', captionButton],
    ])
    const document = {
        visibilityState: 'visible',
        querySelector: (selector: string) => nodes.get(selector) ?? null,
        querySelectorAll: (selector: string) =>
            selector === '[data-stream-type="Video"]' ? [tile] : [],
    }
    const observe = jest.fn()
    const disconnect = jest.fn()
    const window: Record<string, any> = {}
    const sandbox = {
        window,
        document,
        HTMLElement: ElementStub,
        console,
        Date,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        MutationObserver: class {
            observe = observe
            disconnect = disconnect
        },
    }
    const page = {
        exposeFunction: jest.fn(
            async (name: string, callback: (...args: any[]) => unknown) => {
                if (window[name]) throw new Error('Function already registered')
                window[name] = callback
            },
        ),
        evaluate: jest.fn(async (fn: Function, arg?: unknown) =>
            runInNewContext(`(${fn.toString()})(argument)`, {
                ...sandbox,
                argument: arg,
            }),
        ),
    }
    return { page, window, observe, disconnect, captionButton, nodes }
}

describe('Teams observer lifecycle and caption ownership', () => {
    let h: ReturnType<typeof harness>
    let observer: TeamsSpeakersObserver
    let callback: jest.Mock
    const makeObserver = (listener = callback) =>
        new TeamsSpeakersObserver(
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
        h.window.teamsObserverCleanup?.()
        expect(jest.getTimerCount()).toBe(0)
        jest.restoreAllMocks()
        jest.useRealTimers()
    })

    it('awaits browser initialization and its first callback', async () => {
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

    it('reuses the binding after a transient evaluation failure', async () => {
        h.page.evaluate.mockRejectedValueOnce(
            new Error('Execution context was destroyed'),
        )
        await expect(observer.startObserving()).rejects.toThrow(
            'Execution context was destroyed',
        )
        await observer.startObserving()
        expect(h.page.exposeFunction).toHaveBeenCalledTimes(1)
        expect(callback).toHaveBeenCalledTimes(1)
    })

    it('retries a rejected binding registration rather than caching its rejection', async () => {
        h.page.exposeFunction.mockRejectedValueOnce(new Error('Page not ready'))
        await expect(observer.startObserving()).rejects.toThrow(
            'Page not ready',
        )
        await observer.startObserving()
        expect(h.page.exposeFunction).toHaveBeenCalledTimes(2)
        expect(callback).toHaveBeenCalledTimes(1)
    })

    it('rejects failed browser observation setup without browser-side retries', async () => {
        h.observe.mockImplementationOnce(() => {
            throw new Error('Detached document')
        })
        await expect(observer.startObserving()).rejects.toThrow(
            'Teams mutation observer initialization failed',
        )
        expect(jest.getTimerCount()).toBe(0)
        await observer.startObserving()
        expect(h.page.exposeFunction).toHaveBeenCalledTimes(1)
        expect(h.observe).toHaveBeenCalledTimes(2)
    })

    it('deduplicates simultaneous starts', async () => {
        await Promise.all([
            observer.startObserving(),
            observer.startObserving(),
        ])
        expect(h.page.exposeFunction).toHaveBeenCalledTimes(1)
        expect(h.observe).toHaveBeenCalledTimes(1)
        expect(jest.getTimerCount()).toBe(1)
    })

    it('routes a persistent binding to the replacement callback after stop/resume', async () => {
        await observer.startObserving()
        await observer.stopObserving()
        callback.mockClear()
        await h.window.teamsSpeakersChanged([])
        expect(callback).not.toHaveBeenCalled()
        const resumed = jest.fn().mockResolvedValue(undefined)
        observer = makeObserver(resumed)
        await observer.startObserving()
        expect(h.page.exposeFunction).toHaveBeenCalledTimes(1)
        expect(resumed).toHaveBeenCalledTimes(1)
        expect(callback).not.toHaveBeenCalled()
    })

    it('prevents an old observer from stopping its replacement', async () => {
        await observer.startObserving()
        const old = observer
        observer = makeObserver(jest.fn())
        await observer.startObserving()
        await old.stopObserving()
        expect(jest.getTimerCount()).toBe(1)
        await observer.stopObserving()
        expect(jest.getTimerCount()).toBe(0)
    })

    it('cancels startup during binding registration without injecting a new observer', async () => {
        let complete: () => void = () => {}
        h.page.exposeFunction.mockImplementationOnce(
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
        expect(h.observe).not.toHaveBeenCalled()
        expect(jest.getTimerCount()).toBe(0)
    })

    it('does not fail a running observer because the diagnostic snapshot failed', async () => {
        mockSnapshot.mockRejectedValueOnce(new Error('Snapshot unavailable'))
        await observer.startObserving()
        expect(callback).toHaveBeenCalledTimes(1)
        expect(jest.getTimerCount()).toBe(1)
    })

    it('recovers through the real wrapper without duplicate exposed bindings', async () => {
        const wrapper = new SpeakersObserver('Teams')
        h.page.evaluate.mockRejectedValueOnce(new Error('Transient navigation'))
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

    it('observes UI without toggling captions while the network interceptor owns activation', async () => {
        h.window.__teamsNetworkInterceptorInitialized = true
        h.window.__teamsNetworkInterceptorStopped = false
        h.window.__teamsStopNetworkInterception = jest.fn()
        await observer.startObserving()
        await jest.advanceTimersByTimeAsync(30000)
        expect(callback).toHaveBeenCalled()
        expect(h.captionButton.click).not.toHaveBeenCalled()
    })

    it('takes caption ownership only after the browser interceptor stops', async () => {
        h.window.__teamsNetworkInterceptorInitialized = true
        h.window.__teamsNetworkInterceptorStopped = false
        h.window.__teamsStopNetworkInterception = jest.fn()
        await observer.startObserving()
        expect(h.captionButton.click).not.toHaveBeenCalled()
        // A Node forwarding pause leaves these flags unchanged, so cannot hand off ownership.
        await jest.advanceTimersByTimeAsync(10000)
        expect(h.captionButton.click).not.toHaveBeenCalled()
        h.window.__teamsNetworkInterceptorStopped = true
        await jest.advanceTimersByTimeAsync(10000)
        expect(h.captionButton.click).toHaveBeenCalledTimes(1)
    })

    it('still activates captions for standalone UI observation', async () => {
        await observer.startObserving()
        expect(h.captionButton.click).toHaveBeenCalledTimes(1)
    })

    it('does not defer to an interceptor whose installation failed before registering stop', async () => {
        h.window.__teamsNetworkInterceptorInitialized = true
        h.window.__teamsNetworkInterceptorStopped = false
        await observer.startObserving()
        expect(h.captionButton.click).toHaveBeenCalledTimes(1)
    })

    it('cleans up an in-flight browser startup when stop races its first callback', async () => {
        let complete: () => void = () => {}
        callback.mockImplementationOnce(
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
        expect(jest.getTimerCount()).toBe(0)
        callback.mockClear()
        await jest.advanceTimersByTimeAsync(20000)
        expect(callback).not.toHaveBeenCalled()
    })

    it('does not toggle captions that already have a renderer', async () => {
        h.nodes.set(
            '[data-tid="closed-caption-renderer-wrapper"]',
            new ElementStub(),
        )
        await observer.startObserving()
        await jest.advanceTimersByTimeAsync(30000)
        expect(h.captionButton.click).not.toHaveBeenCalled()
    })

    it('bounds standalone caption retries', async () => {
        await observer.startObserving()
        await jest.advanceTimersByTimeAsync(200000)
        expect(h.captionButton.click).toHaveBeenCalledTimes(8)
    })
})
