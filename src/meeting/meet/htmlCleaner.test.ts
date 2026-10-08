import { MeetHtmlCleaner } from './htmlCleaner'
import type { Page } from '@playwright/test'

jest.mock('../../services/html-snapshot-service', () => ({
    HtmlSnapshotService: {
        getInstance: () => ({ captureSnapshot: async () => {} }),
    },
}))

describe('Meet layout cleanup', () => {
    const globals = globalThis as any
    const originalDocument = globals.document
    const originalWindow = globals.window

    afterEach(() => {
        jest.clearAllTimers()
        jest.useRealTimers()
        if (originalDocument === undefined) delete globals.document
        else globals.document = originalDocument
        if (originalWindow === undefined) delete globals.window
        else globals.window = originalWindow
    })

    it.each(['gallery_view', 'speaker_view'] as const)(
        'preserves the selected %s layout during repeated cleanup',
        async (mode) => {
            jest.useFakeTimers()
            const tiles = [600, 300].map((offsetWidth) => ({
                offsetWidth,
                style: {} as Record<string, string>,
                parentElement: null,
                querySelectorAll: () => [],
            }))
            globals.document = {
                querySelectorAll: (selector: string) =>
                    selector === '[data-layout="roi-crop"]' ? tiles : [],
                querySelector: () => null,
                getElementsByTagName: () => [],
            }
            globals.window = {}
            const page = {
                evaluate: async (fn: Function, arg: unknown) => fn(arg),
            } as unknown as Page
            const cleaner = new MeetHtmlCleaner(page, mode)
            await cleaner.start()
            jest.advanceTimersByTime(1000)
            if (mode === 'gallery_view') {
                expect(tiles.map((tile) => tile.style)).toEqual([{}, {}])
            } else {
                expect(tiles[0].style.width).toBe('100vw')
                expect(tiles[1].style.opacity).toBe('0')
            }
            await cleaner.stop()
            expect(jest.getTimerCount()).toBe(0)
        },
    )
})
