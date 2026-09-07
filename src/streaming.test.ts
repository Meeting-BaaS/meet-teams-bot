/**
 * Regression tests for the streaming input WebSocket:
 * - binary PCM is piped into the FFmpeg stdin
 * - the audio stream is ended when the socket closes (no orphaned FFmpeg
 *   processes across reconnects)
 * - the input socket reconnects with exponential backoff after a drop
 * - stop() clears any pending reconnect
 */

const mockStdin = {
  writes: 0,
  ended: false,
  write: () => {
    mockStdin.writes++
  },
  end: () => {
    mockStdin.ended = true
  }
}

const mockWsInstances: MockWebSocket[] = []

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  url: string
  readyState = MockWebSocket.CONNECTING
  sent: unknown[] = []
  private handlers: Record<string, Array<(...args: unknown[]) => void>> = {}

  constructor(url: string) {
    this.url = url
    mockWsInstances.push(this)
  }

  send(data: unknown) {
    this.sent.push(data)
  }

  on(event: string, handler: (...args: unknown[]) => void) {
    if (!this.handlers[event]) {
      this.handlers[event] = []
    }
    this.handlers[event].push(handler)
  }

  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers[event] ?? []) {
      handler(...args)
    }
  }

  open() {
    this.readyState = MockWebSocket.OPEN
    this.emit("open")
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.emit("close")
  }
}

jest.mock("ws", () => ({ WebSocket: MockWebSocket }))
jest.mock("./config/env-vars", () => ({ envVars: {} }))
jest.mock("./media_context", () => ({
  SoundContext: class {
    static instance: unknown
    constructor() {
      ;(this.constructor as unknown as { instance: unknown }).instance = this
    }
    play_stdin() {
      return mockStdin
    }
  }
}))
jest.mock("./utils/Logger", () => ({ formatError: (e: unknown) => String(e) }))
jest.mock("./utils/PathManager", () => ({
  PathManager: { getInstance: () => ({ getDebugStreamedAudioPath: () => "/tmp/streaming-test.wav" }) }
}))
jest.mock("./utils/S3Uploader", () => ({ S3Uploader: class {} }))

const mockAudioDataHandlers: Array<(data: Buffer) => void> = []

const mockSpawn = jest.fn(() => {
  const makeStream = () => ({ on: () => {} })
  const stdout = {
    on: (event: string, handler: (data: Buffer) => void) => {
      if (event === "data") {
        mockAudioDataHandlers.push(handler)
      }
    }
  }
  return {
    stdin: makeStream(),
    stdout,
    stderr: makeStream(),
    on: () => {},
    kill: () => {}
  }
})

jest.mock("node:child_process", () => ({ spawn: mockSpawn }))

import { Streaming } from "./streaming"

function createStreaming(input = "ws://in/input", output?: string) {
  return new Streaming(input, output, 24000, "bot-123")
}

/** Int16LE PCM buffer with `samples` samples of `value` amplitude */
function pcmBuffer(samples: number, value = 1000): Buffer {
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(value, i * 2)
  }
  return buf
}

describe("Streaming input WebSocket", () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] })
    mockWsInstances.length = 0
    mockStdin.writes = 0
    mockStdin.ended = false
    mockSpawn.mockClear()
    mockAudioDataHandlers.length = 0
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("connects to the input URL on start", () => {
    createStreaming()
    expect(mockWsInstances).toHaveLength(1)
    expect(mockWsInstances[0]?.url).toBe("ws://in/input")
  })

  it("pipes incoming PCM into the FFmpeg stdin and ends it when the socket closes", async () => {
    createStreaming()
    const ws = mockWsInstances[0]!
    ws.open()

    ws.emit("message", pcmBuffer(100))
    // Flowing-mode 'data' events fire on the next tick.
    await new Promise((resolve) => setImmediate(resolve))
    expect(mockStdin.writes).toBeGreaterThan(0)

    ws.close()
    // Stream 'end' (and therefore stdin.end()) fires on the next tick.
    await new Promise((resolve) => setImmediate(resolve))
    expect(mockStdin.ended).toBe(true)
  })

  it("reconnects the input socket after it closes", () => {
    createStreaming()
    const ws0 = mockWsInstances[0]!
    ws0.open()
    ws0.close()

    jest.advanceTimersByTime(1000) // initial backoff = 1s
    expect(mockWsInstances).toHaveLength(2)
    expect(mockWsInstances[1]?.url).toBe("ws://in/input")
  })

  it("backs off exponentially between input reconnect attempts", () => {
    createStreaming()

    let ws = mockWsInstances[0]!
    ws.open()
    ws.close()
    jest.advanceTimersByTime(1000) // attempt 2 (1s backoff)
    expect(mockWsInstances).toHaveLength(2)

    // Do NOT open the new socket: a successful open resets the backoff
    // counter, so exponential growth only applies across failed attempts.
    ws = mockWsInstances[1]!
    ws.close()
    jest.advanceTimersByTime(1000) // 1s into the 2s backoff — nothing yet
    expect(mockWsInstances).toHaveLength(2)

    jest.advanceTimersByTime(1000) // total 2s — attempt 3
    expect(mockWsInstances).toHaveLength(3)
  })

  it("does not reconnect once streaming is stopped", async () => {
    const streaming = createStreaming()
    const ws = mockWsInstances[0]!
    ws.open()
    ws.close()

    await streaming.stop()
    jest.advanceTimersByTime(120_000)
    expect(mockWsInstances).toHaveLength(1)
  })
})

describe("Streaming handshake start_time", () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] })
    mockWsInstances.length = 0
    mockStdin.writes = 0
    mockStdin.ended = false
    mockSpawn.mockClear()
    mockAudioDataHandlers.length = 0
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  function createOutputStreaming() {
    return new Streaming(undefined, "ws://out/output", 24000, "bot-123")
  }

  function handshakeOf(ws: MockWebSocket): Record<string, unknown> {
    const text = ws.sent.find((m): m is string => typeof m === "string")
    expect(text).toBeDefined()
    return JSON.parse(text!)
  }

  it("sends start_time null before audio capture starts", () => {
    createOutputStreaming()
    const ws = mockWsInstances[0]!
    ws.open()
    const handshake = handshakeOf(ws)
    expect(handshake.start_time).toBeNull()
    expect(handshake.bot_id).toBe("bot-123")
    expect(handshake.sample_rate).toBe(24000)
  })

  it("notifies an already-open socket when capture starts", () => {
    const streaming = createOutputStreaming()
    const ws = mockWsInstances[0]!
    ws.open()
    expect(handshakeOf(ws).start_time).toBeNull()

    // Capture starts while the initial socket is still open. The bot must
    // deliver the real capture start time before any audio flows.
    streaming.startAudioCapture()
    expect(mockSpawn).toHaveBeenCalledTimes(1)

    const handshakes = ws.sent.filter((m): m is string => typeof m === "string")
    expect(handshakes).toHaveLength(2)
    const updated = JSON.parse(handshakes[1]!)
    expect(typeof updated.start_time).toBe("number")
    expect((updated.start_time as number) > 0).toBe(true)

    // Emit one complete 100ms chunk (2400 samples at 24kHz) through the
    // mocked FFmpeg stdout and verify the updated handshake was delivered
    // before the first binary PCM message.
    const samples = new Float32Array(2400)
    for (const handler of mockAudioDataHandlers) {
      handler(Buffer.from(samples.buffer))
    }
    expect(mockAudioDataHandlers.length).toBeGreaterThan(0)

    const binaryIndex = ws.sent.findIndex((m) => typeof m !== "string")
    expect(binaryIndex).toBeGreaterThan(0)
    expect(ws.sent.indexOf(handshakes[1]!)).toBeLessThan(binaryIndex)
    expect((ws.sent[binaryIndex] as ArrayBuffer).byteLength).toBe(4800)
  })

  it("sends the capture start time in handshakes after capture starts", () => {
    const streaming = createOutputStreaming()
    const ws0 = mockWsInstances[0]!
    ws0.open()

    streaming.startAudioCapture()
    expect(mockSpawn).toHaveBeenCalledTimes(1)

    // Simulate a reconnect: close the output socket, wait for backoff.
    ws0.close()
    jest.advanceTimersByTime(1000)
    expect(mockWsInstances).toHaveLength(2)

    const ws1 = mockWsInstances[1]!
    ws1.open()
    const handshake = handshakeOf(ws1)
    expect(typeof handshake.start_time).toBe("number")
    expect((handshake.start_time as number) > 0).toBe(true)
  })
})
