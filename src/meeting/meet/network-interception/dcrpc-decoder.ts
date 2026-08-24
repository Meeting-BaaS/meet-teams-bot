// Decoder for Google Meet's `dcrpc` datachannel frames.
//
// On the NetEq media stack (server-side mixed audio, no per-participant WebRTC
// tracks) the classic CSRC/audioLevel speaker path is blind. The live
// active-speaker signal instead rides the `dcrpc` datachannel: each state frame
// carries a per-participant record with a "speaking" flag. Joined with the
// roster (deviceId -> name, decoded from the `collections` channel) this yields
// named active speakers from the network on sessions where nothing else can.
//
// Wire format (one top-level field per frame):
//   field 1        -> keepalive counter (ignore)
//   field 2        -> GZIP-compressed (magic 1f 8b) protobuf state snapshot
//     After inflation, participant records live under a small chain of
//     length-delimited wrappers, each a repeated record with:
//       field 4 (string) -> device id
//       field 8 (varint) -> numeric device id (unused here)
//       field 9 (message)-> "active"; presence of its field 2 (varint) => SPEAKING
//
// The exact wrapper depth around the participant list has shifted between Meet
// rollouts, so the walk is defensive: it looks for participant records at every
// nesting level (descending through field-2 wrappers) and stops at the first
// level that yields them, rather than hard-coding a fixed path. A record only
// counts as a participant when its field 4 decodes as strict UTF-8, which
// cleanly rejects binary sub-messages mis-read as strings.
//
// IMPORTANT: this function is self-contained (no imports, no closed-over
// module state, only standard globals). It is stringified via
// `decodeDcrpcFrame.toString()` and injected into the page as
// `window.__decodeDcrpcFrame`, so it must keep working both in Node (tests) and
// in the browser. All helpers are nested inside it for that reason.

export type DcrpcParticipant = {
  deviceId: string
  speaking: boolean
  // Numeric device id(s) carried alongside the device-path (participant field 8,
  // and the ints inside it if it is a length-delimited pair). The CSRC path
  // resolves speakers by a raw numeric SSRC that the roster (keyed by the
  // device-path) never maps, so these let us bridge numeric -> device-path.
  numericIds: string[]
}

/**
 * Decode a raw `dcrpc` datachannel frame into per-participant speaking state.
 *
 * @param frame   the raw datachannel message bytes
 * @param inflate gzip inflate (browser: `window.pako.inflate`, Node: `pako.inflate`)
 * @returns array of participant records (possibly empty) for a state frame, or
 *          `null` for a keepalive / non-state frame that should be ignored.
 */
export function decodeDcrpcFrame(
  frame: Uint8Array,
  inflate: (bytes: Uint8Array) => Uint8Array
): DcrpcParticipant[] | null {
  // --- minimal protobuf wire reader (varint + length-delimited only) ---
  function readVarint(buf: Uint8Array, state: { pos: number }): number {
    let result = 0
    let shift = 0
    let byte: number
    do {
      if (state.pos >= buf.length) throw new Error("varint past end of buffer")
      byte = buf[state.pos++]
      result += (byte & 0x7f) * 2 ** shift
      shift += 7
      // Guard against pathological length-prefixed garbage.
      if (shift > 70) throw new Error("varint too long")
    } while (byte & 0x80)
    return result
  }

  type Field = { wt: number; val?: number; bytes?: Uint8Array }

  // Parse one message into fieldNumber -> list of entries. Never throws:
  // a malformed tail just ends parsing early.
  function parseFields(buf: Uint8Array): { [field: number]: Field[] } {
    const state = { pos: 0 }
    const fields: { [field: number]: Field[] } = {}
    while (state.pos < buf.length) {
      let tag: number
      try {
        tag = readVarint(buf, state)
      } catch {
        break
      }
      const field = Math.floor(tag / 8)
      const wt = tag % 8
      let entry: Field | null = null
      if (wt === 0) {
        try {
          entry = { wt, val: readVarint(buf, state) }
        } catch {
          break
        }
      } else if (wt === 2) {
        let len: number
        try {
          len = readVarint(buf, state)
        } catch {
          break
        }
        if (len < 0 || state.pos + len > buf.length) break
        entry = { wt, bytes: buf.subarray(state.pos, state.pos + len) }
        state.pos += len
      } else if (wt === 1) {
        if (state.pos + 8 > buf.length) break
        state.pos += 8
        entry = { wt }
      } else if (wt === 5) {
        if (state.pos + 4 > buf.length) break
        state.pos += 4
        entry = { wt }
      } else {
        // Unknown / unsupported wire type (3, 4 groups) — stop, can't resync.
        break
      }
      if (entry) {
        if (!fields[field]) fields[field] = []
        fields[field].push(entry)
      }
    }
    return fields
  }

  const strictDecoder = new TextDecoder("utf-8", { fatal: true })

  // A participant record has a device-id string at field 4 and, when speaking,
  // a non-empty "active" message at field 9 (its field 2 varint present).
  function tryParseParticipant(bytes: Uint8Array): DcrpcParticipant | null {
    const fields = parseFields(bytes)
    const f4 = fields[4]
    if (!f4 || f4.length === 0 || f4[0].wt !== 2 || !f4[0].bytes || f4[0].bytes.length === 0) {
      return null
    }
    let deviceId: string
    try {
      // Strict decode: real device ids are ASCII; binary sub-messages throw here
      // and are rejected, which is how a wrapper level is told apart from a
      // participant level.
      deviceId = strictDecoder.decode(f4[0].bytes)
    } catch {
      return null
    }
    if (!deviceId) return null

    let speaking = false
    const f9 = fields[9]
    if (f9 && f9.length > 0 && f9[0].wt === 2 && f9[0].bytes) {
      const active = parseFields(f9[0].bytes)
      if (active[2] && active[2].length > 0) speaking = true
    }

    // Field 8 carries the participant's numeric device id (a bare varint, or a
    // length-delimited pair of varints). Collect every numeric it yields — one
    // of them is expected to match the raw SSRC the CSRC path resolves against.
    const numericIds: string[] = []
    for (const entry of fields[8] || []) {
      if (entry.wt === 0 && entry.val !== undefined) {
        numericIds.push(String(entry.val))
      } else if (entry.wt === 2 && entry.bytes) {
        const inner = parseFields(entry.bytes)
        for (const key of Object.keys(inner)) {
          for (const sub of inner[Number(key)]) {
            if (sub.wt === 0 && sub.val !== undefined) numericIds.push(String(sub.val))
          }
        }
      }
    }

    return { deviceId, speaking, numericIds }
  }

  // Descend through field-2 wrappers, stopping at the first level whose field-4
  // entries parse as participant records.
  function collectParticipants(bytes: Uint8Array, depth: number, out: DcrpcParticipant[]): void {
    if (depth > 8) return
    const fields = parseFields(bytes)

    let found = false
    const f4 = fields[4] || []
    for (const entry of f4) {
      if (entry.wt !== 2 || !entry.bytes) continue
      const participant = tryParseParticipant(entry.bytes)
      if (participant) {
        out.push(participant)
        found = true
      }
    }
    if (found) return

    const f2 = fields[2] || []
    for (const entry of f2) {
      if (entry.wt === 2 && entry.bytes && entry.bytes.length > 0) {
        collectParticipants(entry.bytes, depth + 1, out)
      }
    }
  }

  // --- frame level ---
  const top = parseFields(frame)
  const field2 = top[2]
  if (!field2 || field2.length === 0) {
    // No state blob — keepalive (field 1) or unrecognised frame. Ignore.
    return null
  }

  const results: DcrpcParticipant[] = []
  for (const entry of field2) {
    if (entry.wt !== 2 || !entry.bytes || entry.bytes.length === 0) continue
    let inflated = entry.bytes
    if (inflated.length >= 2 && inflated[0] === 0x1f && inflated[1] === 0x8b) {
      try {
        // pako.inflate can return undefined (not throw) for a truncated payload
        // with a valid gzip header. Skipping keeps the never-throws contract and
        // lets the remaining field2 entries decode.
        const result = inflate(inflated)
        if (!result || result.length === 0) continue
        inflated = result
      } catch {
        continue
      }
    }
    collectParticipants(inflated, 0, results)
  }
  return results
}
