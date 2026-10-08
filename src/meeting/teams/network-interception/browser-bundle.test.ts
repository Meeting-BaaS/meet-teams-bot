import { runInNewContext } from 'vm'
import { teamsBrowserInterceptionLogic } from './browser-bundle'
import { extractOwnRoster, resolveRosterScope } from './meeting-scope'
import { resolveSpeakingSet } from './speaker-timeline'

const OWN = '19:own@thread.v2'
const FOREIGN = '19:foreign@thread.v2'

function harness(isAuthenticated = false) {
    const errors = jest.fn()
    let body: unknown
    class Socket {}
    class Peer {
        static generateCertificate() {}
    }
    const window: any = {
        pako: {},
        WebSocket: Socket,
        RTCPeerConnection: Peer,
        fetch: async () => ({
            clone: () => ({ text: async () => JSON.stringify(body) }),
        }),
    }
    runInNewContext(
        `(${teamsBrowserInterceptionLogic.toString()})(${resolveSpeakingSet.toString()},
      ${resolveRosterScope.toString()}, ${extractOwnRoster.toString()},
      ${JSON.stringify({ conversationId: OWN, isAuthenticated })})`,
        {
            window,
            console: { log() {}, warn() {}, debug() {}, error: errors },
            setInterval: () => 1,
            clearInterval() {},
            setTimeout: () => 1,
            document: { querySelector: () => null },
        },
    )
    expect(errors).not.toHaveBeenCalled()
    return {
        window,
        async roster(payload: unknown, conversation = OWN) {
            body = payload
            await window.fetch(
                `https://example.test/conversations/${conversation}/roster`,
            )
            await Promise.resolve()
            await Promise.resolve()
            expect(errors).not.toHaveBeenCalled()
        },
        users() {
            const queue = window.__teamsSpeakerQueue
            return queue?.[queue.length - 1]?.users ?? []
        },
    }
}

const participant = (id: string, state?: string) => ({
    details: { id, displayName: id },
    ...(state ? { state } : {}),
})

describe('Teams browser roster integration', () => {
    it('drops inactive participants and keeps state on metadata-only deltas (db519193)', async () => {
        const page = harness()
        await page.roster({
            participants: [
                participant('Alice', 'active'),
                participant('Bob', 'active'),
            ],
        })
        expect(page.users().map((u: any) => u.name)).toEqual(['Alice', 'Bob'])
        await page.roster({ participants: [participant('Bob', 'inactive')] })
        expect(page.users().map((u: any) => u.name)).toEqual(['Alice'])
        await page.roster({ participants: [participant('Bob')] })
        expect(page.users().map((u: any) => u.name)).toEqual(['Alice'])
        await page.roster({ participants: [participant('Bob', 'active')] })
        expect(page.users().map((u: any) => u.name)).toEqual(['Alice', 'Bob'])
        await page.roster({
            participants: [
                participant('Alice', 'inactive'),
                participant('Bob', 'inactive'),
            ],
        })
        expect(page.users()).toEqual([])
    })

    it('rejects a different meeting even after strict scoping relaxes', async () => {
        const page = harness(true)
        for (let i = 0; i < 6; i++) {
            await page.roster(
                { participants: [participant('Unplaced', 'active')] },
                '',
            )
        }
        expect(page.window.__teamsNetDiag.rosterScopeStrictRelaxed).toBe(true)
        await page.roster(
            { participants: [participant('Foreign', 'active')] },
            FOREIGN,
        )
        expect(page.users().some((u: any) => u.name === 'Foreign')).toBe(false)
        expect(page.window.__teamsNetDiag.rosterScopeRejected).toBeGreaterThan(
            0,
        )
    })

    it('accepts direct roster arrays and rejects signed-in aggregate contamination', async () => {
        const page = harness(true)
        await page.roster([participant('Alice', 'active')])
        expect(page.users().map((u: any) => u.name)).toEqual(['Alice'])
        await page.roster({
            calls: [
                {
                    conversationId: OWN,
                    participants: [participant('Bob', 'active')],
                },
                {
                    conversationId: FOREIGN,
                    participants: [participant('Foreign', 'active')],
                },
            ],
            participants: [participant('Foreign', 'active')],
        })
        expect(page.users().some((u: any) => u.name === 'Foreign')).toBe(false)
    })
})
