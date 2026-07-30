// Browser-side bundle for Zoom speaker detection. Stringified into addInitScript,
// so it must be self-contained (browser APIs only; no pako/protobuf needed since
// Zoom's signaling is plain JSON).
//
// Zoom's RWG socket lives in a Web Worker, not the main thread, and the worker
// posts frames to the page wrapped as {type:"message", data:"<json string>"} —
// so we unwrap JSON-in-string, otherwise we only ever see the envelope.
//
// Frames we care about (opcodes group by channel: 12xxx audio, 16xxx video,
// 20xxx share):
//   7937   roster. body.add[] of { id, dn2 (base64 name), bBotUser, ... }.
//          body.remove/update are object maps keyed by id, not arrays.
//   12033  active speaker. body.asn1/asn2/... = speaking node ids matching roster
//          ids; several when people talk over each other. Empty body = silence.
//   8005   per-user audio level { nUserID, nLevel, mediaType }. nLevel has been
//          constant on every build seen so far, so it's only trusted once observed
//          both zero and non-zero.
//
// We match on field names rather than opcode numbers (the evt table is
// undocumented and differs between client builds) and learn which opcode carries
// the active speaker at runtime. Opcodes are only counted, for diagnostics.
//
// No CSRC on Zoom web: its peer connections are datachannel-only and media rides
// the WASM/WebSocket stack, so there are no audio receivers. The CSRC code below
// is a guarded no-op kept for builds that differ.

/** biome-ignore-all lint/suspicious/noExplicitAny: browser-side bundle over untyped Zoom internals. */

export function zoomBrowserInterceptionLogic() {
  try {
    if ((window as any).__zoomNetworkInterceptorInitialized === true) {
      console.warn("[Zoom NetworkInterceptor] ⚠️ Already initialized, skipping duplicate")
      return
    }
    ;(window as any).__zoomNetworkInterceptorInitialized = true
    ;(window as any).__zoomNetworkInterceptorStopped = false

    // "[NetworkInterceptor]" prefix so page-logger surfaces warn/error by
    // default (no LOG_LEVEL=debug needed); "[Zoom]" distinguishes from Meet/Teams.
    const LOG = "[NetworkInterceptor][Zoom]"
    const DEBUG = false
    const debug = (...args: any[]) => {
      if (DEBUG) console.log(LOG, ...args)
    }

    // ===== STATE =====

    // Zoom user id (stringified) → participant record.
    const participantsById = new Map<string, any>()
    // ssrc (stringified) → Zoom user id, when the build publishes ssrcs.
    const ssrcToUserId = new Map<string, string>()
    // Sticky until the next indication — Zoom only emits on change.
    let activeSpeakerIds = new Set<string>()
    // Node drains this via page.evaluate; exposeFunction bindings aren't reliably
    // visible to an addInitScript bundle under the anti-detect browser.
    ;(window as any).__zoomSpeakerQueue = (window as any).__zoomSpeakerQueue || []

    // receiver → seen-active
    const receiverMap = new Map<RTCRtpReceiver, boolean>()
    // Only authoritative once a source resolves to a participant.
    let csrcAvailable = false
    let hasObservedCsrcMapping = false
    // Ids currently speaking per CSRC audio levels.
    let csrcSpeakingIds = new Set<string>()

    // evt 8005 per-user audio levels: userId -> { level, at }.
    const userLevels = new Map<string, { level: number; at: number }>()
    // nLevel's scale is undocumented; a constant would read as "everyone always
    // speaking", so only trust it once seen both zero and non-zero.
    let sawLevelZero = false
    let sawLevelPositive = false
    const LEVEL_TTL_MS = 1500
    // Most recent signal wins. Ordered by frame counter rather than Date.now():
    // frames arrive faster than the 1ms clock, and ties silently decided the winner.
    let frameSeq = 0
    let lastLevelSeq = 0
    let lastActiveSpeakerSeq = 0
    // Learned from the first frame that yields an asn. Knowing it lets an empty
    // frame of that opcode mean silence rather than "no information".
    let activeSpeakerEvt: number | null = null
    // Share-channel fallback, retired for good once the audio channel speaks.
    let nodeSpeakerIds = new Set<string>()
    let sawAsn = false

    let lastSpeakingLogKey = ""
    // Deadline anchor for the self-check below. Measured from interceptor start so a
    // total decode failure (no roster ever) is caught too, not just a partial one.
    const interceptorStartedAt = Date.now()
    let firstRosterAt = 0
    let firstSpeakerAt = 0
    let healthReported = false
    // Deadline for asking Node to fall back to the DOM observer.
    const SPEAKER_SIGNAL_TIMEOUT_MS = 45_000

    // Non-PII counters; Node reads these to see which stage stops producing.
    ;(window as any).__zoomNetDiag = (window as any).__zoomNetDiag || {
      wsCreated: 0,
      wsFrames: 0,
      jsonFrames: 0,
      workerMsgs: 0,
      rosterFrames: 0,
      rosterParticipants: 0,
      speakerFrames: 0,
      rtcCreated: 0,
      receiversAdded: 0,
      csrcAvailable: false,
      csrcMapped: 0,
      broadcasts: 0,
      queueLen: 0,
      evtCounts: {},
      speakerKeys: [],
      evtShapes: {},
      levelMin: -1,
      levelMax: -1,
      levelsAuthoritative: false,
      activeSpeakerEvt: -1
    }
    const diag = (window as any).__zoomNetDiag

    // ===== DECODE HELPERS =====

    // dn2 is always base64, so decode outright rather than guessing on length —
    // "John" is only 6 chars encoded ("Sm9obg", padding stripped). Zoom doesn't
    // reliably pad and sometimes uses base64url. Invalid UTF-8 means it wasn't
    // base64 after all, so fall back to the raw string.
    function decodeBase64Name(value: string): string | undefined {
      if (!value || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return undefined
      try {
        let normalized = value.replace(/-/g, "+").replace(/_/g, "/")
        while (normalized.length % 4 !== 0) normalized += "="
        const bytes = Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0))
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control bytes is the point
        if (!decoded || /[\u0000-\u0008\u000e-\u001f]/.test(decoded)) return undefined
        return decoded
      } catch {
        return undefined
      }
    }

    function nameOf(record: any): string | undefined {
      // dn2 is the base64 field on current builds and takes precedence; the others
      // are plain text and must NOT be run through a base64 guess.
      if (typeof record?.dn2 === "string" && record.dn2.trim() !== "") {
        return decodeBase64Name(record.dn2) ?? record.dn2
      }
      const raw =
        record?.dn ?? record?.displayName ?? record?.name ?? record?.userName ?? record?.user_name
      if (typeof raw !== "string" || raw.trim() === "") return undefined
      return raw
    }

    function idOf(record: any): string | undefined {
      const raw =
        record?.id ??
        record?.nUserID ??
        record?.userId ??
        record?.user_id ??
        record?.uid ??
        record?.uniqueUserID
      if (typeof raw === "number" && Number.isFinite(raw)) return String(raw)
      if (typeof raw === "string" && raw !== "") return raw
      return undefined
    }

    // id + display name together is specific enough to skip the chat, layout and
    // telemetry objects sharing these frames.
    function isUserRecord(node: any): boolean {
      return (
        !!node && typeof node === "object" && !Array.isArray(node) && !!idOf(node) && !!nameOf(node)
      )
    }

    const SPEAKER_KEY_RE = /(active[_-]?speakers?|dominant[_-]?speakers?|speaker[_-]?id)/i
    // asn = active speaker node; numbered because Zoom lists several. Audio
    // channel, so this is the authoritative signal.
    const ASN_KEY_RE = /^asn\d+$/i
    // activeNodeID is on the share channel — the active *sharer*, not speaker. Only
    // a last resort before any asn is seen, and only when bStatus says it's active.
    const NODE_KEY_RE = /^active[_-]?node[_-]?id$/i
    const SPEAKING_FLAG_RE = /^(is[_-]?speaking|b[_-]?speaking|audio[_-]?active|speaking)$/i
    const SSRC_KEY_RE = /^(audio[_-]?ssrc|ssrc|audio[_-]?source)$/i

    // Forms seen: 12345, "12345", [12345], [{id:12345}], {id:12345}.
    function speakerIdsFrom(value: any): string[] {
      const out: string[] = []
      const push = (v: any) => {
        if (typeof v === "number" && Number.isFinite(v)) out.push(String(v))
        else if (typeof v === "string" && v !== "") out.push(v)
        else if (v && typeof v === "object") {
          const id = idOf(v)
          if (id) out.push(id)
        }
      }
      if (Array.isArray(value)) value.forEach(push)
      else push(value)
      return out
    }

    // ===== FRAME HARVEST =====

    type Harvest = {
      users: any[]
      speakerIds: string[]
      speakerKeys: string[]
      removedIds: string[]
      // { nUserID, nLevel } pairs from evt 8005.
      levels: Array<{ id: string; level: number }>
      // Kept apart from asn ids so the weaker signal can't override the stronger.
      nodeSpeakerIds: string[]
      sawNodeFrame: boolean
      // True when the frame was an active-speaker frame that named nobody, i.e.
      // silence. Distinguishable only because we learn the opcode at runtime.
      sawActiveSpeakerFrame: boolean
    }

    function emptyHarvest(): Harvest {
      return {
        users: [],
        speakerIds: [],
        speakerKeys: [],
        removedIds: [],
        levels: [],
        nodeSpeakerIds: [],
        sawNodeFrame: false,
        sawActiveSpeakerFrame: false
      }
    }

    // Roster deltas arrive as object maps keyed by id, not arrays.
    function idsOfCollection(value: any): string[] {
      const out: string[] = []
      if (Array.isArray(value)) {
        for (const item of value) {
          const id = idOf(item)
          if (id) out.push(id)
        }
      } else if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value as Record<string, any>)) {
          const id = idOf(item) ?? (/^\d+$/.test(key) ? key : undefined)
          if (id) out.push(id)
        }
      }
      return out
    }

    // Zoom nests JSON inside JSON strings (the worker envelope, and fields like
    // MeetingConfig within it), so the walk has to open them.
    function looksLikeJson(value: string): boolean {
      if (value.length < 2 || value.length > 1048576) return false
      const first = value.charCodeAt(0)
      if (first !== 123 && first !== 91) return false // '{' or '['
      // MeetingConfig is a huge blob sharing a frame with the roster; parsing it
      // unconditionally burned the budget before the walk reached the users.
      if (value.length > 65536) {
        return (
          value.indexOf('"dn') !== -1 ||
          value.indexOf('"users"') !== -1 ||
          value.indexOf('"participants"') !== -1
        )
      }
      return true
    }

    // Depth and budget capped — frames get large and this runs on every message.
    function harvest(node: any, out: Harvest, depth: number, budget: { n: number }): void {
      if (!node || typeof node !== "object" || depth > 8 || budget.n <= 0) return
      budget.n--

      if (Array.isArray(node)) {
        for (const item of node) harvest(item, out, depth + 1, budget)
        return
      }

      if (isUserRecord(node)) out.users.push(node)

      for (const key of Object.keys(node)) {
        const value = (node as any)[key]

        // Counted at any nesting level, for the diag line.
        if (key === "evt" && typeof value === "number") {
          const evtKey = String(value)
          diag.evtCounts[evtKey] = (diag.evtCounts[evtKey] || 0) + 1
        }

        if (SPEAKER_KEY_RE.test(key) || ASN_KEY_RE.test(key)) {
          const ids = speakerIdsFrom(value)
          if (ids.length) {
            out.speakerIds.push(...ids)
            out.speakerKeys.push(key)
          }
        } else if (NODE_KEY_RE.test(key)) {
          // Share channel: honour bStatus. bStatus === 0 means the node went
          // INACTIVE, which must not be reported as someone speaking.
          const active = node.bStatus === undefined || !!node.bStatus
          const ids = active ? speakerIdsFrom(value) : []
          if (ids.length) {
            out.nodeSpeakerIds.push(...ids)
            out.speakerKeys.push(key)
          } else {
            out.sawNodeFrame = true
          }
        }

        // Recorded even when zero — that's what proves it's a real varying level.
        if (key === "nLevel" && typeof value === "number") {
          const id = idOf(node)
          if (id) {
            out.levels.push({ id, level: value })
            if (out.speakerKeys.indexOf("nLevel") === -1) out.speakerKeys.push("nLevel")
          }
        }

        // A speaking flag on a user record attributes to that record's own id.
        if (SPEAKING_FLAG_RE.test(key) && value === true) {
          const id = idOf(node)
          if (id) {
            out.speakerIds.push(id)
            out.speakerKeys.push(key)
          }
        }

        if (SSRC_KEY_RE.test(key)) {
          const id = idOf(node)
          const ssrc =
            typeof value === "number" || typeof value === "string" ? String(value) : undefined
          if (id && ssrc && ssrc !== "0") ssrcToUserId.set(ssrc, id)
        }

        // body.remove is an object map keyed by id, not an array.
        if (key === "remove") {
          out.removedIds.push(...idsOfCollection(value))
        }

        if (value && typeof value === "object") {
          harvest(value, out, depth + 1, budget)
        } else if (typeof value === "string" && looksLikeJson(value)) {
          try {
            harvest(JSON.parse(value), out, depth + 1, budget)
          } catch {
            // not actually JSON — ignore
          }
        }
      }
    }

    function applyHarvest(result: Harvest, source: "roster" | "audio"): void {
      let changed = false

      for (const record of result.users) {
        const userId = idOf(record)
        const displayName = nameOf(record)
        if (!userId || !displayName) continue
        const entry = {
          userId,
          displayName,
          status: 1,
          isHost: record.isHost === true || record.bHost === true,
          // bBotUser is the roster's own flag for us.
          isCurrentUser:
            record.bBotUser === true || record.isMyself === true || record.bMyself === true
        }
        const previous = participantsById.get(userId)
        if (!previous || JSON.stringify(previous) !== JSON.stringify(entry)) changed = true
        participantsById.set(userId, entry)
      }

      for (const userId of result.removedIds) {
        if (participantsById.delete(userId)) changed = true
        userLevels.delete(userId)
        nodeSpeakerIds.delete(userId)
        if (activeSpeakerIds.has(userId)) {
          activeSpeakerIds.delete(userId)
          changed = true
        }
      }

      for (const sample of result.levels) {
        lastLevelSeq = frameSeq
        userLevels.set(sample.id, { level: sample.level, at: Date.now() })
        if (sample.level === 0) sawLevelZero = true
        if (sample.level > 0) sawLevelPositive = true
        diag.levelMin = diag.levelMin < 0 ? sample.level : Math.min(diag.levelMin, sample.level)
        diag.levelMax = Math.max(diag.levelMax, sample.level)
        changed = true
      }
      diag.levelsAuthoritative = sawLevelZero && sawLevelPositive

      // Named nobody = silence; clear rather than letting the last speaker latch.
      if (result.sawActiveSpeakerFrame && !result.speakerIds.length) {
        lastActiveSpeakerSeq = frameSeq
        if (activeSpeakerIds.size) {
          activeSpeakerIds = new Set()
          changed = true
        }
      }

      if (result.nodeSpeakerIds.length || result.sawNodeFrame) {
        const next = new Set(result.nodeSpeakerIds)
        const sameSet =
          next.size === nodeSpeakerIds.size &&
          Array.from(next).every((id) => nodeSpeakerIds.has(id))
        if (!sameSet) {
          nodeSpeakerIds = next
          if (!sawAsn) changed = true
        }
      }

      if (result.speakerIds.length) {
        sawAsn = true
        const next = new Set(result.speakerIds)
        const sameSet =
          next.size === activeSpeakerIds.size &&
          Array.from(next).every((id) => activeSpeakerIds.has(id))
        if (!sameSet) {
          activeSpeakerIds = next
          changed = true
        }
        if (!firstSpeakerAt) firstSpeakerAt = Date.now()
        if (result.speakerKeys.some((k) => k !== "nLevel")) lastActiveSpeakerSeq = frameSeq
        diag.speakerFrames++
        for (const key of result.speakerKeys) {
          if (diag.speakerKeys.indexOf(key) === -1 && diag.speakerKeys.length < 12) {
            diag.speakerKeys.push(key)
          }
        }
      }

      if (result.users.length) {
        diag.rosterFrames++
        if (!firstRosterAt) firstRosterAt = Date.now()
      }
      diag.rosterParticipants = participantsById.size

      if (changed) broadcastSpeakerUpdate(source)
    }

    // Unwrap the worker envelope explicitly so we reason about the real frame.
    function unwrapEnvelope(frame: any): any {
      if (frame && typeof frame.data === "string" && looksLikeJson(frame.data)) {
        try {
          return JSON.parse(frame.data)
        } catch {
          return frame
        }
      }
      return frame
    }

    // Key paths only, never values, so this is PII-free. Two samples per opcode is
    // enough to learn the schema if Zoom renames or renumbers something.
    const SHAPE_SAMPLES_PER_EVT = 2
    const SHAPE_MAX_PATHS = 60
    const shapeSampleCount: Record<string, number> = {}

    function collectShape(node: any, prefix: string, out: string[], depth: number): void {
      if (out.length >= SHAPE_MAX_PATHS || depth > 5) return
      if (Array.isArray(node)) {
        if (node.length) collectShape(node[0], `${prefix}[]`, out, depth + 1)
        return
      }
      if (!node || typeof node !== "object") return
      for (const key of Object.keys(node)) {
        if (out.length >= SHAPE_MAX_PATHS) return
        const value = (node as any)[key]
        const path = prefix ? `${prefix}.${key}` : key
        if (value && typeof value === "object") {
          collectShape(value, path, out, depth + 1)
        } else if (typeof value === "string" && looksLikeJson(value)) {
          try {
            collectShape(JSON.parse(value), path, out, depth + 1)
          } catch {
            if (out.indexOf(`${path}:string`) === -1) out.push(`${path}:string`)
          }
        } else {
          const entry = `${path}:${typeof value}`
          if (out.indexOf(entry) === -1) out.push(entry)
        }
      }
    }

    function recordShape(evt: number, frame: any): void {
      const key = String(evt)
      const seen = shapeSampleCount[key] || 0
      if (seen >= SHAPE_SAMPLES_PER_EVT) return
      if (Object.keys(diag.evtShapes).length > 40 && !diag.evtShapes[key]) return
      shapeSampleCount[key] = seen + 1
      const paths: string[] = diag.evtShapes[key] ? diag.evtShapes[key].slice() : []
      collectShape(frame, "", paths, 0)
      diag.evtShapes[key] = paths.slice(0, SHAPE_MAX_PATHS)
    }

    function handleDecodedFrame(rawFrame: any): void {
      if (!rawFrame || typeof rawFrame !== "object") return
      const frame = unwrapEnvelope(rawFrame)
      if (!frame || typeof frame !== "object") return

      diag.jsonFrames++
      frameSeq++
      if (typeof frame.evt === "number") recordShape(frame.evt, frame)

      const result: Harvest = emptyHarvest()
      harvest(frame, result, 0, { n: 20000 })

      // Only the audio channel sets this. Letting the share channel do it latched
      // the wrong opcode, so empty 12033 frames failed the silence test.
      const namedSpeaker = result.speakerIds.length > 0
      if (typeof frame.evt === "number") {
        if (namedSpeaker) {
          activeSpeakerEvt = frame.evt
          diag.activeSpeakerEvt = frame.evt
        } else if (activeSpeakerEvt !== null && frame.evt === activeSpeakerEvt) {
          result.sawActiveSpeakerFrame = true
        }
      }

      // Diagnostics keep accruing after stop; only the speaker pipeline is silenced.
      if ((window as any).__zoomNetworkInterceptorStopped) return

      const hasAudioSignal =
        result.speakerIds.length > 0 ||
        result.levels.length > 0 ||
        result.sawActiveSpeakerFrame ||
        result.nodeSpeakerIds.length > 0 ||
        result.sawNodeFrame
      if (result.users.length || result.removedIds.length || hasAudioSignal) {
        applyHarvest(result, hasAudioSignal ? "audio" : "roster")
      }
    }

    // Zoom sends signaling as JSON text; media/worker frames are binary and may
    // wrap JSON in a header. Scan for the first '[' or '{' before giving up.
    function decodeFrame(data: any): void {
      try {
        if (typeof data === "string") {
          if (data.indexOf("{") === -1 && data.indexOf("[") === -1) return
          try {
            handleDecodedFrame(JSON.parse(data))
          } catch {
            const start = data.search(/[[{]/)
            if (start > 0) {
              try {
                handleDecodedFrame(JSON.parse(data.slice(start)))
              } catch {
                // not JSON — ignore
              }
            }
          }
          return
        }

        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
          const view = data as ArrayBufferView
          const bytes =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
          // Signaling frames are small; skip media payloads outright.
          if (bytes.length === 0 || bytes.length > 262144) return
          for (let i = 0; i < bytes.length && i < 64; i++) {
            if (bytes[i] === 91 || bytes[i] === 123) {
              try {
                const text = new TextDecoder().decode(bytes.slice(i))
                handleDecodedFrame(JSON.parse(text))
              } catch {
                // keep scanning for a later JSON start
                continue
              }
              return
            }
          }
          return
        }

        if (typeof Blob !== "undefined" && data instanceof Blob) {
          if (data.size > 262144) return
          data
            .text()
            .then((text: string) => decodeFrame(text))
            .catch(() => {})
          return
        }

        // Workers post structured-clone objects — feed them straight in.
        if (data && typeof data === "object") handleDecodedFrame(data)
      } catch {
        // never let a malformed frame escape into Zoom's own handlers
      }
    }

    // ===== PER-SPEAKER (CSRC) =====

    function addReceiver(receiver: RTCRtpReceiver | undefined): void {
      if (!receiver || receiverMap.has(receiver)) return
      receiverMap.set(receiver, false)
      diag.receiversAdded++
      debug("➕ audio receiver added")
    }

    function pollReceivers(): void {
      if ((window as any).__zoomNetworkInterceptorStopped) return

      const speaking = new Set<string>()
      let mappedThisPoll = false
      const now = Date.now()

      for (const [receiver] of receiverMap) {
        let sources: any[] = []
        try {
          sources = (receiver as any).getContributingSources?.() || []
        } catch {
          sources = []
        }
        if (receiver.track?.readyState === "ended") {
          receiverMap.set(receiver, false)
          continue
        }
        if (sources.length > 0) receiverMap.set(receiver, true)

        for (const source of sources) {
          if (now - source.timestamp > 200) continue
          const userId = ssrcToUserId.get(String(source.source))
          if (!userId) continue
          mappedThisPoll = true
          // audioLevel is 0..1; treat anything above the noise floor as speech.
          // Some engines leave it undefined — a recent contributing source is
          // then the only available evidence.
          const level = typeof source.audioLevel === "number" ? source.audioLevel : undefined
          if (level === undefined || level > 0.005) speaking.add(userId)
        }
      }

      if (mappedThisPoll) {
        hasObservedCsrcMapping = true
        diag.csrcMapped++
      }
      const hasActiveReceiver = Array.from(receiverMap.values()).some(Boolean)
      if (!hasActiveReceiver) hasObservedCsrcMapping = false
      csrcAvailable = hasObservedCsrcMapping

      if (csrcAvailable) {
        const sameSet =
          speaking.size === csrcSpeakingIds.size &&
          Array.from(speaking).every((id) => csrcSpeakingIds.has(id))
        csrcSpeakingIds = speaking
        if (!sameSet) broadcastSpeakerUpdate("audio")
      }

      diag.csrcAvailable = csrcAvailable
      diag.queueLen = ((window as any).__zoomSpeakerQueue || []).length

      // Hand back to the DOM observer if the network path isn't producing: either
      // the roster decoded but nobody ever speaks, or nothing decoded at all.
      if (!healthReported && !csrcAvailable && now - interceptorStartedAt > SPEAKER_SIGNAL_TIMEOUT_MS) {
        const noSpeakerSignal = !!firstRosterAt && !firstSpeakerAt
        const nothingDecoded = !firstRosterAt && !firstSpeakerAt
        if (noSpeakerSignal || nothingDecoded) {
          healthReported = true
          console.warn(
            `${LOG} ⚠️ ${nothingDecoded ? "no roster or speaker signal decoded" : "roster decoded but no active-speaker signal"} — requesting fallback`
          )
          enqueue({
            users: [],
            timestamp: now,
            source: "network_interception_failed",
            failure: {
              trackId: "zoom-signaling",
              reason: "timeout",
              trackState: `roster=${participantsById.size} frames=${diag.jsonFrames} speakerFrames=${diag.speakerFrames}`,
              timestamp: now
            }
          })
        }
      }
    }

    // ===== BROADCAST TO NODE =====

    function enqueue(payload: any): void {
      try {
        const queue = (window as any).__zoomSpeakerQueue as any[]
        if (queue.length > 500) queue.splice(0, queue.length - 500)
        queue.push(payload)
        diag.queueLen = queue.length
      } catch {
        // ignore
      }
    }

    function broadcastSpeakerUpdate(source: "roster" | "audio"): void {
      if ((window as any).__zoomNetworkInterceptorStopped) return

      // Best available: CSRC (absent on Zoom web), then per-user levels once
      // nLevel proves itself, then the active-speaker nodes.
      let speaking: Set<string>
      if (csrcAvailable) {
        speaking = csrcSpeakingIds
      } else if (sawLevelZero && sawLevelPositive && lastLevelSeq >= lastActiveSpeakerSeq) {
        const now = Date.now()
        speaking = new Set<string>()
        for (const [userId, sample] of userLevels) {
          if (now - sample.at <= LEVEL_TTL_MS && sample.level > 0) speaking.add(userId)
        }
        // Stale levels tell us nothing; prefer the active speaker over silence.
        if (!speaking.size && activeSpeakerIds.size) speaking = activeSpeakerIds
      } else if (sawAsn) {
        speaking = activeSpeakerIds
      } else {
        // No audio signal yet — better than reporting nobody.
        speaking = nodeSpeakerIds.size ? nodeSpeakerIds : activeSpeakerIds
      }

      const users = Array.from(participantsById.values()).map((p) => ({
        deviceId: p.userId,
        name: p.displayName || "Unknown",
        isCurrentUser: p.isCurrentUser === true,
        isSpeaking: speaking.has(p.userId),
        status: p.status,
        isHost: p.isHost === true,
        audioLevel: 0,
        fullName: p.displayName,
        displayName: p.displayName,
        profilePicture: undefined
      }))

      // Only enqueue on change, to keep the pipeline quiet in steady state.
      const key = users
        .map((u) => `${u.deviceId}:${u.isSpeaking ? 1 : 0}`)
        .sort()
        .join("|")
      if (key === lastSpeakingLogKey) return
      lastSpeakingLogKey = key

      enqueue({ users, timestamp: Date.now(), source })
      diag.broadcasts++
    }

    // ===== INTERCEPTORS =====

    // WebSocket proxy — Zoom's RWG signaling rides here as JSON text frames.
    {
      const OriginalWebSocket = (window as any).WebSocket
      const ProxiedWebSocket = function (this: any, url: string, protocols?: any) {
        const ws =
          protocols !== undefined
            ? new OriginalWebSocket(url, protocols)
            : new OriginalWebSocket(url)
        diag.wsCreated++
        try {
          ws.addEventListener("message", (event: any) => {
            diag.wsFrames++
            decodeFrame(event.data)
          })
        } catch {
          // ignore
        }
        return ws
      } as any
      ProxiedWebSocket.prototype = OriginalWebSocket.prototype
      ProxiedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING
      ProxiedWebSocket.OPEN = OriginalWebSocket.OPEN
      ProxiedWebSocket.CLOSING = OriginalWebSocket.CLOSING
      ProxiedWebSocket.CLOSED = OriginalWebSocket.CLOSED
      ;(window as any).WebSocket = ProxiedWebSocket
    }

    // Worker proxy — observe only. Zoom's workers come from blob: URLs, and
    // rewriting one to importScripts() the original is blocked by CSP and stops the
    // client booting. Construct with the original url; just read what it posts back.
    {
      const OriginalWorker = (window as any).Worker
      if (OriginalWorker) {
        const ProxiedWorker = function (this: any, url: string | URL, options?: any) {
          const worker = new OriginalWorker(url, options)
          try {
            worker.addEventListener("message", (event: any) => {
              diag.workerMsgs++
              decodeFrame(event.data)
            })
          } catch {
            // ignore
          }
          return worker
        } as any
        ProxiedWorker.prototype = OriginalWorker.prototype
        ;(window as any).Worker = ProxiedWorker
      }
    }

    // RTCPeerConnection proxy — audio receivers (CSRC) and any data channel Zoom
    // uses for in-band signaling.
    {
      const OriginalRTCPeerConnection = (window as any).RTCPeerConnection
      if (OriginalRTCPeerConnection) {
        const ProxiedRTCPeerConnection = function (this: any, ...args: any[]) {
          const pc = Reflect.construct(OriginalRTCPeerConnection, args) as RTCPeerConnection
          diag.rtcCreated++

          pc.addEventListener("track", (event) => {
            if (event.track?.kind === "audio") addReceiver(event.receiver)
          })
          pc.addEventListener("datachannel", (event) => {
            try {
              event.channel.addEventListener("message", (msg: any) => decodeFrame(msg.data))
            } catch {
              // ignore
            }
          })

          const originalCreateDataChannel = pc.createDataChannel.bind(pc)
          pc.createDataChannel = (label, options) => {
            const channel = originalCreateDataChannel(label, options)
            try {
              channel.addEventListener("message", (msg: any) => decodeFrame(msg.data))
            } catch {
              // ignore
            }
            return channel
          }

          return pc
        } as any
        ProxiedRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype
        if (typeof OriginalRTCPeerConnection.generateCertificate === "function") {
          ProxiedRTCPeerConnection.generateCertificate = (...a: any[]) =>
            OriginalRTCPeerConnection.generateCertificate(...a)
        }
        ;(window as any).RTCPeerConnection = ProxiedRTCPeerConnection
      }
    }

    const pollInterval = setInterval(pollReceivers, 100)
    ;(window as any).__zoomStopNetworkInterception = () => {
      ;(window as any).__zoomNetworkInterceptorStopped = true
      try {
        clearInterval(pollInterval)
      } catch {
        // ignore
      }
    }
  } catch (error) {
    console.error("[NetworkInterceptor][Zoom] ❌ Initialization error:", error)
  }
}
