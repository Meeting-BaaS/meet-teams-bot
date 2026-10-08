import { SimpleDialogObserver } from './simple-dialog-observer'
import type { MeetingContext } from '../../state-machine/types'

jest.mock('../../singleton', () => ({
    GLOBAL: { get: () => ({ meetingProvider: 'Meet' }) },
}))
jest.mock('../html-snapshot-service', () => ({
    HtmlSnapshotService: {
        getInstance: () => ({ captureSnapshot: async () => {} }),
    },
}))

class Probe extends SimpleDialogObserver {
    abandoned(name: string) {
        return this.isAbandoned(name)
    }
    fail(name: string) {
        this.recordDismissFailure(name)
    }
}

describe('SimpleDialogObserver dismissal budget', () => {
    it('abandons a pattern after MAX_DISMISS_ATTEMPTS failures and not before', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
        const probe = new Probe({} as MeetingContext)
        const max = (
            SimpleDialogObserver as unknown as { MAX_DISMISS_ATTEMPTS: number }
        ).MAX_DISMISS_ATTEMPTS

        for (let i = 1; i < max; i++) {
            probe.fail('camera_permission')
            expect(probe.abandoned('camera_permission')).toBe(false)
        }
        probe.fail('camera_permission')
        expect(probe.abandoned('camera_permission')).toBe(true)
        // Other patterns keep their own budget.
        expect(probe.abandoned('generic_dismiss')).toBe(false)
        warn.mockRestore()
    })

    it('does not spend dismissal budgets on transient detection failures', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
        const page = {
            isClosed: () => false,
            locator: () => ({
                isVisible: async () => {
                    throw new Error('context replaced')
                },
            }),
        }
        const probe = new Probe({
            playwrightPage: page,
        } as unknown as MeetingContext)
        try {
            for (let i = 0; i < 4; i++) await probe.dismissVisibleDialogs()
            expect(probe.abandoned('camera_permission')).toBe(false)
            expect(probe.abandoned('generic_dismiss')).toBe(false)
        } finally {
            warn.mockRestore()
        }
    })

    it('resets an exhausted budget after the dialog disappears', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
        let visible = true
        const page = {
            isClosed: () => false,
            locator: (selector: string) => ({
                isVisible: async () =>
                    visible && selector.includes('has-text("camera")'),
            }),
        }
        const probe = new Probe({
            playwrightPage: page,
        } as unknown as MeetingContext)
        try {
            for (let i = 0; i < 3; i++) probe.fail('camera_permission')
            expect((await probe.dismissVisibleDialogs()).dismissed).toBe(false)
            expect(probe.abandoned('camera_permission')).toBe(true)
            visible = false
            await probe.dismissVisibleDialogs()
            expect(probe.abandoned('camera_permission')).toBe(false)
        } finally {
            warn.mockRestore()
        }
    })
})

describe('SimpleDialogObserver closure confirmation', () => {
    class Probe2 extends SimpleDialogObserver {
        confirm(visible: boolean) {
            return this.confirmDismissed(
                { isVisible: async () => visible },
                { VISIBLE_TIMEOUT: 10, CLICK_TIMEOUT: 10, PAGE_TIMEOUT: 250 },
            )
        }
    }

    it('treats a dialog that stays visible after the action as not dismissed', async () => {
        const probe = new Probe2({} as MeetingContext)
        await expect(probe.confirm(true)).resolves.toBe(false)
    })

    it('confirms a dialog that actually went away', async () => {
        const probe = new Probe2({} as MeetingContext)
        await expect(probe.confirm(false)).resolves.toBe(true)
    })
})
