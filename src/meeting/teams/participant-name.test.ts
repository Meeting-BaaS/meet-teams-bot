import { resolveTeamsTileName } from './participant-name'

describe('resolveTeamsTileName', () => {
    it('takes the nametag over the badge-carrying aria-label (live DOM, 2026-09-18)', () => {
        expect(
            resolveTeamsTileName({
                nametags: ['', 'Alice'],
                dataTid: 'Alice',
                ariaLabel:
                    'Alice External unfamiliar, video is on, Context menu is available',
            }),
        ).toBe('Alice')
    })

    it('keeps a name that looks like a Teams label', () => {
        expect(
            resolveTeamsTileName({
                nametags: ['Bot Unfamiliar'],
                dataTid: 'Bot Unfamiliar',
                ariaLabel:
                    'Bot Unfamiliar External unfamiliar, muted, Context menu is available',
            }),
        ).toBe('Bot Unfamiliar')
    })

    it('falls back to data-tid when no nametag has rendered yet', () => {
        expect(
            resolveTeamsTileName({
                nametags: [''],
                dataTid: 'Marc',
                ariaLabel: 'Marc Unverified, video is off',
            }),
        ).toBe('Marc')
    })

    it.each([
        ['menur1j', 'Marc Unverified, muted', 'Marc Unverified'],
        ['participant-info', 'Bob (Guest), video is on', 'Bob'],
        ['calling-stream', 'Amr Şimi, muted', 'Amr Şimi'],
    ])(
        'ignores the structural data-tid %p and reads the aria-label',
        (dataTid, aria, expected) => {
            expect(resolveTeamsTileName({ dataTid, ariaLabel: aria })).toBe(
                expected,
            )
        },
    )

    it('never returns an email from data-tid', () => {
        expect(
            resolveTeamsTileName({
                dataTid: 'amr@meetingbaas.com',
                ariaLabel: 'Amr Şimi, muted',
            }),
        ).toBe('Amr Şimi')
    })

    it.each([
        [{ nametags: ['Bob (Guest)'] }, 'Bob'],
        [{ dataTid: 'Bob (Guest)' }, 'Bob'],
        [{ dataTid: 'menur1j', ariaLabel: 'Bob (Guest), muted' }, 'Bob'],
        [{ nametags: ['Bob (Guest) (Unverified)'] }, 'Bob'],
    ])('drops a bracketed guest label from %p', (parts, expected) => {
        expect(resolveTeamsTileName(parts)).toBe(expected)
    })

    it('returns an empty string when the tile carries no name at all', () => {
        expect(resolveTeamsTileName({})).toBe('')
    })
})
