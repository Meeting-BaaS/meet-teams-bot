import { runInNewContext } from 'vm'
import { MeetSpeakersObserver } from './meeting/meet/speakersObserver'
import { TeamsSpeakersObserver } from './meeting/teams/speakersObserver'

jest.mock('./services/html-snapshot-service', () => ({
    HtmlSnapshotService: {
        getInstance: () => ({ captureSnapshot: async () => {} }),
    },
}))

function tile(name: string, deviceId: string, self: boolean) {
    const attributes: Record<string, string> = {
        'aria-label': name,
        'data-tid': name,
        'data-participant-id': deviceId,
        'data-is-self': String(self),
    }
    const element: any = {
        clientWidth: 100,
        clientHeight: 100,
        getAttribute: (key: string) => attributes[key] ?? null,
        hasAttribute: (key: string) => key in attributes,
        closest: () => element,
        querySelector: () => null,
        querySelectorAll: (selector: string) =>
            selector === 'span' && self ? [{ textContent: '(You)' }] : [],
    }
    return element
}

async function harness(platform: 'meet' | 'teams') {
    let now = 1_000_000
    let tiles: any[] = []
    const changes = jest.fn()
    const intervals: Array<() => Promise<void>> = []
    const bindings: Record<string, unknown> = {}
    class Observer {
        observe() {}
        disconnect() {}
    }
    const document = {
        visibilityState: 'visible',
        body: {},
        querySelector: (selector: string) =>
            platform === 'meet' && selector.includes('Participants')
                ? { querySelectorAll: () => tiles }
                : null,
        querySelectorAll: (selector: string) =>
            platform === 'teams' && selector === '[data-stream-type="Video"]'
                ? tiles
                : [],
    }
    const page: any = {
        exposeFunction: async (name: string, callback: unknown) => {
            bindings[name] = callback
        },
        evaluate: async (fn: Function, args: unknown) => {
            // ensurePeoplePanelOpen is tested by the provider; run only the observer.
            if (!args) return
            runInNewContext(`(${fn.toString()})(args)`, {
                args,
                document,
                window: bindings,
                console: {
                    log() {},
                    debug() {},
                    warn() {},
                    error: (...error: unknown[]) => {
                        throw new Error(String(error))
                    },
                },
                Date: { now: () => now },
                MutationObserver: Observer,
                Node: { ELEMENT_NODE: 1 },
                HTMLElement: class {},
                getComputedStyle: () => ({ backgroundColor: '', opacity: '0' }),
                setTimeout: () => 1,
                clearTimeout() {},
                clearInterval() {},
                setInterval: (callback: () => Promise<void>) => {
                    intervals.push(callback)
                    return 1
                },
            })
        },
    }
    const observer =
        platform === 'meet'
            ? new MeetSpeakersObserver(
                  page,
                  'speaker_view' as any,
                  'Recorder',
                  changes,
              )
            : new TeamsSpeakersObserver(
                  page,
                  'speaker_view' as any,
                  'Recorder',
                  changes,
              )
    await observer.startObserving()
    await new Promise<void>((resolve) => setImmediate(resolve))
    return {
        changes,
        async snapshot(next: any[]) {
            tiles = next
            now += 10_000
            for (const interval of intervals) await interval()
            await new Promise<void>((resolve) => setImmediate(resolve))
        },
    }
}

describe.each(['meet', 'teams'] as const)(
    '%s full-state observer',
    (platform) => {
        it('forwards empty frames, silent self identity, and unchanged heartbeats', async () => {
            const page = await harness(platform)
            expect(page.changes.mock.calls[0][0]).toEqual([])
            const self = tile('Account', 'self-device', true)
            await page.snapshot([self])
            expect(
                page.changes.mock.calls[page.changes.mock.calls.length - 1][0],
            ).toEqual([
                expect.objectContaining({
                    name: 'Account',
                    deviceId: 'self-device',
                    isSelf: true,
                    isSpeaking: false,
                }),
            ])
            const count = page.changes.mock.calls.length
            await page.snapshot([self])
            expect(page.changes.mock.calls.length).toBe(count + 1)
            await page.snapshot([])
            expect(
                page.changes.mock.calls[page.changes.mock.calls.length - 1][0],
            ).toEqual([])
        })

        it('preserves different participants sharing a display name', async () => {
            const page = await harness(platform)
            await page.snapshot([
                tile('Guest', 'device-a', false),
                tile('Guest', 'device-b', false),
            ])
            expect(
                page.changes.mock.calls[page.changes.mock.calls.length - 1][0],
            ).toHaveLength(2)
        })
    },
)
