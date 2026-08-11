import pako from "pako"
import protobuf from "protobufjs"
import { decodeDcrpcFrame } from "./dcrpc-decoder"

// Wire-format helpers built with protobufjs so the fixture is a real, byte-exact
// dcrpc frame rather than a hand-typed byte array.

function tag(fieldNumber: number, wireType: number): number {
  return (fieldNumber << 3) | wireType
}

/** "active" message: presence of field 2 (varint) means speaking. */
function activeMessage(): Uint8Array {
  const w = protobuf.Writer.create()
  w.uint32(tag(2, 0)).uint32(1)
  return w.finish()
}

/** One participant record: field 4 = device id, field 9 = active (optional). */
function participant(deviceId: string, speaking: boolean): Uint8Array {
  const w = protobuf.Writer.create()
  w.uint32(tag(4, 2)).string(deviceId)
  if (speaking) {
    w.uint32(tag(9, 2)).bytes(activeMessage())
  }
  return w.finish()
}

/** Wrap a payload as a single length-delimited field. */
function wrapField(fieldNumber: number, payload: Uint8Array): Uint8Array {
  const w = protobuf.Writer.create()
  w.uint32(tag(fieldNumber, 2)).bytes(payload)
  return w.finish()
}

/**
 * Build the inflated state snapshot:
 *   field 2 { field 2 { field 4(repeated participant) } }
 */
function buildInflatedSnapshot(participants: Uint8Array[]): Uint8Array {
  const inner = protobuf.Writer.create()
  for (const p of participants) {
    inner.uint32(tag(4, 2)).bytes(p)
  }
  const participantsBlock = inner.finish()
  const body = wrapField(2, participantsBlock) // field 2 -> participants block
  return wrapField(2, body) // field 2 -> body
}

/** Build a full dcrpc state frame: field 2 = gzip(inflated snapshot). */
function buildStateFrame(participants: Uint8Array[]): Uint8Array {
  const inflated = buildInflatedSnapshot(participants)
  const gzipped = pako.gzip(inflated)
  expect(gzipped[0]).toBe(0x1f)
  expect(gzipped[1]).toBe(0x8b)
  return wrapField(2, gzipped)
}

describe("decodeDcrpcFrame", () => {
  it("decodes speaking state from a gzip'd protobuf state frame", () => {
    const frame = buildStateFrame([
      participant("device-aaa", true),
      participant("device-bbb", false)
    ])

    const result = decodeDcrpcFrame(frame, pako.inflate)

    expect(result).toEqual([
      { deviceId: "device-aaa", speaking: true },
      { deviceId: "device-bbb", speaking: false }
    ])
  })

  it("returns null for a keepalive frame (field 1 only)", () => {
    const w = protobuf.Writer.create()
    w.uint32(tag(1, 0)).uint32(42)
    const keepalive = w.finish()

    expect(decodeDcrpcFrame(keepalive, pako.inflate)).toBeNull()
  })

  it("returns an empty array when the snapshot carries no participants", () => {
    const frame = buildStateFrame([])
    expect(decodeDcrpcFrame(frame, pako.inflate)).toEqual([])
  })

  it("tolerates an uncompressed (non-gzip) field-2 blob", () => {
    const inflated = buildInflatedSnapshot([participant("device-ccc", true)])
    const frame = wrapField(2, inflated) // no gzip
    const inflate = jest.fn(() => {
      throw new Error("inflate should not be called for non-gzip blobs")
    })

    const result = decodeDcrpcFrame(frame, inflate as unknown as (b: Uint8Array) => Uint8Array)

    expect(inflate).not.toHaveBeenCalled()
    expect(result).toEqual([{ deviceId: "device-ccc", speaking: true }])
  })

  it("finds participants even with an extra wrapper level (defensive walk)", () => {
    // field 2 { field 2 { field 2 { field 4(participant) } } } — one level deeper
    // than the common layout, to prove the walk is not depth-locked.
    const inner = protobuf.Writer.create()
    inner.uint32(tag(4, 2)).bytes(participant("device-ddd", true))
    const deep = wrapField(2, wrapField(2, wrapField(2, inner.finish())))
    const gzipped = pako.gzip(deep)
    const frame = wrapField(2, gzipped)

    expect(decodeDcrpcFrame(frame, pako.inflate)).toEqual([
      { deviceId: "device-ddd", speaking: true }
    ])
  })
})
