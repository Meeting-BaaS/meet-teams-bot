// Browser-side bundle for Teams network speaker detection. Stringified and
// injected via addInitScript, so it must be self-contained (only window.pako +
// browser APIs). Three signals:
//   1. Roster:      window.WebSocket "3:::" rosterUpdate frames (base64 + zlib).
//   2. Dominant:    "main-channel" data channel dsh messages → speaking stream.
//   3. Per-speaker: getContributingSources() (CSRC) resolved via msteamscalling.
// Emits via window.onNetworkSpeakerUpdate() — same bridge/sink as Meet.

/** biome-ignore-all lint/suspicious/noExplicitAny: browser-side bundle over untyped Teams/WebRTC internals. */

export function teamsBrowserInterceptionLogic() {
  try {
    if ((window as any).__teamsNetworkInterceptorInitialized === true) {
      console.warn("[Teams NetworkInterceptor] ⚠️ Already initialized, skipping duplicate")
      return
    }
    ;(window as any).__teamsNetworkInterceptorInitialized = true
    ;(window as any).__teamsNetworkInterceptorStopped = false

    // "[NetworkInterceptor]" prefix so page-logger surfaces warn/error by
    // default (no LOG_LEVEL=debug needed); "[Teams]" distinguishes from Meet.
    const LOG = "[NetworkInterceptor][Teams]"
    const DEBUG = false
    const debug = (...args: any[]) => {
      if (DEBUG) console.log(LOG, ...args)
    }

    if (!(window as any).pako) {
      console.error(`${LOG} ❌ pako not loaded, cannot decode roster frames`)
    }

    // ===== STATE =====

    // deviceId (roster details.id) → participant record
    const participantsByDeviceId = new Map<string, any>()
    // Speaker updates reach Node by being pushed onto this queue, which Node drains
    // via page.evaluate (the interceptor's context cannot see exposeFunction bindings
    // under CloakBrowser).
    ;(window as any).__teamsSpeakerQueue = (window as any).__teamsSpeakerQueue || []
    // virtual stream id (string) → { participantId, displayName, type, isAudio, isActive }
    const virtualStreams = new Map<string, any>()
    // current dominant speaker's audio virtual stream id (from "dsh")
    let dominantSpeakerStreamId: string | null = null
    // when true, CSRC is authoritative; when false, fall back to dsh
    let csrcAvailable = false
    // Watchdog state: when the audio sub-path (dsh + CSRC) never signals
    // despite an active meeting, the hooks are dead (PC escaped the proxy or
    // Teams session has no main-channel) — tell the Node side to fall back.
    let lastAudioPathSignalAt = 0
    let audioPathDeadReported = false
    // Watchdog baseline: set when the Node callback binds (post-admission), NOT
    // at install — the bot can sit 60s+ in the waiting room, which would burn
    // the whole grace window before the in-call audio path ever runs.
    let callbackBoundAt = 0
    // Instrumentation to root-cause a blind audio path: how many of each hook
    // actually fired. Reported via diag() when the watchdog trips.
    const instr = {
      pcConstructed: 0,
      dataChannels: 0,
      mainChannelAttached: 0,
      audioReceivers: 0,
      dshEvents: 0,
      wsRosterFrames: 0
    }

    // Route a diagnostic line to the Node logger. CloakBrowser surfaces
    // neither page.on('console') nor exposeFunction bindings in this context,
    // so lines are queued and drained by the Node-side speaker poll; the
    // exposeFunction bridge is kept as a best-effort secondary path.
    ;(window as any).__teamsDiagQueue = (window as any).__teamsDiagQueue || []
    function diag(message: string): void {
      try {
        const dq = (window as any).__teamsDiagQueue as string[]
        if (dq.length > 200) dq.splice(0, dq.length - 200)
        dq.push(message)
      } catch {
        /* ignore */
      }
      try {
        const fn = (window as any).onNetworkInterceptorDiag
        if (typeof fn === "function") fn(message)
      } catch {
        /* bridge not bound yet */
      }
    }
    // CSRC becomes authoritative only after a source maps to a participant.
    let hasObservedCsrcMapping = false

    // receiver → isActive
    const receiverMap = new Map<RTCRtpReceiver, boolean>()
    // participantId → ParticipantSpeakingStateMachine
    const speakingStateMachines = new Map<string, any>()
    // last logged speaking set, to log only on change
    let lastSpeakingLogKey = ""

    // ===== TEAMS INTERNAL CALLING SDK (best-effort) =====

    function getActiveCall(): any {
      try {
        const observable = (window as any).callingDebug?.observableCall
        if (observable) return observable
        const calling = (window as any).msteamscalling?.deref?.()
        const call = calling?.callingService?.getActiveCall?.()
        if (call) return call
      } catch {
        // Teams internals not available — fall back to dominant-speaker path.
      }
      return null
    }

    function getCurrentUserId(): string | undefined {
      const call = getActiveCall()
      return call?.callerMri
    }

    // Map CSRC sources → speaking participant ids via participant.hasAudioSource().
    function getSpeakingParticipantIds(contributingSources: any[]): Set<string> {
      const speaking = new Set<string>()
      const call = getActiveCall()
      if (!call?.participants) return speaking
      call.participants.forEach((participant: any) => {
        if (!participant?.id) return
        const matches = contributingSources.some((cs) => {
          try {
            return participant.hasAudioSource(cs.source)
          } catch {
            return false
          }
        })
        if (matches) speaking.add(participant.id)
      })
      return speaking
    }

    // ===== ROSTER (WebSocket) =====

    function decodeWebSocketBody(encodedData: string): any {
      const byteArray = Uint8Array.from(atob(encodedData), (c) => c.charCodeAt(0))
      return JSON.parse((window as any).pako.inflate(byteArray, { to: "string" }))
    }

    function syncVirtualStreamsFromParticipant(participant: any): boolean {
      const participantId = participant?.details?.id
      if (!participantId) return false

      let mappingChanged = false
      if (participant.state === "inactive") {
        for (const [streamId, vs] of virtualStreams) {
          if (vs.participantId === participantId) {
            virtualStreams.delete(streamId)
            mappingChanged = true
          }
        }
        return mappingChanged
      }

      const mediaStreams: any[] = []
      if (participant.endpoints) {
        for (const endpoint of Object.values<any>(participant.endpoints)) {
          if (endpoint?.call && Array.isArray(endpoint.call.mediaStreams)) {
            mediaStreams.push(...endpoint.call.mediaStreams)
          }
        }
      }

      for (const mediaStream of mediaStreams) {
        if (mediaStream?.sourceId == null) continue
        const prevMapping = virtualStreams.get(mediaStream.sourceId.toString())
        if (!prevMapping || prevMapping.participantId !== participantId) {
          mappingChanged = true
        }
        const isActive =
          mediaStream.direction === "sendrecv" || mediaStream.direction === "sendonly"
        virtualStreams.set(mediaStream.sourceId.toString(), {
          sourceId: mediaStream.sourceId.toString(),
          participantId,
          displayName: participant.details?.displayName,
          type: mediaStream.type,
          isAudio: mediaStream.type === "audio",
          isActive
        })
      }
      return mappingChanged
    }

    // Pull a display name / stable id across BOTH the WebSocket roster shape
    // (participant.details.{displayName,id}) and the HTTP snapshot shapes, which nest
    // the identity differently.
    function rosterName(pp: any): string | undefined {
      return (
        pp?.details?.displayName ||
        pp?.displayName ||
        pp?.identity?.displayName ||
        pp?.user?.displayName ||
        pp?.participant?.displayName
      )
    }
    function rosterId(pp: any): string | undefined {
      return (
        pp?.details?.id ||
        pp?.id ||
        pp?.mri ||
        pp?.participantId ||
        pp?.endpointId ||
        pp?.identity?.id
      )
    }

    // Shared by the WebSocket delta path AND the HTTP snapshot path.
    function applyParticipants(rawParticipants: any[]): void {
      const participants = rawParticipants.filter((pp) => rosterName(pp))
      const currentUserId = getCurrentUserId()
      let changed = false
      for (const participant of participants) {
        const deviceId = rosterId(participant)
        if (!deviceId) continue
        const record = {
          deviceId,
          displayName: rosterName(participant),
          status: participant.state === "active" ? 1 : 6,
          isHost: participant.meetingRole === "organizer",
          isCurrentUser: !!currentUserId && deviceId === currentUserId
        }
        const previous = participantsByDeviceId.get(deviceId)
        if (!previous || JSON.stringify(previous) !== JSON.stringify(record)) changed = true
        participantsByDeviceId.set(deviceId, record)
        // A stream->participant mapping change must also rebroadcast: a dsh
        // dominant-speaker event that arrived BEFORE the mapping resolves
        // stays unattributed until the next dsh otherwise.
        if (syncVirtualStreamsFromParticipant(participant)) changed = true
      }
      if (changed) broadcastSpeakerUpdate("roster")
    }

    function handleRosterUpdate(eventDataObject: any): void {
      try {
        const decodedBody = decodeWebSocketBody(eventDataObject.body)
        const rawParticipants = Object.values<any>(decodedBody.participants || {})
        applyParticipants(rawParticipants)
      } catch (error) {
        console.error(`${LOG} ❌ Error handling roster update:`, error)
      }
    }

    // ===== ROSTER (HTTP snapshot) =====
    // The trouter WebSocket only delivers roster DELTAS to this late-connecting client
    // (see the "trouter.message_loss" frames). Anyone already in the meeting when the
    // bot joins is recovered by the client via an HTTP snapshot, NOT the socket — so
    // intercept those responses and merge them into the same participant map.
    // Teams roster maps are objects keyed by MRI (e.g. { "8:orgid:...": {...} }),
    // NOT arrays. Convert to an array and inject the MRI key as an id fallback.
    function participantsToArray(pm: any): any[] | null {
      if (!pm) return null
      if (Array.isArray(pm)) return pm
      if (typeof pm === "object") {
        return Object.entries(pm as Record<string, any>).map(([mri, pv]) =>
          pv && typeof pv === "object" ? { mri, ...pv } : pv
        )
      }
      return null
    }

    function tryHttpRoster(url: string, text: string): void {
      try {
        if (!text || text.indexOf("displayName") === -1) return
        const body = JSON.parse(text)
        // The HTTP snapshot nests the roster as { roster: { participants: {mri: {...}} } };
        // other endpoints use top-level participants / value. Handle all as object-or-array.
        const raw =
          participantsToArray(body?.roster?.participants) ||
          participantsToArray(body?.participants) ||
          participantsToArray(body?.value) ||
          participantsToArray(body?.participants?.value) ||
          (Array.isArray(body) ? body : null)
        if (raw && raw.length) {
          applyParticipants(raw)
        }
      } catch {
        // not JSON — ignore
      }
    }

    // ===== DOMINANT SPEAKER (main-channel data channel) =====

    function setDominantSpeakerStreamId(streamId: number | string): void {
      dominantSpeakerStreamId = streamId.toString()
    }

    function getDominantSpeakerParticipantId(): string | null {
      if (!dominantSpeakerStreamId) return null
      return virtualStreams.get(dominantSpeakerStreamId)?.participantId ?? null
    }

    // main-channel payloads are binary with embedded JSON; parse from the first
    // '[' (91) or '{' (123) byte.
    function decodeMainChannelData(data: any): any {
      if (typeof data === "string") {
        try {
          return JSON.parse(data)
        } catch {
          return undefined
        }
      }
      const decoded = new Uint8Array(data)
      for (let i = 0; i < decoded.length; i++) {
        if (decoded[i] === 91 || decoded[i] === 123) {
          const candidate = new TextDecoder().decode(decoded.slice(i))
          try {
            return JSON.parse(candidate)
          } catch (e) {
            if (e instanceof SyntaxError) continue
            return undefined
          }
        }
      }
      return undefined
    }

    function handleMainChannelEvent(event: any): void {
      try {
        const parsed = decodeMainChannelData(event.data)
        if (!parsed || !Array.isArray(parsed)) return
        for (const item of parsed) {
          if (item?.type === "dsh") {
            instr.dshEvents++
            const newDominantStreamId = item.history?.[0]
            if (newDominantStreamId != null) {
              lastAudioPathSignalAt = Date.now()
              setDominantSpeakerStreamId(newDominantStreamId)
              debug("🗣️ dsh dominant stream", newDominantStreamId)
              // only emit here when CSRC isn't the authoritative source
              if (!csrcAvailable) broadcastSpeakerUpdate("audio")
            }
          }
        }
      } catch (error) {
        console.error(`${LOG} ❌ Error handling main-channel event:`, error)
      }
    }

    // ===== PER-PARTICIPANT SPEAKING STATE (CSRC polling) =====

    // Smooths 100ms samples: SPEAKING when a majority of the last 5 are active.
    // addSample returns true on a state transition.
    class ParticipantSpeakingStateMachine {
      participantId: string
      state: "SPEAKING" | "NOT_SPEAKING" = "NOT_SPEAKING"
      samples: { isSpeaking: boolean; timestamp: number }[] = []

      constructor(participantId: string) {
        this.participantId = participantId
      }

      addSample(sample: { isSpeaking: boolean; timestamp: number }): boolean {
        this.samples.push(sample)
        if (this.samples.length > 10) this.samples.shift()

        const lastFive = this.samples.slice(-5)
        if (lastFive.length < 5) return false

        const majoritySpeaking = lastFive.filter((s) => s.isSpeaking).length > 3
        const previousState = this.state
        this.state = majoritySpeaking ? "SPEAKING" : "NOT_SPEAKING"
        return previousState !== this.state
      }
    }

    function getCsrcSpeakingIds(): Set<string> {
      const speaking = new Set<string>()
      for (const [participantId, machine] of speakingStateMachines) {
        if (machine.state === "SPEAKING") speaking.add(participantId)
      }
      return speaking
    }

    function addReceiver(receiver: RTCRtpReceiver | undefined): void {
      if (!receiver || receiverMap.has(receiver)) return
      receiverMap.set(receiver, false)
      instr.audioReceivers++
      debug("➕ audio receiver added")
    }

    function pollReceivers(): void {
      if ((window as any).__teamsNetworkInterceptorStopped) return

      const speakingParticipantIds = new Set<string>()
      let mappedCsrcThisPoll = false
      const now = Date.now()

      for (const [receiver, isActive] of receiverMap) {
        let contributingSources: any[] = []
        try {
          contributingSources = receiver.getContributingSources() || []
        } catch {
          contributingSources = []
        }

        if (contributingSources.length > 0 && !isActive) receiverMap.set(receiver, true)
        if (receiver.track?.readyState === "ended") {
          receiverMap.set(receiver, false)
          continue
        }

        const recent = contributingSources.filter((cs) => now - cs.timestamp <= 50)
        const mappedIds = getSpeakingParticipantIds(recent)
        if (mappedIds.size > 0) {
          mappedCsrcThisPoll = true
          lastAudioPathSignalAt = Date.now()
        }
        for (const id of mappedIds) speakingParticipantIds.add(id)
      }

      // Do not let merely seeing Teams SDK participants disable the working
      // dsh path. CSRC is trusted only after a real source-to-participant mapping.
      if (mappedCsrcThisPoll) hasObservedCsrcMapping = true
      const hasActiveReceiver = Array.from(receiverMap.values()).some(Boolean)
      if (!hasActiveReceiver) hasObservedCsrcMapping = false
      csrcAvailable = hasObservedCsrcMapping

      // Ensure a state machine exists for every participant we've seen speaking.
      for (const participantId of speakingParticipantIds) {
        if (!speakingStateMachines.has(participantId)) {
          speakingStateMachines.set(
            participantId,
            new ParticipantSpeakingStateMachine(participantId)
          )
        }
      }

      let changed = false
      for (const [participantId, machine] of speakingStateMachines) {
        const transitioned = machine.addSample({
          isSpeaking: speakingParticipantIds.has(participantId),
          timestamp: now
        })
        if (transitioned) changed = true
      }

      if (csrcAvailable && changed) broadcastSpeakerUpdate("audio")
    }

    // ===== BROADCAST TO NODE =====

    function broadcastSpeakerUpdate(source: "roster" | "audio"): void {
      if ((window as any).__teamsNetworkInterceptorStopped) return

      // CSRC when available (silence == nobody), else dsh dominant speaker.
      let speaking: Set<string>
      if (csrcAvailable) {
        speaking = getCsrcSpeakingIds()
      } else {
        const dominant = getDominantSpeakerParticipantId()
        speaking = dominant ? new Set([dominant]) : new Set()
      }

      const rawUsers = Array.from(participantsByDeviceId.values()).map((p) => ({
        deviceId: p.deviceId,
        name: p.displayName || "Unknown",
        isCurrentUser: p.isCurrentUser === true,
        isSpeaking: speaking.has(p.deviceId),
        status: p.status,
        isHost: p.isHost === true,
        audioLevel: 0,
        fullName: p.displayName,
        displayName: p.displayName,
        profilePicture: undefined
      }))

      // Dedupe by AAD identity. The same account can appear under more than one roster
      // entry — the bot showed up under both its directory name and its in-call name
      // (different endpoint ids), surfacing as a phantom extra speaker. Collapse rows
      // that share an org identity (8:orgid:<oid>); OR their speaking/host/self flags.
      // Guests/anonymous participants have no orgid, so they key on their full id and
      // are NEVER merged — anonymous meetings behave exactly as before.
      const identityKey = (deviceId: string): string => {
        const m =
          typeof deviceId === "string" ? deviceId.match(/8:orgid:([0-9a-fA-F-]{36})/) : null
        return m ? `orgid:${m[1].toLowerCase()}` : String(deviceId)
      }
      const byIdentity = new Map<string, (typeof rawUsers)[number]>()
      for (const u of rawUsers) {
        const key = identityKey(u.deviceId)
        const prev = byIdentity.get(key)
        if (!prev) {
          byIdentity.set(key, u)
        } else {
          prev.isSpeaking = prev.isSpeaking || u.isSpeaking
          prev.isCurrentUser = prev.isCurrentUser || u.isCurrentUser
          prev.isHost = prev.isHost || u.isHost
          if (u.status === 1) prev.status = 1
          if ((prev.name === "Unknown" || !prev.displayName) && u.displayName) {
            prev.name = u.displayName
            prev.displayName = u.displayName
            prev.fullName = u.displayName
          }
        }
      }
      const users = Array.from(byIdentity.values())

      // Only enqueue when the roster or speaking set actually changed — keeps the
      // pipeline (and logs) quiet during steady state.
      const key = users
        .map((u) => `${u.deviceId}:${u.isSpeaking ? 1 : 0}`)
        .sort()
        .join("|")
      if (key === lastSpeakingLogKey) return
      lastSpeakingLogKey = key

      try {
        const q = (window as any).__teamsSpeakerQueue as any[]
        if (q.length > 500) q.splice(0, q.length - 500)
        q.push({ users, timestamp: Date.now(), source })
      } catch {
        // ignore
      }
    }

    // ===== INTERCEPTORS =====

    // WebSocket proxy — Teams signaling rides text frames prefixed "3:::".
    {
      const OriginalWebSocket = (window as any).WebSocket
      const ProxiedWebSocket = function (this: any, url: string, protocols?: any) {
        const ws = new OriginalWebSocket(url, protocols)
        ws.addEventListener("message", (event: any) => {
          try {
            const data = event.data
            if (typeof data !== "string" || !data.startsWith("3:::")) return
            const eventDataObject = JSON.parse(data.slice(4))
            const eventUrl = eventDataObject?.url
            if (typeof eventUrl !== "string") return
            // Match any roster-bearing signaling URL (initial snapshot + deltas).
            if (eventUrl.toLowerCase().includes("roster")) {
              handleRosterUpdate(eventDataObject)
            }
          } catch {
            // Non-JSON / non-signaling frame — ignore.
          }
        })
        return ws
      } as any
      ProxiedWebSocket.prototype = OriginalWebSocket.prototype
      ProxiedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING
      ProxiedWebSocket.OPEN = OriginalWebSocket.OPEN
      ProxiedWebSocket.CLOSING = OriginalWebSocket.CLOSING
      ProxiedWebSocket.CLOSED = OriginalWebSocket.CLOSED
      ;(window as any).WebSocket = ProxiedWebSocket
    }

    // HTTP roster interceptor (fetch + XHR). Feeds tryHttpRoster so the full roster
    // (participants already present before the bot joined) is recovered from the
    // client's HTTP snapshot, not just the socket deltas. Wrap-and-forward only — the
    // original response is returned untouched; we read a clone.
    {
      const rosterUrlRe = /callagent|conversation|roster|participant|calling|skype|flightproxy|\/csa\/|\/api\//i
      try {
        const origFetch = (window.fetch as any).bind(window)
        ;(window as any).fetch = function (...args: any[]) {
          const promise = origFetch(...args)
          try {
            const req = args[0]
            const url = typeof req === "string" ? req : req?.url
            if (url && rosterUrlRe.test(url)) {
              promise
                .then((resp: any) => {
                  try {
                    resp
                      .clone()
                      .text()
                      .then((t: string) => tryHttpRoster(url, t))
                      .catch(() => {})
                  } catch {}
                  return resp
                })
                .catch(() => {})
            }
          } catch {}
          return promise
        }
      } catch {
        // ignore
      }
      try {
        const origOpen = XMLHttpRequest.prototype.open
        const origSend = XMLHttpRequest.prototype.send
        XMLHttpRequest.prototype.open = function (
          this: any,
          method: string,
          url: string,
          ...rest: any[]
        ) {
          this.__teamsUrl = url
          return (origOpen as any).call(this, method, url, ...rest)
        }
        XMLHttpRequest.prototype.send = function (this: any, ...sargs: any[]) {
          try {
            const url = this.__teamsUrl
            if (url && rosterUrlRe.test(url)) {
              this.addEventListener("load", () => {
                try {
                  if (typeof this.responseText === "string") {
                    tryHttpRoster(url, this.responseText)
                  }
                } catch {}
              })
            }
          } catch {}
          return (origSend as any).apply(this, sargs)
        }
      } catch {
        // ignore
      }
    }

    // RTCPeerConnection proxy — capture the "main-channel" data channel (dsh)
    // and audio receivers (CSRC).
    {
      const OriginalRTCPeerConnection = (window as any).RTCPeerConnection
      const attachMainChannel = (channel: any) => {
        instr.dataChannels++
        if (channel?.label !== "main-channel") return
        instr.mainChannelAttached++
        channel.addEventListener("message", (event: any) => handleMainChannelEvent(event))
        diag(`🔌 main-channel data channel attached`)
      }
      const ProxiedRTCPeerConnection = function (this: any, ...args: any[]) {
        const pc = Reflect.construct(OriginalRTCPeerConnection, args) as RTCPeerConnection
        instr.pcConstructed++

        pc.addEventListener("datachannel", (event) => attachMainChannel(event.channel))
        pc.addEventListener("track", (event) => {
          if (event.track?.kind === "audio") addReceiver(event.receiver)
        })

        const originalCreateDataChannel = pc.createDataChannel.bind(pc)
        pc.createDataChannel = (label, options) => {
          const dataChannel = originalCreateDataChannel(label, options)
          attachMainChannel(dataChannel)
          return dataChannel
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

    // Poll loop for CSRC-based per-participant speaking.
    const pollInterval = setInterval(pollReceivers, 100)

    // Audio-path watchdog: setup-time verification only proves the hooks were
    // INSTALLED, not that they see traffic. Observed live (bot 54084d8c): the
    // roster path worked while dsh + CSRC stayed silent through real speech —
    // recording fine, zero attributed speakers. If the meeting has other
    // active participants and the audio sub-path has signalled nothing for
    // AUDIO_PATH_DEAD_AFTER_MS since install, report it ONCE so the Node side
    // can fall back to UI-based observation.
    const AUDIO_PATH_DEAD_AFTER_MS = 45_000
    const watchdogInterval = setInterval(() => {
      try {
        if ((window as any).__teamsNetworkInterceptorStopped) return
        if (audioPathDeadReported) return
        // Not yet in-call (callback not bound) — don't run the grace clock.
        if (callbackBoundAt === 0) return
        const others = Array.from(participantsByDeviceId.values()).filter(
          (p) => !p.isCurrentUser && p.status === 1
        )
        if (others.length < 1) return
        // Measure from the later of: last real audio signal, or callback bind.
        const baseline = Math.max(lastAudioPathSignalAt, callbackBoundAt)
        const sinceSignal = Date.now() - baseline
        if (sinceSignal < AUDIO_PATH_DEAD_AFTER_MS) return
        audioPathDeadReported = true
        diag(
          `🚨 audio path dead: no dsh/CSRC signal for ${Math.round(sinceSignal / 1000)}s in-call with ${others.length} other participant(s) — requesting UI fallback | hooks: pc=${instr.pcConstructed} dataCh=${instr.dataChannels} mainCh=${instr.mainChannelAttached} audioRx=${instr.audioReceivers} dsh=${instr.dshEvents}`
        )
        // Deliver through the drained queue — exposeFunction bindings are not
        // visible in this context under CloakBrowser.
        try {
          const q = (window as any).__teamsSpeakerQueue as any[]
          q.push({ users: [], timestamp: Date.now(), source: "roster", audioPathDead: true })
        } catch {
          // ignore
        }
      } catch (e) {
        console.error(`${LOG} ❌ watchdog error:`, e)
      }
    }, 5_000)

    // Replay hook: broadcastSpeakerUpdate silently drops emissions until the
    // Node side exposes onNetworkSpeakerUpdate (post-admission). Retained state
    // (roster + dominantSpeakerStreamId) survives, so the Node side calls this
    // right after binding to receive the current snapshot — otherwise a
    // dominant-speaker (dsh) transition that fired in the unbound window is
    // lost until the NEXT transition, which a single-speaker meeting may never
    // produce (observed live: bot 54084d8c, roster-only events).
    ;(window as any).__teamsNetworkBroadcastNow = () => {
      try {
        callbackBoundAt = Date.now()
        diag(`callback bound — audio-path watchdog armed (${participantsByDeviceId.size} participants in roster)`)
        // Force the current snapshot into the queue even if the speaking key
        // hasn't changed since the last (possibly pre-bind) enqueue.
        lastSpeakingLogKey = ""
        broadcastSpeakerUpdate(csrcAvailable ? "audio" : dominantSpeakerStreamId ? "audio" : "roster")
      } catch (e) {
        console.error(`${LOG} ❌ Replay broadcast failed:`, e)
      }
    }

    ;(window as any).__teamsStopNetworkInterception = () => {
      clearInterval(watchdogInterval)
      ;(window as any).__teamsNetworkInterceptorStopped = true
      try {
        clearInterval(pollInterval)
      } catch {
        // ignore
      }
    }
  } catch (error) {
    console.error("[NetworkInterceptor][Teams] ❌ Initialization error:", error)
  }
}
