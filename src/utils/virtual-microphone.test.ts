import { execFile } from 'child_process'
import { setVirtualMicrophoneMuted } from './virtual-microphone'

jest.mock('child_process', () => ({ execFile: jest.fn() }))

describe('virtual microphone routing', () => {
    const originalMic = process.env.VIRTUAL_MIC
    const originalSource = process.env.PULSE_SOURCE

    beforeEach(() => {
        jest.clearAllMocks()
        delete process.env.VIRTUAL_MIC
        delete process.env.PULSE_SOURCE
        ;(execFile as unknown as jest.Mock).mockImplementation(
            (_command, _args, _options, callback) => callback(null, '', ''),
        )
    })

    afterAll(() => {
        if (originalMic === undefined) delete process.env.VIRTUAL_MIC
        else process.env.VIRTUAL_MIC = originalMic
        if (originalSource === undefined) delete process.env.PULSE_SOURCE
        else process.env.PULSE_SOURCE = originalSource
    })

    it('does not mute default host devices when pod routing is absent', async () => {
        await setVirtualMicrophoneMuted(true)
        expect(execFile).not.toHaveBeenCalled()
    })

    it.each([true, false])(
        'sets both pod devices to muted=%s',
        async (muted) => {
            process.env.VIRTUAL_MIC = 'bot-mic'
            process.env.PULSE_SOURCE = 'bot-mic.monitor'
            await setVirtualMicrophoneMuted(muted)
            for (const [kind, device] of [
                ['sink', 'bot-mic'],
                ['source', 'bot-mic.monitor'],
            ]) {
                expect(execFile).toHaveBeenCalledWith(
                    'pactl',
                    [`set-${kind}-mute`, device, muted ? '1' : '0'],
                    { timeout: 5000 },
                    expect.any(Function),
                )
            }
        },
    )

    it('continues to the source when muting the sink fails', async () => {
        process.env.VIRTUAL_MIC = 'bot-mic'
        process.env.PULSE_SOURCE = 'bot-mic.monitor'
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
        ;(execFile as unknown as jest.Mock).mockImplementationOnce(
            (_command, _args, _options, callback) =>
                callback(new Error('sink missing')),
        )
        try {
            await expect(
                setVirtualMicrophoneMuted(true),
            ).resolves.toBeUndefined()
            expect(execFile).toHaveBeenCalledTimes(2)
            expect(warn).toHaveBeenCalledTimes(1)
        } finally {
            warn.mockRestore()
        }
    })
})
