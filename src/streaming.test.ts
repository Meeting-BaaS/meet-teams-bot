import { EventEmitter } from 'events'

class MockStdin extends EventEmitter {
    chunks: Buffer[] = []
    destroyed = false
    writableEnded = false
    write = jest.fn((chunk: Buffer) => {
        this.chunks.push(Buffer.from(chunk))
        return true
    })
    end = jest.fn(() => {
        this.writableEnded = true
    })
}

const mockStdinInstances: MockStdin[] = []
const mockWsInstances: MockWebSocket[] = []
let mockConnectFailures = 0

class MockWebSocket extends EventEmitter {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    readyState = MockWebSocket.CONNECTING
    sent: unknown[] = []
    paused = false
    pending: Buffer[] = []
    pause = jest.fn(() => {
        this.paused = true
    })
    resume = jest.fn(() => {
        this.paused = false
        while (!this.paused && this.pending.length > 0) {
            this.emit('message', this.pending.shift())
        }
    })

    receive(data: Buffer) {
        if (this.paused) this.pending.push(data)
        else this.emit('message', data)
    }

    constructor(public url: string) {
        super()
        if (mockConnectFailures > 0) {
            mockConnectFailures--
            throw new Error('Connection setup failed')
        }
        mockWsInstances.push(this)
    }

    send(data: unknown) {
        this.sent.push(data)
    }
    open() {
        this.readyState = MockWebSocket.OPEN
        this.emit('open')
    }
    close() {
        this.readyState = MockWebSocket.CLOSED
        this.emit('close')
    }
    terminate() {
        this.close()
    }
}

jest.mock('ws', () => ({ WebSocket: MockWebSocket }))
jest.mock('./media_context', () => ({
    SoundContext: class SoundContext {
        static instance: unknown
        constructor() {
            SoundContext.instance = this
        }
        play_stdin() {
            const stdin = new MockStdin()
            mockStdinInstances.push(stdin)
            return stdin
        }
    },
}))
jest.mock('./utils/Logger', () => ({
    formatError: (error: unknown) => String(error),
}))
jest.mock('./utils/PathManager', () => ({ PathManager: {} }))
const mockSpawn = jest.fn(() =>
    Object.assign(new EventEmitter(), {
        stdin: new MockStdin(),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
    }),
)
jest.mock('child_process', () => ({ spawn: mockSpawn }))

import { Streaming } from './streaming'

function pcmBuffer(samples: number, value = 1000): Buffer {
    const buffer = Buffer.alloc(samples * 2)
    for (let i = 0; i < samples; i++) buffer.writeInt16LE(value, i * 2)
    return buffer
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

async function advancePlayout(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 20) {
        jest.advanceTimersByTime(Math.min(20, ms - elapsed))
        await flush()
    }
}

describe('Streaming v1 audio', () => {
    let streaming: Streaming | undefined
    const debugAudio = process.env.DEBUG_AUDIO

    function create(
        input: string | undefined = 'ws://in/input',
        output?: string,
        rate = 16000,
    ) {
        streaming = new Streaming(input, output, rate, 'bot-123')
        return streaming
    }

    beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
        jest.spyOn(console, 'log').mockImplementation(() => {})
        jest.spyOn(console, 'info').mockImplementation(() => {})
        jest.spyOn(console, 'warn').mockImplementation(() => {})
        process.env.DEBUG_AUDIO = 'false'
        mockWsInstances.length = 0
        mockStdinInstances.length = 0
        mockConnectFailures = 0
        streaming = undefined
    })

    afterEach(async () => {
        await streaming?.stop()
        await flush()
        expect(jest.getTimerCount()).toBe(0)
        jest.restoreAllMocks()
        jest.useRealTimers()
        if (debugAudio === undefined) delete process.env.DEBUG_AUDIO
        else process.env.DEBUG_AUDIO = debugAudio
    })

    it('connects input and output independently and preserves the exact v1 handshake', async () => {
        const service = create('ws://in/input', 'ws://out/output', 24000)
        expect(mockWsInstances.map((ws) => ws.url)).toEqual([
            'ws://out/output',
            'ws://in/input',
        ])
        const [output, input] = mockWsInstances
        output.open()
        input.open()
        const handshake = {
            protocol_version: 1,
            bot_id: 'bot-123',
            offset: 0.0,
            sample_rate: 24000,
        }
        expect(output.sent).toEqual([JSON.stringify(handshake)])
        expect(input.sent).toEqual([])
        service.processMixedAudioChunk({
            audioData: [0, 1, -1],
            sampleRate: 24000,
            timestamp: 123,
            numberOfFrames: 3,
        })
        expect(
            Array.from(new Int16Array(output.sent[1] as ArrayBuffer)),
        ).toEqual([0, 32767, -32768])
        output.close()
        await flush()
        jest.advanceTimersByTime(1000)
        mockWsInstances[2].open()
        expect(mockWsInstances[2].sent).toEqual([JSON.stringify(handshake)])
        expect(input.readyState).toBe(MockWebSocket.OPEN)
    })

    it('uses only the output reconnect path for a shared input/output URL', async () => {
        create('ws://both/audio', 'ws://both/audio')
        expect(mockWsInstances).toHaveLength(1)
        mockWsInstances[0].open()
        mockWsInstances[0].close()
        await flush()
        expect(mockStdinInstances[0].end).not.toHaveBeenCalled()
        jest.advanceTimersByTime(1000)
        expect(mockWsInstances).toHaveLength(2)
        expect(mockStdinInstances).toHaveLength(1)
    })

    it('backs off input reconnects to 60 seconds and resets after a successful open', async () => {
        create()
        mockWsInstances[0].open()
        for (const delay of [
            1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
        ]) {
            const count = mockWsInstances.length
            mockWsInstances[count - 1].close()
            await flush()
            expect(mockStdinInstances).toHaveLength(1)
            expect(mockStdinInstances[0].writableEnded).toBe(false)
            jest.advanceTimersByTime(delay - 1)
            expect(mockWsInstances).toHaveLength(count)
            jest.advanceTimersByTime(1)
            expect(mockWsInstances).toHaveLength(count + 1)
        }
        const count = mockWsInstances.length
        mockWsInstances[count - 1].open()
        mockWsInstances[count - 1].close()
        await flush()
        jest.advanceTimersByTime(1000)
        expect(mockWsInstances).toHaveLength(count + 1)
    })

    it('deduplicates error/close reconnects and ignores stale socket events', async () => {
        create()
        const old = mockWsInstances[0]
        old.readyState = MockWebSocket.CLOSED
        old.emit('error', new Error('Disconnected'))
        old.close()
        await flush()
        expect(jest.getTimerCount()).toBe(1)
        jest.advanceTimersByTime(1000)
        // The old source has been detached after EOF.
        expect(old.listenerCount('message')).toBe(0)
        old.emit('close')
        mockWsInstances[1].open()
        jest.advanceTimersByTime(60000)
        expect(mockWsInstances).toHaveLength(2)
    })

    it('retries an initial synchronous input connection failure', () => {
        mockConnectFailures = 2
        create()
        expect(mockWsInstances).toHaveLength(0)
        jest.advanceTimersByTime(1000)
        expect(mockWsInstances).toHaveLength(0)
        jest.advanceTimersByTime(1999)
        expect(mockWsInstances).toHaveLength(0)
        jest.advanceTimersByTime(1)
        expect(mockWsInstances).toHaveLength(1)
    })

    it('cancels input and output reconnect timers on stop', async () => {
        const service = create('ws://in/input', 'ws://out/output')
        mockWsInstances.forEach((ws) => {
            ws.open()
            ws.close()
        })
        await flush()
        expect(jest.getTimerCount()).toBe(2)
        await service.stop()
        jest.advanceTimersByTime(120000)
        expect(mockWsInstances).toHaveLength(2)
        expect(Streaming.instance).toBeNull()
    })

    it('paces a 400 ms burst in 20 ms frames and fills subsequent gaps with silence', async () => {
        create()
        const ws = mockWsInstances[0]
        const stdin = mockStdinInstances[0]
        ws.open()
        for (let i = 0; i < 10; i++) ws.emit('message', pcmBuffer(640))
        await flush()
        expect(stdin.chunks).toHaveLength(1)
        jest.advanceTimersByTime(380)
        expect(stdin.chunks).toHaveLength(20)
        expect(
            stdin.chunks.every(
                (chunk) =>
                    chunk.length === 1280 &&
                    chunk.readFloatLE(0) === 1000 / 32768,
            ),
        ).toBe(true)
        jest.advanceTimersByTime(110)
        expect(stdin.chunks).toHaveLength(25)
        expect(
            stdin.chunks
                .slice(20)
                .every((chunk) => chunk.equals(Buffer.alloc(1280))),
        ).toBe(true)
        ws.emit('message', pcmBuffer(640, 2000))
        await flush()
        jest.advanceTimersByTime(10)
        expect(stdin.chunks[25].readFloatLE(0)).toBe(2000 / 32768)
        ws.close()
        await flush()
        jest.advanceTimersByTime(20)
        expect(stdin.end).not.toHaveBeenCalled()
    })

    it.each([8000, 16000, 24000, 48000])(
        'pads a short input frame after 40 ms startup timeout at %i Hz',
        async (rate) => {
            create('ws://in/input', undefined, rate)
            const stdin = mockStdinInstances[0]
            mockWsInstances[0].emit('message', pcmBuffer(2, -32768))
            await flush()
            jest.advanceTimersByTime(39)
            expect(stdin.chunks).toHaveLength(0)
            jest.advanceTimersByTime(1)
            expect(stdin.chunks).toHaveLength(1)
            expect(stdin.chunks[0].length).toBe(rate * 0.02 * 4)
            expect(stdin.chunks[0].readFloatLE(0)).toBe(-1)
            expect(stdin.chunks[0].readFloatLE(4)).toBe(-1)
            expect(
                stdin.chunks[0].subarray(8).every((byte) => byte === 0),
            ).toBe(true)
        },
    )

    it('starts and drains short buffered audio when the socket closes before startup', async () => {
        create()
        const ws = mockWsInstances[0]
        const stdin = mockStdinInstances[0]
        ws.emit('message', pcmBuffer(640))
        ws.close()
        await flush()
        expect(stdin.chunks).toHaveLength(1)
        expect(stdin.writableEnded).toBe(false)
        jest.advanceTimersByTime(20)
        expect(stdin.chunks).toHaveLength(2)
        expect(stdin.end).not.toHaveBeenCalled()
    })

    it('keeps Int16 alignment across odd messages and pooled buffer offsets', async () => {
        create()
        const ws = mockWsInstances[0]
        ws.emit('message', Buffer.from([0xe8]))
        const pooled = Buffer.from([99, 0x03, 0x00, 0x80, 88])
        ws.emit('message', pooled.subarray(1, 4))
        await flush()
        jest.advanceTimersByTime(40)
        const frame = mockStdinInstances[0].chunks[0]
        expect(frame.readFloatLE(0)).toBe(1000 / 32768)
        expect(frame.readFloatLE(4)).toBe(-1)
    })

    it('drops a partial sample across reconnects', async () => {
        create()
        mockWsInstances[0].emit('message', Buffer.from([0xff]))
        mockWsInstances[0].close()
        await flush()
        jest.advanceTimersByTime(1000)
        mockWsInstances[1].emit('message', pcmBuffer(1, 1234))
        await flush()
        jest.advanceTimersByTime(40)
        expect(mockStdinInstances).toHaveLength(1)
        expect(mockStdinInstances[0].chunks[0].readFloatLE(0)).toBe(
            1234 / 32768,
        )
    })

    it('clears queued audio and partial samples even on pause/resume between ticks', async () => {
        const service = create()
        const ws = mockWsInstances[0]
        const stdin = mockStdinInstances[0]
        ws.emit('message', pcmBuffer(1280))
        ws.emit('message', Buffer.from([0xff]))
        await flush()
        service.pause()
        ws.emit('message', pcmBuffer(1280, 3000))
        service.resume()
        ws.emit('message', pcmBuffer(320, 2000))
        await flush()
        jest.advanceTimersByTime(20)
        expect(stdin.chunks[1].readFloatLE(0)).toBe(2000 / 32768)
        jest.advanceTimersByTime(20)
        expect(stdin.chunks[2].every((byte) => byte === 0)).toBe(true)
    })

    it('writes silence while paused and discards incoming PCM', async () => {
        const service = create()
        const ws = mockWsInstances[0]
        ws.emit('message', pcmBuffer(1280))
        await flush()
        service.pause()
        ws.emit('message', pcmBuffer(1280))
        jest.advanceTimersByTime(40)
        expect(
            mockStdinInstances[0].chunks
                .slice(1)
                .every((chunk) => chunk.every((byte) => byte === 0)),
        ).toBe(true)
    })

    it('bounds each catch-up callback to five frames after an event-loop stall', async () => {
        const monotonicNow = jest.spyOn(performance, 'now').mockReturnValue(0)
        create()
        mockWsInstances[0].emit('message', pcmBuffer(1280))
        await flush()
        const stdin = mockStdinInstances[0]
        expect(stdin.chunks).toHaveLength(1)
        monotonicNow.mockReturnValue(1000)
        jest.advanceTimersByTime(10)
        expect(stdin.chunks).toHaveLength(6)
        monotonicNow.mockReturnValue(1020)
        jest.advanceTimersByTime(10)
        expect(stdin.chunks).toHaveLength(7)
    })

    it('waits for stdin drain without accumulating unbounded catch-up writes', async () => {
        create()
        const ws = mockWsInstances[0]
        ws.open()
        const stdin = mockStdinInstances[0]
        stdin.write.mockImplementationOnce((chunk) => {
            stdin.chunks.push(chunk)
            return false
        })
        ws.receive(pcmBuffer(1280))
        await flush()
        expect(ws.paused).toBe(true)
        ws.receive(pcmBuffer(320, 2000))
        expect(ws.pending).toHaveLength(1)
        jest.advanceTimersByTime(1000)
        expect(stdin.chunks).toHaveLength(1)
        stdin.emit('drain')
        await flush()
        expect(ws.pending).toHaveLength(0)
        jest.advanceTimersByTime(10)
        expect(stdin.chunks.length).toBeGreaterThan(1)
        expect(stdin.chunks.length).toBeLessThanOrEqual(6)
        await advancePlayout(100)
        expect(
            stdin.chunks
                .slice(0, 4)
                .every((frame) => frame.readFloatLE(0) === 1000 / 32768),
        ).toBe(true)
        expect(stdin.chunks[4].readFloatLE(0)).toBe(2000 / 32768)
    })

    it('preserves all six seconds of an oversized burst and backpressures the source', async () => {
        create()
        const ws = mockWsInstances[0]
        ws.open()
        ws.receive(
            Buffer.concat([pcmBuffer(16000, 1000), pcmBuffer(80000, 2000)]),
        )
        await flush()
        const stdin = mockStdinInstances[0]
        expect(stdin.chunks[0].readFloatLE(0)).toBe(1000 / 32768)
        expect(ws.paused).toBe(true)
        jest.advanceTimersByTime(5980)
        await flush()
        expect(stdin.chunks).toHaveLength(300)
        expect(
            stdin.chunks
                .slice(0, 50)
                .every((chunk) => chunk.readFloatLE(0) === 1000 / 32768),
        ).toBe(true)
        expect(
            stdin.chunks
                .slice(50)
                .every((chunk) => chunk.readFloatLE(0) === 2000 / 32768),
        ).toBe(true)
        expect(ws.paused).toBe(false)
        jest.advanceTimersByTime(20)
        expect(stdin.chunks[300].every((byte) => byte === 0)).toBe(true)
    })

    it('resumes upstream below the low watermark without losing buffered messages', async () => {
        create()
        const ws = mockWsInstances[0]
        ws.open()
        ws.receive(pcmBuffer(96000, 1000))
        await flush()
        expect(ws.paused).toBe(true)
        ws.receive(pcmBuffer(16000, 2000))
        expect(ws.pending).toHaveLength(1)
        await advancePlayout(3480)
        expect(ws.paused).toBe(false)
        expect(ws.pending).toHaveLength(0)
        await advancePlayout(3500)
        const frames = mockStdinInstances[0].chunks
        expect(frames).toHaveLength(350)
        expect(
            frames
                .slice(0, 300)
                .every((frame) => frame.readFloatLE(0) === 1000 / 32768),
        ).toBe(true)
        expect(
            frames
                .slice(300)
                .every((frame) => frame.readFloatLE(0) === 2000 / 32768),
        ).toBe(true)
    })

    it.each([false, true])(
        'serializes reconnect backlog through one writer (shared URL: %s)',
        async (shared) => {
            create('ws://in/input', shared ? 'ws://in/input' : undefined)
            const old = mockWsInstances[0]
            old.open()
            old.receive(pcmBuffer(96000, 1000))
            await flush()
            // One frame already delivered by the socket may enter the Readable
            // after the player has hit its watermark. It must precede replacement audio.
            old.emit('message', pcmBuffer(16000, 2000))
            old.close()
            await flush()
            await advancePlayout(1000)
            const replacement = mockWsInstances[1]
            replacement.open()
            replacement.receive(pcmBuffer(16000, 3000))
            expect(replacement.paused).toBe(true)
            expect(mockStdinInstances).toHaveLength(1)
            await advancePlayout(6980)
            const stdin = mockStdinInstances[0]
            expect(stdin.chunks).toHaveLength(400)
            expect(
                stdin.chunks
                    .slice(0, 300)
                    .every((frame) => frame.readFloatLE(0) === 1000 / 32768),
            ).toBe(true)
            expect(
                stdin.chunks
                    .slice(300, 350)
                    .every((frame) => frame.readFloatLE(0) === 2000 / 32768),
            ).toBe(true)
            expect(
                stdin.chunks
                    .slice(350)
                    .every((frame) => frame.readFloatLE(0) === 3000 / 32768),
            ).toBe(true)
            expect(stdin.end).not.toHaveBeenCalled()
            expect(old.listenerCount('message')).toBe(0)
            expect(replacement.pending).toHaveLength(0)
        },
    )

    it('propagates Readable push backpressure until its buffer is consumed', async () => {
        create()
        const ws = mockWsInstances[0]
        ws.open()
        ws.receive(pcmBuffer(96000, 1000))
        await flush()
        ws.emit('message', pcmBuffer(16000, 2000))
        expect(ws.paused).toBe(true)
        ws.receive(pcmBuffer(16000, 3000))
        await advancePlayout(7980)
        const frames = mockStdinInstances[0].chunks
        expect(frames).toHaveLength(400)
        expect(
            frames
                .slice(0, 300)
                .every((frame) => frame.readFloatLE(0) === 1000 / 32768),
        ).toBe(true)
        expect(
            frames
                .slice(300, 350)
                .every((frame) => frame.readFloatLE(0) === 2000 / 32768),
        ).toBe(true)
        expect(
            frames
                .slice(350)
                .every((frame) => frame.readFloatLE(0) === 3000 / 32768),
        ).toBe(true)
        expect(ws.paused).toBe(false)
        expect(ws.pending).toHaveLength(0)
    })

    it('drops queued, Readable-buffered, and paused upstream audio on intentional pause', async () => {
        const service = create()
        const ws = mockWsInstances[0]
        ws.open()
        ws.receive(pcmBuffer(96000, 1000))
        await flush()
        ws.emit('message', pcmBuffer(16000, 2000))
        ws.receive(pcmBuffer(16000, 3000))
        service.pause()
        expect(ws.paused).toBe(false)
        expect(ws.pending).toHaveLength(0)
        ws.receive(pcmBuffer(16000, 4000))
        service.resume()
        ws.receive(pcmBuffer(320, 5000))
        await flush()
        await advancePlayout(40)
        const frames = mockStdinInstances[0].chunks
        expect(frames).toHaveLength(3)
        expect(frames[1].readFloatLE(0)).toBe(5000 / 32768)
        expect(frames[2].every((byte) => byte === 0)).toBe(true)
    })

    it('stops backpressured playout and removes pending drain listeners', async () => {
        const service = create()
        const stdin = mockStdinInstances[0]
        stdin.write.mockReturnValue(false)
        mockWsInstances[0].emit('message', pcmBuffer(1280))
        await flush()
        expect(stdin.listenerCount('drain')).toBe(1)
        await service.stop()
        expect(stdin.listenerCount('drain')).toBe(0)
        expect(stdin.listenerCount('error')).toBe(0)
        expect(stdin.listenerCount('close')).toBe(0)
        expect(mockWsInstances[0].eventNames()).toEqual([])
        expect(stdin.end).toHaveBeenCalledTimes(1)
        stdin.emit('drain')
        jest.advanceTimersByTime(1000)
        expect(stdin.write).toHaveBeenCalledTimes(1)
    })

    it('cleans old and replacement sources when stopped with a reconnect backlog', async () => {
        const service = create()
        const old = mockWsInstances[0]
        old.open()
        old.receive(pcmBuffer(96000))
        await flush()
        old.emit('message', pcmBuffer(16000))
        old.close()
        await flush()
        await advancePlayout(1000)
        const replacement = mockWsInstances[1]
        replacement.open()
        replacement.receive(pcmBuffer(16000))
        await service.stop()
        expect(old.eventNames()).toEqual([])
        expect(replacement.eventNames()).toEqual([])
        expect(mockStdinInstances).toHaveLength(1)
        expect(mockStdinInstances[0].end).toHaveBeenCalledTimes(1)
        expect(mockStdinInstances[0].eventNames()).toEqual([])
        expect(jest.getTimerCount()).toBe(0)
    })

    it('handles the asynchronous abort error when stopping a connecting socket', async () => {
        const service = create()
        const ws = mockWsInstances[0]
        jest.spyOn(ws, 'terminate').mockImplementation(() => {
            process.nextTick(() => {
                ws.emit('error', new Error('Connection aborted'))
                ws.close()
            })
        })
        await service.stop()
        await flush()
        expect(ws.eventNames()).toEqual([])
        expect(jest.getTimerCount()).toBe(0)
    })

    it('stops sockets and reconnects before asynchronous debug finalization completes', async () => {
        const service = create()
        let completeFinalization: () => void = () => {}
        jest.spyOn(
            service as unknown as {
                finalizeDebugAudioFile: () => Promise<void>
            },
            'finalizeDebugAudioFile',
        ).mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    completeFinalization = resolve
                }),
        )
        mockWsInstances[0].close()
        await flush()
        const stopped = service.stop()
        jest.advanceTimersByTime(120000)
        expect(mockWsInstances).toHaveLength(1)
        expect(jest.getTimerCount()).toBe(0)
        completeFinalization()
        await stopped
    })

    it('preserves partially consumed chunks when a later message crosses the watermark', async () => {
        create()
        const ws = mockWsInstances[0]
        ws.emit('message', pcmBuffer(1280, 1000))
        await flush()
        ws.emit('message', pcmBuffer(80000, 2000))
        await flush()
        jest.advanceTimersByTime(20)
        expect(mockStdinInstances[0].chunks[1].readFloatLE(0)).toBe(
            1000 / 32768,
        )
        jest.advanceTimersByTime(40)
        expect(
            mockStdinInstances[0].chunks
                .slice(0, 4)
                .every((chunk) => chunk.readFloatLE(0) === 1000 / 32768),
        ).toBe(true)
        jest.advanceTimersByTime(20)
        expect(mockStdinInstances[0].chunks[4].readFloatLE(0)).toBe(
            2000 / 32768,
        )
    })

    it.each(['error', 'close'])(
        'cleans up playout timers when stdin emits %s',
        async (event) => {
            create()
            mockWsInstances[0].emit('message', pcmBuffer(1280))
            await flush()
            const stdin = mockStdinInstances[0]
            stdin.emit(event, new Error('FFmpeg exited'))
            expect(stdin.end).toHaveBeenCalledTimes(1)
            jest.advanceTimersByTime(1000)
            expect(stdin.chunks).toHaveLength(1)
        },
    )

    it.each(['error', 'close'])(
        'recovers on source reconnect after FFmpeg stdin %s',
        async (event) => {
            create()
            const old = mockWsInstances[0]
            old.open()
            old.receive(pcmBuffer(1280))
            await flush()
            const failedStdin = mockStdinInstances[0]
            failedStdin.emit(event, new Error('FFmpeg failed'))
            old.close()
            await flush()
            jest.advanceTimersByTime(1000)
            const replacement = mockWsInstances[1]
            replacement.open()
            replacement.receive(pcmBuffer(1280, 2000))
            await flush()
            expect(mockStdinInstances).toHaveLength(2)
            expect(failedStdin.end).toHaveBeenCalledTimes(1)
            expect(failedStdin.chunks).toHaveLength(1)
            expect(mockStdinInstances[1].chunks[0].readFloatLE(0)).toBe(
                2000 / 32768,
            )
            expect(mockStdinInstances[1].writableEnded).toBe(false)
        },
    )

    it('preserves external socket listeners when disposing sources and stopping', async () => {
        const service = create()
        const old = mockWsInstances[0]
        const externalError = jest.fn()
        const externalClose = jest.fn()
        old.on('error', externalError)
        old.on('close', externalClose)
        old.close()
        await flush()
        expect(old.listeners('error')).toContain(externalError)
        expect(old.listeners('close')).toContain(externalClose)
        jest.advanceTimersByTime(1000)
        const replacement = mockWsInstances[1]
        replacement.on('error', externalError)
        replacement.on('close', externalClose)
        await service.stop()
        expect(replacement.listeners('error')).toEqual([externalError])
        expect(replacement.listeners('close')).toEqual([externalClose])
    })

    it.each([1, 1280])(
        'stops startup or active playout immediately with %i samples queued',
        async (samples) => {
            const service = create()
            mockWsInstances[0].emit('message', pcmBuffer(samples))
            await flush()
            const stdin = mockStdinInstances[0]
            const count = stdin.chunks.length
            await service.stop()
            jest.advanceTimersByTime(120000)
            expect(stdin.chunks).toHaveLength(count)
            expect(stdin.end).toHaveBeenCalledTimes(1)
            expect(mockWsInstances).toHaveLength(1)
        },
    )
})

describe('SoundContext input resampling', () => {
    it('uses async resampling with the v1 PCM format and microphone device', () => {
        const { SoundContext } =
            jest.requireActual<typeof import('./media_context')>(
                './media_context',
            )
        mockSpawn.mockClear()
        new SoundContext(24000).play_stdin()
        expect(mockSpawn).toHaveBeenCalledWith(
            'ffmpeg',
            [
                '-f',
                'f32le',
                '-ar',
                '24000',
                '-ac',
                '1',
                '-i',
                '-',
                '-af',
                'aresample=async=1:min_hard_comp=0.100:first_pts=0',
                '-f',
                'alsa',
                '-acodec',
                'pcm_s16le',
                `pulse:${process.env.VIRTUAL_MIC || 'virtual_mic'}`,
            ],
            { stdio: ['pipe', 'pipe', 'pipe'] },
        )
    })
})
