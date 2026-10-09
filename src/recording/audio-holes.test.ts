import { AudioHoleDetector } from "./audio-holes"

const RATE = 16_000

// Deterministic "speech": a loud tone, never exactly zero.
function speech(samples: number, offset = 0): Int16Array {
  const out = new Int16Array(samples)
  for (let i = 0; i < samples; i++) {
    const v = Math.round(8000 * Math.sin((2 * Math.PI * 220 * (i + offset)) / RATE))
    out[i] = v === 0 ? 1 : v
  }
  return out
}

function concat(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const ms = (n: number) => (RATE * n) / 1000

// Prod signature: 80ms of exact zeros, then ~90ms of audio, repeating.
function choppedSeconds(seconds: number): Int16Array {
  const parts: Int16Array[] = []
  for (let t = 0; t < ms(seconds * 1000); t += ms(170)) {
    parts.push(speech(ms(90), t), new Int16Array(ms(80)))
  }
  return concat(parts)
}

describe("AudioHoleDetector", () => {
  it("flags the 80ms-every-170ms chop pattern and bounds its window", () => {
    const detector = new AudioHoleDetector()
    detector.push(speech(ms(60_000))) // clean first minute
    detector.push(choppedSeconds(120)) // chopped minutes 1-2
    detector.push(speech(ms(60_000))) // clean again

    const result = detector.result()
    expect(result.chopped).toBe(true)
    expect(result.holesPerMinute[0]).toBe(0)
    expect(result.holesPerMinute[1]).toBeGreaterThan(300)
    expect(result.holesPerMinute[3]).toBe(0)
    expect(result.choppedFromSeconds).toBeGreaterThanOrEqual(60)
    expect(result.choppedFromSeconds).toBeLessThan(61)
    expect(result.choppedToSeconds).toBeGreaterThan(179)
    expect(result.choppedToSeconds).toBeLessThanOrEqual(180)
  })

  it("ignores real silence, long gaps and near-silent edges", () => {
    const detector = new AudioHoleDetector()
    for (let i = 0; i < 100; i++) {
      detector.push(speech(ms(500)))
      detector.push(new Int16Array(ms(2_000))) // long pause: not a hole
      detector.push(speech(ms(500)))
      detector.push(new Int16Array(ms(30))) // too short to be a hole
    }
    // 80ms zeros between quiet (non-speech) audio
    detector.push(concat([new Int16Array(ms(20)).fill(3), new Int16Array(ms(80)), new Int16Array(ms(20)).fill(3)]))

    const result = detector.result()
    expect(result.holes).toBe(0)
    expect(result.chopped).toBe(false)
    expect(result.choppedFromSeconds).toBeNull()
  })

  it("gives the same answer regardless of chunk boundaries", () => {
    const audio = concat([speech(ms(10_000)), choppedSeconds(60), speech(ms(10_000))])
    const whole = new AudioHoleDetector()
    whole.push(audio)
    const chunked = new AudioHoleDetector()
    for (let i = 0; i < audio.length; i += 777) chunked.push(audio.subarray(i, i + 777))

    expect(chunked.result()).toEqual(whole.result())
  })
})
