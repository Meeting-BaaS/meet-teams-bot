import { generateAudioCaptureScript } from "./audio-capture"

/**
 * The audio track layer is a script string injected into the page, so these
 * tests run it for real against a minimal fake window: a track that arrives
 * before the diarization interceptor subscribes must still reach it, which is
 * the whole reason speaker detection can come up empty on a healthy-looking bot.
 */

type FakeTrack = {
  id: string
  kind: string
  readyState: string
  addEventListener: (type: string, handler: () => void) => void
  end: () => void
}

type Listener = (event: { track: FakeTrack }) => void

/** A media track the layer can watch for its own end, as the browser gives it. */
function makeTrack(id: string, kind = "audio", readyState = "live"): FakeTrack {
  const endHandlers: Array<() => void> = []
  return {
    id,
    kind,
    readyState,
    addEventListener(type: string, handler: () => void) {
      if (type === "ended") endHandlers.push(handler)
    },
    end() {
      this.readyState = "ended"
      for (const handler of endHandlers) handler()
    }
  }
}

type TrackSubscriber = { onTrack: (track: FakeTrack) => void }

type AudioTrackLayer = {
  subscribers: TrackSubscriber[]
  seenTracks: Array<{ track: FakeTrack }>
  subscribe: (callbacks: TrackSubscriber) => void
}

type LayerWindow = {
  RTCPeerConnection: new () => FakePeerConnection
  AudioContext: new () => unknown
  addEventListener: () => void
  __audioTrackLayer: AudioTrackLayer
  __meetAudioStop: () => Promise<void>
}

interface FakePeerConnection {
  addEventListener(type: string, listener: Listener): void
  getReceivers(): Array<{ track: FakeTrack }>
  registerReceiver(track: FakeTrack): void
}

function runLayer(): {
  window: LayerWindow
  emitTrack: (track: FakeTrack) => void
} {
  const listeners: Listener[] = []

  class FakePeerConnectionImpl implements FakePeerConnection {
    private readonly receivers: Array<{ track: FakeTrack }> = []
    addEventListener(type: string, listener: Listener) {
      if (type === "track") listeners.push(listener)
    }
    getReceivers() {
      return this.receivers
    }
    registerReceiver(track: FakeTrack) {
      this.receivers.push({ track })
    }
  }

  const win = {
    RTCPeerConnection: FakePeerConnectionImpl,
    AudioContext: class {},
    addEventListener: () => {}
  } as unknown as LayerWindow

  const script = generateAudioCaptureScript({
    provider: "Meet",
    logPrefix: "[MeetAudio]",
    stopFunctionName: "__meetAudioStop",
    enablePeriodicScanning: false
  })

  // The script is written against globals; give it a window and a console.
  new Function("window", "console", script)(win, {
    log: () => {},
    error: () => {}
  })

  const pc = new win.RTCPeerConnection()

  return {
    window: win,
    emitTrack: (track: FakeTrack) => {
      pc.registerReceiver(track)
      for (const listener of listeners) listener({ track })
    }
  }
}

describe("audio track layer", () => {
  it("delivers a track that arrived before the subscriber did", () => {
    const { window: win, emitTrack } = runLayer()

    // The call sets up audio while the bot is still being admitted.
    emitTrack(makeTrack("track-early"))

    const received: string[] = []
    win.__audioTrackLayer.subscribe({
      onTrack: (track: FakeTrack) => received.push(track.id)
    })

    expect(received).toEqual(["track-early"])
  })

  it("still delivers tracks that arrive after subscribing", () => {
    const { window: win, emitTrack } = runLayer()

    const received: string[] = []
    win.__audioTrackLayer.subscribe({
      onTrack: (track: FakeTrack) => received.push(track.id)
    })

    emitTrack(makeTrack("track-late"))

    expect(received).toEqual(["track-late"])
  })

  it("does not replay a track that has already ended", () => {
    const { window: win, emitTrack } = runLayer()

    emitTrack(makeTrack("track-dead", "audio", "ended"))

    const received: string[] = []
    win.__audioTrackLayer.subscribe({
      onTrack: (track: FakeTrack) => received.push(track.id)
    })

    expect(received).toEqual([])
  })

  it("replays each track once, however many times it was announced", () => {
    const { window: win, emitTrack } = runLayer()

    const track = makeTrack("track-repeat")
    emitTrack(track)
    emitTrack(track)

    const received: string[] = []
    win.__audioTrackLayer.subscribe({
      onTrack: (t: FakeTrack) => received.push(t.id)
    })

    expect(received).toEqual(["track-repeat"])
  })

  it("announces a track once to an already-registered subscriber", () => {
    // Registering the same track twice would have the diarization open two
    // readers on one participant.
    const { window: win, emitTrack } = runLayer()

    const received: string[] = []
    win.__audioTrackLayer.subscribe({
      onTrack: (track: FakeTrack) => received.push(track.id)
    })

    const track = makeTrack("track-live")
    emitTrack(track)
    emitTrack(track)

    expect(received).toEqual(["track-live"])
  })

  it("does not announce an ended track to an already-registered subscriber", () => {
    const { window: win, emitTrack } = runLayer()

    const received: string[] = []
    win.__audioTrackLayer.subscribe({
      onTrack: (track: FakeTrack) => received.push(track.id)
    })

    emitTrack(makeTrack("track-dead", "audio", "ended"))

    expect(received).toEqual([])
  })

  it("forgets a track once it ends", () => {
    // The backlog holds live media objects; a call that renegotiates often
    // would otherwise accumulate every track it ever had.
    const { window: win, emitTrack } = runLayer()

    const track = makeTrack("track-gone")
    emitTrack(track)
    expect(win.__audioTrackLayer.seenTracks).toHaveLength(1)

    track.end()

    expect(win.__audioTrackLayer.seenTracks).toHaveLength(0)

    const received: string[] = []
    win.__audioTrackLayer.subscribe({
      onTrack: (t: FakeTrack) => received.push(t.id)
    })

    expect(received).toEqual([])
  })

  it("keeps the tracks that are still live when another one ends", () => {
    const { window: win, emitTrack } = runLayer()

    const leaving = makeTrack("track-leaving")
    emitTrack(leaving)
    emitTrack(makeTrack("track-staying"))

    leaving.end()

    const received: string[] = []
    win.__audioTrackLayer.subscribe({
      onTrack: (track: FakeTrack) => received.push(track.id)
    })

    expect(received).toEqual(["track-staying"])
  })

  it("drops the backlog when audio capture stops", async () => {
    const { window: win, emitTrack } = runLayer()

    emitTrack(makeTrack("track-open"))

    await win.__meetAudioStop()

    expect(win.__audioTrackLayer.seenTracks).toEqual([])
  })

  it("ignores video tracks", () => {
    const { window: win, emitTrack } = runLayer()

    emitTrack(makeTrack("track-video", "video"))

    const received: string[] = []
    win.__audioTrackLayer.subscribe({
      onTrack: (track: FakeTrack) => received.push(track.id)
    })

    expect(received).toEqual([])
  })
})
