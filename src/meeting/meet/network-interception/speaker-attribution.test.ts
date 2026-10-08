import { readFileSync } from 'fs'
import { join } from 'path'
import * as ts from 'typescript'

// Compile the actual nested browser functions without requiring WebRTC media.
function harness() {
    const names = [
        'createUserManager',
        'spaceOf',
        'isSelfRecord',
        'updateUsers',
        'getAllUsers',
        'getUserByStreamId',
        'harvestSsrcFromDom',
        'getUsersWithAudio',
        'speakingDeviceOf',
        'filterActiveUsers',
        'decodeUserName',
        'decodeFullName',
        'buildUserStateList',
        'broadcastSpeakerUpdate',
    ]
    const source = ts.createSourceFile(
        'browser-bundle.ts',
        readFileSync(join(__dirname, 'browser-bundle.ts'), 'utf8'),
        ts.ScriptTarget.ES2020,
        true,
    )
    const declarations: string[] = []
    const visit = (node: ts.Node) => {
        if (
            ts.isFunctionDeclaration(node) &&
            node.name &&
            names.includes(node.name.text)
        ) {
            declarations.push(node.getText(source))
        }
        ts.forEachChild(node, visit)
    }
    visit(source)
    expect(declarations).toHaveLength(names.length)
    const code = ts.transpileModule(declarations.join('\n'), {
        compilerOptions: { target: ts.ScriptTarget.ES2020 },
    }).outputText
    const broadcast = jest.fn()
    const api = new Function(
        'window',
        'document',
        'console',
        `let ownSpace = null, ownSpaceIsAuthoritative = false, foreignSpaceUsers = 0;
     ${code}
     return { ${names.join(',')} };`,
    )(
        { onNetworkSpeakerUpdate: broadcast },
        { querySelectorAll: () => [] },
        { log() {}, warn() {} },
    )
    return { ...api, broadcast }
}

describe('Meet speaker evidence', () => {
    it('ranks unresolved SSRCs above quieter named speakers and broadcasts Unknown', () => {
        const h = harness()
        const manager = h.createUserManager()
        h.updateUsers(manager, [
            {
                deviceId: 'spaces/own/devices/1',
                displayName: 'Alice',
                status: 1,
            },
        ])
        manager.ssrcToDeviceMap.set('10', 'spaces/own/devices/1')
        const ranked = h.getUsersWithAudio(
            [
                { source: 10, audioLevel: 0.1 },
                { source: 20, audioLevel: 0.9 },
            ],
            manager,
        )
        expect(h.speakingDeviceOf(ranked[0])).toBe('20')
        h.broadcastSpeakerUpdate(
            manager,
            h.speakingDeviceOf(ranked[0]),
            ranked[0].audioLevel,
        )
        expect(h.broadcast.mock.calls[0][0].users).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'Alice', isSpeaking: false }),
                expect.objectContaining({
                    deviceId: '20',
                    name: 'Unknown',
                    isSpeaking: true,
                }),
            ]),
        )
    })

    it('corrects a provisional conference pin using self and rejects later foreign users', () => {
        const h = harness()
        const manager = h.createUserManager()
        h.updateUsers(manager, [
            { deviceId: 'spaces/foreign/devices/1' },
            { deviceId: 'spaces/foreign/devices/2' },
            { deviceId: 'spaces/own/devices/1' },
        ])
        expect(manager.allUsersMap.size).toBe(2)
        h.updateUsers(manager, [
            {
                deviceId: 'spaces/own/devices/self',
                isCurrentUserString: 'true',
            },
            { deviceId: 'spaces/own/devices/1' },
        ])
        expect([...manager.allUsersMap.keys()]).toEqual([
            'spaces/own/devices/self',
            'spaces/own/devices/1',
        ])
        h.updateUsers(manager, [
            {
                deviceId: 'spaces/foreign/devices/3',
                isCurrentUserString: 'true',
            },
        ])
        expect(manager.allUsersMap.size).toBe(2)
    })
})
