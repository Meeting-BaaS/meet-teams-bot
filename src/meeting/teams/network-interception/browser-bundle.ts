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
    console.warn(`${LOG} ✅ Activated`) // warn → surfaces via page-logger

    // ===== STATE =====

    // deviceId (roster details.id) → participant record
    const participantsByDeviceId = new Map<string, any>()
    // virtual stream id (string) → { participantId, displayName, type, isAudio, isActive }
    const virtualStreams = new Map<string, any>()
    // current dominant speaker's audio virtual stream id (from "dsh")
    let dominantSpeakerStreamId: string | null = null
    // when true, CSRC is authoritative; when false, fall back to dsh
    let csrcAvailable = false
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

    function handleRosterUpdate(eventDataObject: any): void {
      try {
        const decodedBody = decodeWebSocketBody(eventDataObject.body)
        // Teams includes a phantom user with no display name; skip it.
        const participants = Object.values<any>(decodedBody.participants || {}).filter(
          (p) => p?.details?.displayName
        )
        const currentUserId = getCurrentUserId()
        let changed = false

        for (const participant of participants) {
          const deviceId = participant.details?.id
          if (!deviceId) continue

          const record = {
            deviceId,
            displayName: participant.details.displayName,
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

        debug(`👥 roster: ${participantsByDeviceId.size} participants`)
        if (changed) broadcastSpeakerUpdate("roster")
      } catch (error) {
        console.error(`${LOG} ❌ Error handling roster update:`, error)
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
            const newDominantStreamId = item.history?.[0]
            if (newDominantStreamId != null) {
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
        if (mappedIds.size > 0) mappedCsrcThisPoll = true
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
      if (typeof (window as any).onNetworkSpeakerUpdate !== "function") return

      // CSRC when available (silence == nobody), else dsh dominant speaker.
      let speaking: Set<string>
      if (csrcAvailable) {
        speaking = getCsrcSpeakingIds()
      } else {
        const dominant = getDominantSpeakerParticipantId()
        speaking = dominant ? new Set([dominant]) : new Set()
      }

      const users = Array.from(participantsByDeviceId.values()).map((p) => ({
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

      // Debug: log speakers + signal on change, to confirm detection is from
      // network interception. warn → surfaces through the page-logger.
      const method = csrcAvailable ? "csrc" : dominantSpeakerStreamId ? "dsh" : "none"
      const speakingNames = users.filter((u) => u.isSpeaking).map((u) => u.name)
      const logKey = `${speakingNames.slice().sort().join("|")}#${method}`
      if (logKey !== lastSpeakingLogKey) {
        lastSpeakingLogKey = logKey
        console.warn(
          `${LOG} 🗣️ speaking=[${speakingNames.join(", ") || "(none)"}] method=${method} source=${source} participants=${users.length}`
        )
      }

      ;(window as any).onNetworkSpeakerUpdate({
        users,
        timestamp: Date.now(),
        source
      })
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
            if (eventUrl.endsWith("rosterUpdate/") || eventUrl.endsWith("rosterUpdate")) {
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

    // RTCPeerConnection proxy — capture the "main-channel" data channel (dsh)
    // and audio receivers (CSRC).
    {
      const OriginalRTCPeerConnection = (window as any).RTCPeerConnection
      const attachMainChannel = (channel: any) => {
        if (channel?.label !== "main-channel") return
        channel.addEventListener("message", (event: any) => handleMainChannelEvent(event))
        debug("🔌 main-channel attached")
      }
      const ProxiedRTCPeerConnection = function (this: any, ...args: any[]) {
        const pc = Reflect.construct(OriginalRTCPeerConnection, args) as RTCPeerConnection

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

    // Replay hook: broadcastSpeakerUpdate silently drops emissions until the
    // Node side exposes onNetworkSpeakerUpdate (post-admission). Retained state
    // (roster + dominantSpeakerStreamId) survives, so the Node side calls this
    // right after binding to receive the current snapshot — otherwise a
    // dominant-speaker (dsh) transition that fired in the unbound window is
    // lost until the NEXT transition, which a single-speaker meeting may never
    // produce (observed live: bot 54084d8c, roster-only events).
    ;(window as any).__teamsNetworkBroadcastNow = () => {
      try {
        broadcastSpeakerUpdate(csrcAvailable ? "audio" : dominantSpeakerStreamId ? "audio" : "roster")
      } catch (e) {
        console.error(`${LOG} ❌ Replay broadcast failed:`, e)
      }
    }

    ;(window as any).__teamsStopNetworkInterception = () => {
      ;(window as any).__teamsNetworkInterceptorStopped = true
      try {
        clearInterval(pollInterval)
      } catch {
        // ignore
      }
      console.log(`${LOG} ✅ Stopped`)
    }

    console.warn(`${LOG} ✅ Interceptors installed (WebSocket roster, main-channel dsh, CSRC poll)`)
  } catch (error) {
    console.error("[NetworkInterceptor][Teams] ❌ Initialization error:", error)
  }
}
