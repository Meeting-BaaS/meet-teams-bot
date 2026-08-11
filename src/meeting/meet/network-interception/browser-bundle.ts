// Single-file browser-side bundle (no imports to avoid module issues when stringified)
/** biome-ignore-all lint/suspicious/noExplicitAny: This is a browser-side bundle. If possible, we will add type definitions later. */

export function browserInterceptionLogic(schema: any[]) {
  try {
    // Guard against duplicate initialization to prevent:
    // - Stacking RTCPeerConnection/fetch overrides
    // - Leaking intervals
    // - Multiple event listeners
    // Use a more robust check that also verifies the flag is actually set
    if ((window as any).__networkInterceptorInitialized === true) {
      console.warn("[NetworkInterceptor] ⚠️ Already initialized, skipping duplicate initialization")
      return
    }
    // Set flag immediately to prevent race conditions
    ;(window as any).__networkInterceptorInitialized = true

    // Feature flag: Proactive datachannel creation
    // Enabled — passive listener alone may miss the channel due to timing
    const ENABLE_PROACTIVE_MEET_CHANNEL = true

    console.error("[NetworkInterceptor] ✅ Activated")
    console.error(
      `[NetworkInterceptor] Proactive channel creation: ${ENABLE_PROACTIVE_MEET_CHANNEL ? "enabled" : "disabled"}`
    )

    // ===== MEDIA-ARCHITECTURE PROBE (read-only, temporary) =====
    // Prod probe v1 showed that in ~half of Meet sessions the page context has
    // NO WebRTC receivers at all (receivers=0, Meet never calls
    // getContributingSources) while audio still plays — the media stack runs
    // somewhere this bundle cannot see. These constructor hooks record WHERE:
    // dedicated/shared workers (and their script URLs), WebTransport
    // connections, RTCRtpScriptTransform (RTP processing moved into a worker),
    // MediaStreamTrackGenerator (worker→page bridge tracks we could tap), and
    // AudioContext/audioWorklet usage. Counts and static script/host names
    // only — no user data. Installed at document-start so nothing Meet does
    // beats the hooks.
    const mediaProbe = {
      // Host only — a frame's pathname can embed the meeting code or other
      // session identifiers, and this string ends up in the bot log.
      frame: window === window.top ? "top" : location.host.slice(0, 40),
      pcCreated: 0,
      workers: [] as string[],
      sharedWorkers: 0,
      webTransport: [] as string[],
      scriptTransforms: 0,
      trackGenerators: 0,
      audioContexts: 0,
      workletModules: [] as string[],
      // v3: AudioWorkletNode processors — the dead-session probe showed Meet's
      // new stack decodes audio through NetEq AudioWorklet nodes in the PAGE
      // AudioContext. Processor names + fan-out tell us whether it is one node
      // per remote stream (per-participant tap point) or one mixed node.
      workletNodes: new Map<string, number>(),
      workletEdges: [] as string[]
    }
    function probeName(src: any): string {
      try {
        const url = new URL(String(src), location.href)
        if (url.protocol === "blob:") return "blob"
        if (url.protocol === "data:") return "data"
        // Keep only static, non-identifying path segments: the static worklet
        // loader names (…loadNetEqWrapper…, …loadAudioAnalyzer…) are the whole
        // point of the probe, but any segment that looks like a UUID/hex/long
        // token is session-specific and must not reach the log.
        const uuidish = /^[0-9a-f]{8,}(-[0-9a-f]{4,}){0,4}$|^[0-9a-f]{16,}$/i
        const kept = url.pathname
          .split("/")
          .filter((seg) => seg && !uuidish.test(seg))
          .slice(-2)
          .join("/")
        return (kept || url.protocol.replace(":", "")).slice(0, 80)
      } catch {
        return "unknown"
      }
    }
    function hookConstructor(name: string, onConstruct: (args: any[]) => void) {
      const Original = (window as any)[name]
      if (typeof Original !== "function") return
      const Wrapped = function (this: any, ...args: any[]) {
        try {
          onConstruct(args)
        } catch {}
        return Reflect.construct(Original, args, new.target || Wrapped)
      }
      Wrapped.prototype = Original.prototype
      Object.setPrototypeOf(Wrapped, Original)
      ;(window as any)[name] = Wrapped
    }
    hookConstructor("Worker", (args) => {
      const n = probeName(args[0])
      if (!mediaProbe.workers.includes(n) && mediaProbe.workers.length < 10) mediaProbe.workers.push(n)
    })
    hookConstructor("SharedWorker", () => {
      mediaProbe.sharedWorkers++
    })
    hookConstructor("WebTransport", (args) => {
      const n = probeName(args[0])
      if (!mediaProbe.webTransport.includes(n) && mediaProbe.webTransport.length < 10)
        mediaProbe.webTransport.push(n)
    })
    hookConstructor("RTCRtpScriptTransform", () => {
      mediaProbe.scriptTransforms++
    })
    hookConstructor("MediaStreamTrackGenerator", () => {
      mediaProbe.trackGenerators++
    })
    hookConstructor("AudioContext", () => {
      mediaProbe.audioContexts++
    })
    // AudioWorkletNode needs a custom wrap: record the processor name AND wrap
    // the instance's connect() so we learn what each node feeds into.
    try {
      const OriginalAWN = (window as any).AudioWorkletNode
      if (typeof OriginalAWN === "function") {
        const WrappedAWN = function (this: any, ...args: any[]) {
          const pname = typeof args[1] === "string" ? args[1].slice(0, 60) : "unknown"
          try {
            // Bounded like the other probe collections: cap distinct processor
            // names, count the rest under one overflow bucket.
            if (mediaProbe.workletNodes.has(pname) || mediaProbe.workletNodes.size < 12) {
              mediaProbe.workletNodes.set(pname, (mediaProbe.workletNodes.get(pname) || 0) + 1)
            } else {
              mediaProbe.workletNodes.set("overflow", (mediaProbe.workletNodes.get("overflow") || 0) + 1)
            }
          } catch {}
          const node = Reflect.construct(OriginalAWN, args, new.target || WrappedAWN)
          try {
            const origConnect = node.connect.bind(node)
            node.connect = (...cargs: any[]) => {
              try {
                const dest = cargs[0]
                const edge = `${pname}->${dest?.constructor?.name || typeof dest}`
                if (mediaProbe.workletEdges.length < 12 && !mediaProbe.workletEdges.includes(edge))
                  mediaProbe.workletEdges.push(edge)
              } catch {}
              return origConnect(...cargs)
            }
          } catch {}
          return node
        }
        WrappedAWN.prototype = OriginalAWN.prototype
        Object.setPrototypeOf(WrappedAWN, OriginalAWN)
        ;(window as any).AudioWorkletNode = WrappedAWN
      }
    } catch {}
    try {
      const OriginalAddModule = (window as any).AudioWorklet?.prototype?.addModule
      if (OriginalAddModule) {
        ;(window as any).AudioWorklet.prototype.addModule = function (...args: any[]) {
          const n = probeName(args[0])
          if (!mediaProbe.workletModules.includes(n) && mediaProbe.workletModules.length < 10)
            mediaProbe.workletModules.push(n)
          return OriginalAddModule.apply(this, args)
        }
      }
    } catch {}

    const mediaProbeInterval = setInterval(() => {
      try {
        // Live media elements: where does the audio the user hears come from?
        let mediaEls = 0
        let elsWithStream = 0
        let liveAudioTracks = 0
        for (const el of Array.from(document.querySelectorAll("audio, video"))) {
          mediaEls++
          const stream = (el as any).srcObject
          if (stream?.getAudioTracks) {
            elsWithStream++
            for (const t of stream.getAudioTracks()) {
              if (t.readyState === "live") liveAudioTracks++
            }
          }
        }
        if ((window as any).__networkInterceptorStopped) return
        if (typeof (window as any).onNetworkSpeakerUpdate === "function") {
          ;(window as any).onNetworkSpeakerUpdate({
            users: [],
            timestamp: Date.now(),
            source: "media_probe",
            media: {
              frame: mediaProbe.frame,
              pcCreated: mediaProbe.pcCreated,
              workers: mediaProbe.workers,
              sharedWorkers: mediaProbe.sharedWorkers,
              webTransport: mediaProbe.webTransport,
              scriptTransforms: mediaProbe.scriptTransforms,
              trackGenerators: mediaProbe.trackGenerators,
              audioContexts: mediaProbe.audioContexts,
              workletModules: mediaProbe.workletModules,
              workletNodes: Array.from(mediaProbe.workletNodes.entries()).map(
                ([n, c]) => `${n}:${c}`
              ),
              workletEdges: mediaProbe.workletEdges,
              mediaEls,
              elsWithStream,
              liveAudioTracks,
              timestamp: Date.now()
            }
          })
        }
      } catch (e) {
        console.error("[MediaProbe] error:", e)
      }
    }, 30000)

    // ===== HELPER FUNCTIONS (inlined from utils.ts) =====

    function base64ToUint8Array(base64: string) {
      const binaryString = window.atob(base64)
      const len = binaryString.length
      const bytes = new Uint8Array(len)
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i)
      }
      return bytes
    }

    function decodeUserName(user: any): string {
      // Prefer fullName if available, otherwise use displayName
      if (user.fullName) {
        let fullName: string
        if (user.fullName instanceof Uint8Array) {
          try {
            fullName = new TextDecoder().decode(user.fullName)
          } catch {
            fullName = ""
          }
        } else {
          fullName = user.fullName
        }

        // Return fullName if non-empty after trimming
        if (fullName.trim()) {
          return fullName
        }
      }

      // Fall back to displayName if fullName not available or empty
      if (user.displayName) return user.displayName

      return "Unknown"
    }

    function createMessageDecoder(messageType: any) {
      return function decode(readerOrBuffer: any, length?: number) {
        let reader = readerOrBuffer
        if (!(reader instanceof (window as any).protobuf.Reader)) {
          reader = (window as any).protobuf.Reader.create(reader)
        }
        const end = length === undefined ? reader.len : reader.pos + length
        const message: any = {}
        while (reader.pos < end) {
          const tag = reader.uint32()
          const fieldNumber = tag >>> 3
          const wireType = tag & 7
          const field = messageType.fields.find((f: any) => f.fieldNumber === fieldNumber)
          if (!field) {
            reader.skipType(wireType)
            continue
          }
          let value: unknown
          switch (field.type) {
            case "string":
              value = reader.string()
              break
            case "int64":
              value = reader.int64()
              break
            case "varint":
              value = reader.uint32()
              break
            case "bytes":
              value = reader.bytes()
              break
            case "message":
              value = messageDecoders[field.messageType](reader, reader.uint32())
              break
            default:
              reader.skipType(wireType)
              continue
          }
          if (field.repeated) {
            if (!message[field.name]) {
              message[field.name] = []
            }
            message[field.name].push(value)
          } else {
            message[field.name] = value
          }
        }
        return message
      }
    }

    function createDecoders(schema: any[]) {
      const decoders: { [key: string]: any } = {}
      schema.forEach((type: any) => {
        decoders[type.name] = createMessageDecoder(type)
      })
      return decoders
    }

    // ===== MANAGER FUNCTIONS (inlined from managers.ts) =====

    function createReceiverManager() {
      return {
        receiverMap: new Map(),
        receiverToTrackMap: new Map(),
        // performance.now() when we last mirrored each receiver's sources. The
        // CSRC entries carry their own `timestamp`, but on a different clock
        // (not performance.now()), so gating freshness on it filtered out every
        // live source. Stamp arrival ourselves and gate on that instead.
        sourceStamp: new Map()
      }
    }

    function createUserManager() {
      return {
        deviceOutputMap: new Map(),
        allUsersMap: new Map(),
        ssrcToDeviceMap: new Map()
      }
    }

    function updateContributingSources(
      receiverManager: any,
      receiver: any,
      contributingSources: any
    ) {
      receiverManager.receiverMap.set(receiver, contributingSources)
      receiverManager.sourceStamp.set(receiver, performance.now())
    }

    function getContributingSources(receiverManager: any, receiver: any) {
      return receiverManager.receiverMap.get(receiver) || []
    }

    function linkReceiverToTrack(receiverManager: any, receiver: any, trackId: any) {
      // Tapped tracks (NetEq destination) arrive with no receiver — linking
      // them under a shared null key would just overwrite each other.
      if (!receiver) return
      receiverManager.receiverToTrackMap.set(receiver, trackId)
    }

    function updateDeviceOutputs(userManager: any, deviceOutputs: any[]) {
      deviceOutputs
        .filter((o) => o?.deviceId)
        .forEach((output) => {
          const key = `${output.deviceId}-${output.deviceOutputType}`
          const deviceOutput = {
            deviceId: output.deviceId,
            outputType: output.deviceOutputType,
            streamId: output.streamId,
            lastUpdated: Date.now()
          }
          userManager.deviceOutputMap.set(key, deviceOutput)
          if (output.streamId) {
            userManager.ssrcToDeviceMap.set(output.streamId, output.deviceId)
            const numericSSRC = Number.parseInt(output.streamId, 10)
            if (!Number.isNaN(numericSSRC)) {
              userManager.ssrcToDeviceMap.set(numericSSRC, output.deviceId)
            }
          }
        })
    }

    function updateUsers(userManager: any, users: any[]) {
      users
        .filter((u) => u?.deviceId)
        .forEach((user) => {
          userManager.allUsersMap.set(user.deviceId, user)
        })
    }

    function getAllUsers(userManager: any) {
      return Array.from(userManager.allUsersMap.values())
    }

    function getUserByStreamId(userManager: any, streamId: any) {
      let deviceId = userManager.ssrcToDeviceMap.get(streamId)
      if (!deviceId && typeof streamId !== "string") {
        deviceId = userManager.ssrcToDeviceMap.get(streamId.toString())
      }
      if (!deviceId && typeof streamId === "string") {
        const numericSSRC = Number.parseInt(streamId, 10)
        if (!Number.isNaN(numericSSRC)) {
          deviceId = userManager.ssrcToDeviceMap.get(numericSSRC)
        }
      }
      if (deviceId) {
        return userManager.allUsersMap.get(deviceId)
      }
      const normalizedStreamId = streamId != null ? String(streamId) : null
      for (const deviceOutput of userManager.deviceOutputMap.values()) {
        const normalizedDeviceStreamId =
          deviceOutput.streamId != null ? String(deviceOutput.streamId) : null
        if (normalizedDeviceStreamId === normalizedStreamId) {
          return userManager.allUsersMap.get(deviceOutput.deviceId)
        }
      }
      return null
    }

    function setupRTCRtpReceiverInterceptor(onGetContributingSources: any) {
      const OriginalRTCRtpReceiver = (window as any).RTCRtpReceiver
      if (!OriginalRTCRtpReceiver || !OriginalRTCRtpReceiver.prototype.getContributingSources) {
        console.error("[NetworkInterceptor] ⚠️ RTCRtpReceiver.getContributingSources not available")
        return
      }
      const originalGetContributingSources = OriginalRTCRtpReceiver.prototype.getContributingSources
      OriginalRTCRtpReceiver.prototype.getContributingSources = function (...args: any[]) {
        const result = originalGetContributingSources.apply(this, args)
        // Mirror EVERY call, including empty results: an empty array is Meet
        // telling us the previous speaker went quiet, and skipping it would
        // leave a stale non-empty array in the mirror for the CSRC sampler to
        // read (its freshness gate catches most of this, clearing is exact).
        if (onGetContributingSources) {
          onGetContributingSources(this, result || [])
        }
        return result
      }
      console.error("[NetworkInterceptor] ✅ RTCRtpReceiver.getContributingSources intercepted")
    }

    // ===== USER DATA HELPERS =====

    function decodeFullName(user: any): string | undefined {
      if (user.fullName instanceof Uint8Array) {
        try {
          return new TextDecoder().decode(user.fullName)
        } catch {
          return undefined
        }
      }
      return user.fullName
    }

    function filterActiveUsers(users: any[]) {
      return users.filter((user: any) => !user.parentDeviceId && user.status === 1)
    }

    // ===== AUDIO FUNCTIONS (inlined from audio.ts) =====

    // Extract audio data from a multi-channel frame by averaging channels
    function extractAudioData(frame: any): Float32Array {
      const numChannels = frame.numberOfChannels
      const numSamples = frame.numberOfFrames
      const audioData = new Float32Array(numSamples)

      if (numChannels > 1) {
        const channelData = new Float32Array(numSamples)
        for (let channel = 0; channel < numChannels; channel++) {
          frame.copyTo(channelData, { planeIndex: channel })
          for (let i = 0; i < numSamples; i++) {
            audioData[i] += channelData[i]
          }
        }
        for (let i = 0; i < numSamples; i++) {
          audioData[i] /= numChannels
        }
      } else {
        frame.copyTo(audioData, { planeIndex: 0 })
      }

      return audioData
    }

    // performance.now() of the last frame with audio energy — from ANY track,
    // including the NetEq tap's mixed stream. This is the only "is anyone
    // speaking" ground truth on NetEq sessions (no per-stream CSRC there), used
    // to test whether datachannel field 14 is the active-speaker flag.
    let lastAudioActivityAt = 0
    // Check if audio data contains meaningful audio
    function hasAudioActivity(audioData: Float32Array): boolean {
      const active = audioData.some((v) => Math.abs(v) > 0.001)
      if (active) lastAudioActivityAt = performance.now()
      return active
    }

    // Find users with audio levels from contributing sources
    function getUsersWithAudio(contributingSources: any[], userManager: any): any[] {
      return contributingSources
        .map((source) => ({
          audioLevel: source?.audioLevel || 0,
          ssrc: source.source,
          timestamp: source.timestamp,
          user: getUserByStreamId(userManager, source.source.toString())
        }))
        .filter((x) => x.user && x.audioLevel > 0.05)
        .sort((a, b) => b.audioLevel - a.audioLevel)
    }

    // Build user state list with speaking status
    function buildUserStateList(
      filteredUsers: any[],
      speakingDeviceId: string | null,
      audioLevel = 0
    ): any[] {
      return filteredUsers.map((user: any) => {
        const isCurrentlySpeaking = user.deviceId === speakingDeviceId
        return {
          deviceId: user.deviceId,
          name: decodeUserName(user),
          isCurrentUser: user.isCurrentUserString === "true" || user.isCurrentUserString === "1",
          isSpeaking: isCurrentlySpeaking,
          status: user.status,
          isHost: user.isHost === 1,
          audioLevel: isCurrentlySpeaking ? audioLevel : 0,
          fullName: decodeFullName(user),
          displayName: user.displayName,
          profilePicture: user.profilePicture
        }
      })
    }

    // Send failure signal to Node.js when network interception fails
    function sendFailureSignal(
      track: MediaStreamTrack,
      reason: "timeout" | "immediate_failure" | "processor_unavailable"
    ): void {
      if ((window as any).__networkInterceptorStopped) {
        return // Don't send callbacks if stopped
      }
      if (typeof (window as any).onNetworkSpeakerUpdate !== "function") {
        console.error(
          "[NetworkInterceptor] ⚠️ Cannot send failure signal: onNetworkSpeakerUpdate not available"
        )
        return
      }

      console.error(
        `[NetworkInterceptor] 📤 Sending failure signal: track=${track.id}, reason=${reason}, state=${track.readyState}`
      )

      ;(window as any).onNetworkSpeakerUpdate({
        users: [],
        timestamp: Date.now(),
        source: "network_interception_failed",
        failure: {
          trackId: track.id,
          reason,
          trackState: track.readyState,
          timestamp: Date.now()
        }
      })
    }

    // Broadcast speaker update with all users
    function broadcastSpeakerUpdate(
      userManager: any,
      speakingDeviceId: string | null,
      audioLevel = 0,
      source = "audio"
    ): void {
      if ((window as any).__networkInterceptorStopped) {
        return // Don't send callbacks if stopped
      }
      if (typeof (window as any).onNetworkSpeakerUpdate !== "function") {
        return
      }

      const allUsers = getAllUsers(userManager)
      const filteredUsers = filterActiveUsers(allUsers)
      const users = buildUserStateList(filteredUsers, speakingDeviceId, audioLevel)

      // Calls the Node-side callback exposed via Playwright"s exposeFunction (see network-interception/index.ts)
      // This crosses the browser/Node boundary → triggers NetworkSpeakerLogger.handleNetworkPayload
      // Note: We don't filter out bots - they'll appear in participants but not speakers (since they don't speak)
      ;(window as any).onNetworkSpeakerUpdate({
        users,
        timestamp: Date.now(),
        source
      })
    }

    async function processAudioFrames(
      track: MediaStreamTrack,
      receiver: RTCRtpReceiver,
      receiverManager: any,
      userManager: any,
      abortSignal: AbortSignal
    ): Promise<boolean> {
      let reader: ReadableStreamDefaultReader<any> | null = null
      try {
        if (
          typeof (window as any).MediaStreamTrackProcessor === "undefined" ||
          typeof (window as any).MediaStreamTrackGenerator === "undefined"
        ) {
          console.error("[NetworkInterceptor] ⚠️ MediaStreamTrackProcessor/Generator not available")
          sendFailureSignal(track, "processor_unavailable")
          return false
        }

        // Wait for track to be unmuted before creating processor
        // MediaStreamTrackProcessor may not produce frames if created while track is muted
        // Note: We wait indefinitely for unmute - tracks can legitimately stay muted for long periods
        if (track.muted) {
          console.error(
            `[NetworkInterceptor] ⏳ Track ${track.id} is muted, waiting for unmute event before creating processor...`
          )
          const unmutePromise = new Promise<void>((resolve, reject) => {
            const unmuteHandler = () => {
              track.removeEventListener("unmute", unmuteHandler)
              track.removeEventListener("ended", endedHandler)
              console.error(`[NetworkInterceptor] ✅ Track ${track.id} unmuted, creating processor`)
              resolve()
            }
            const endedHandler = () => {
              track.removeEventListener("unmute", unmuteHandler)
              track.removeEventListener("ended", endedHandler)
              reject(new Error("Track ended while waiting for unmute"))
            }

            track.addEventListener("unmute", unmuteHandler)
            track.addEventListener("ended", endedHandler)

            // Check if already unmuted (race condition)
            if (!track.muted) {
              track.removeEventListener("unmute", unmuteHandler)
              track.removeEventListener("ended", endedHandler)
              resolve()
            }
            // Check if already ended
            if (track.readyState === "ended") {
              track.removeEventListener("unmute", unmuteHandler)
              track.removeEventListener("ended", endedHandler)
              reject(new Error("Track already ended"))
            }
          })

          try {
            await unmutePromise
          } catch (error) {
            console.error(
              `[NetworkInterceptor] ⚠️ Track ${track.id} ended while waiting for unmute`,
              error
            )
            sendFailureSignal(track, "immediate_failure")
            return false
          }
        }

        const processor = new (window as any).MediaStreamTrackProcessor({ track })
        reader = processor.readable.getReader()
        console.error(
          `[NetworkInterceptor] 🎤 Started processing audio frames for track: ${track.id}`
        )
        console.error(
          `[NetworkInterceptor] 📊 Track state before first read: id=${track.id}, readyState=${track.readyState}, muted=${track.muted}`
        )

        const processFrames = async () => {
          let abortListener: (() => void) | null = null
          let frameCount = 0
          try {
            // Register abort listener to cancel pending reads
            abortListener = () => {
              if (reader) {
                reader.cancel().catch((err) => {
                  console.error("[NetworkInterceptor] Error cancelling reader on abort:", err)
                })
              }
            }
            abortSignal.addEventListener("abort", abortListener)

            while (!abortSignal.aborted) {
              const { done, value: frame } = await reader.read()
              if (done) {
                console.error(
                  `[NetworkInterceptor] 🎬 Audio frame reader done for track: ${track.id} (processed ${frameCount} frames)`
                )
                break
              }
              if (!frame) continue

              frameCount++
              tracksDeliveringFrames.set(track.id, Date.now())
              // Only log frame count every 1000 frames (much less frequent)
              if (frameCount % 1000 === 0) {
                console.error(
                  `[NetworkInterceptor] 📊 Processed ${frameCount} audio frames for track: ${track.id}`
                )
              }

              try {
                // Extract and process audio data
                const audioData = extractAudioData(frame)
                const maxAmplitude = Math.max(...Array.from(audioData).map((v) => Math.abs(v)))

                if (hasAudioActivity(audioData)) {
                  // Only log audio activity occasionally (every 500 frames with activity) to reduce noise
                  if (frameCount % 500 === 0) {
                    console.error(
                      `[NetworkInterceptor] 🔊 Audio activity detected (max amplitude: ${maxAmplitude.toFixed(6)}) for track: ${track.id}`
                    )
                  }
                  const contributingSources = getContributingSources(receiverManager, receiver)

                  if (contributingSources && contributingSources.length > 0) {
                    const usersWithAudioLevels = getUsersWithAudio(contributingSources, userManager)
                    const loudestSpeaker = usersWithAudioLevels[0]

                    // DEBUG: Log speaker detection only when speaker changes (reduces noise significantly)
                    // The speaker change log below will handle the important state changes

                    if (loudestSpeaker?.user) {
                      const currentSpeakerId = loudestSpeaker.user.deviceId
                      // Only broadcast if speaker changed
                      if (currentSpeakerId !== lastBroadcastedSpeakerId) {
                        console.error(
                          `[NetworkInterceptor] 🎤 Speaker changed: ${lastBroadcastedSpeakerId || "none"} → ${currentSpeakerId} (audioLevel: ${loudestSpeaker.audioLevel})`
                        )
                        lastBroadcastedSpeakerId = currentSpeakerId
                        speakingState.clear()
                        speakingState.set(currentSpeakerId, true)
                        broadcastSpeakerUpdate(
                          userManager,
                          currentSpeakerId,
                          loudestSpeaker.audioLevel,
                          "audio"
                        )
                      }
                    } else {
                      // No speaker with meaningful audio - broadcast silence only if changed
                      if (lastBroadcastedSpeakerId !== null) {
                        console.error(
                          `[NetworkInterceptor] 🔇 Clearing speaker state (was: ${lastBroadcastedSpeakerId})`
                        )
                        lastBroadcastedSpeakerId = null
                        speakingState.clear()
                        broadcastSpeakerUpdate(userManager, null, 0, "audio")
                      }
                    }
                  } else {
                    // No contributing sources - broadcast silence only if changed
                    if (lastBroadcastedSpeakerId !== null) {
                      // Only log this occasionally to reduce noise
                      if (frameCount % 1000 === 0) {
                        console.error(
                          `[NetworkInterceptor] ⚠️ No contributing sources available for track: ${track.id}, clearing speaker state`
                        )
                      }
                      lastBroadcastedSpeakerId = null
                      speakingState.clear()
                      broadcastSpeakerUpdate(userManager, null, 0, "audio")
                    }
                  }
                }
                // Removed: "No audio activity detected" log - too noisy and not useful

                frame.close()
              } catch (frameError) {
                console.error("[NetworkInterceptor] Frame Processing Error:", frameError)
                if (frame) frame.close()
              }
            }

            if (abortSignal.aborted) {
              console.error(
                `[NetworkInterceptor] 🛑 Audio processing aborted for track: ${track.id}`
              )
            }
          } catch (readError) {
            // Handle errors from reader.read() including cancellation
            if (!abortSignal.aborted) {
              console.error("[NetworkInterceptor] Reader Error:", readError)
            }
          } finally {
            // The reader is finished for good here — done, error or abort — so
            // this track is no longer delivering anything. Reporting it as
            // healthy afterwards is the same lie the counter was added to stop.
            releaseTrackHealth(track.id, abortSignal)

            // Remove abort listener
            if (abortListener) {
              abortSignal.removeEventListener("abort", abortListener)
            }

            if (reader) {
              try {
                await reader.cancel()
                reader.releaseLock()
              } catch (err) {
                console.error("[NetworkInterceptor] Error during reader cleanup:", err)
              }
            }
          }
        }

        // Wait for the first frame before declaring the pipeline healthy.
        //
        // A live track that yields no frames is a SILENT participant, not a
        // broken pipeline — Meet sends no RTP for someone who isn't talking.
        // The previous code gave up after a flat 60s and reported the track as
        // failed even while logging readyState=live, which retired the entire
        // network path on any meeting that opened with a quiet minute. Wait for
        // as long as the track is alive; only give up once it actually dies.
        const LIVENESS_POLL_MS = 15000

        // Nothing to wait for if the track is already gone — don't open a read
        // that will hang until the first poll tick.
        if (abortSignal.aborted || track.readyState !== "live") {
          console.error(
            `[NetworkInterceptor] ❌ Track ${track.id} was not live before the first read: readyState=${track.readyState}, aborted=${abortSignal.aborted}`
          )
          trackAbortControllers.delete(track.id)
          sendFailureSignal(track, "timeout")
          return false
        }

        const firstReadPromise = reader.read()

        let livenessTimer: ReturnType<typeof setInterval> | undefined
        let onAbort: (() => void) | undefined
        let waitedMs = 0
        const trackDeath = new Promise<never>((_, reject) => {
          const fail = () => reject(new Error("Track ended before producing audio"))
          // Abort is edge-triggered: waiting for the next poll would leave the
          // read pending for up to LIVENESS_POLL_MS after teardown started.
          onAbort = fail
          abortSignal.addEventListener("abort", fail, { once: true })
          livenessTimer = setInterval(() => {
            if (track.readyState !== "live") {
              fail()
              return
            }
            waitedMs += LIVENESS_POLL_MS
            console.error(
              `[NetworkInterceptor] ⏳ No audio yet on track ${track.id} after ${waitedMs / 1000}s — track is live, treating as a silent participant and continuing to wait`
            )
          }, LIVENESS_POLL_MS)
        })

        let firstRead: any
        try {
          firstRead = await Promise.race([firstReadPromise, trackDeath])
        } catch (_error) {
          console.error(
            `[NetworkInterceptor] ❌ Track ${track.id} died before producing audio: readyState=${track.readyState}, muted=${track.muted}`
          )
          // The first read is still pending and holds the stream lock. Cancel it
          // (which settles the read) and release the lock, so a replacement
          // track for this participant can be monitored instead of failing to
          // acquire a reader. Release even if cancellation itself throws.
          try {
            await reader.cancel()
          } catch (cancelError) {
            console.error(
              `[NetworkInterceptor] Error cancelling reader for track ${track.id}:`,
              cancelError
            )
          } finally {
            try {
              reader.releaseLock()
            } catch (releaseError) {
              console.error(
                `[NetworkInterceptor] Error releasing reader lock for track ${track.id}:`,
                releaseError
              )
            }
          }
          // Clean up AbortController since processing failed
          trackAbortControllers.delete(track.id)
          sendFailureSignal(track, "timeout")
          return false
        } finally {
          if (livenessTimer) {
            clearInterval(livenessTimer)
          }
          if (onAbort) {
            abortSignal.removeEventListener("abort", onAbort)
          }
        }

        if (firstRead.done) {
          console.error("[NetworkInterceptor] ⚠️ Audio stream ended immediately")
          // Clean up AbortController since processing failed
          trackAbortControllers.delete(track.id)
          sendFailureSignal(track, "immediate_failure")
          return false
        }
        if (firstRead.value) {
          // The validation read is a delivered frame like any other — count it,
          // or a track that produced its first frame here still reports zero
          // until processFrames() happens to read another one.
          tracksDeliveringFrames.set(track.id, Date.now())
          firstRead.value.close()
        }

        console.error(`[NetworkInterceptor] 🎬 Audio Frame Processing Started: ${track.id}`)
        // Start background processing (fire-and-forget but with proper cleanup via AbortController)
        processFrames().catch((err) => {
          console.error(`[NetworkInterceptor] Background processing error for ${track.id}:`, err)
        })
        return true
      } catch (e) {
        console.error("[NetworkInterceptor] Audio Frame Processing Setup Error:", e)
        // Clean up AbortController since processing failed
        trackAbortControllers.delete(track.id)
        sendFailureSignal(track, "immediate_failure")
        return false
      }
    }

    function monitorTrack(
      track: MediaStreamTrack,
      receiver: RTCRtpReceiver,
      receiverManager: any,
      userManager: any,
      activeAudioTracks: Map<string, { analyser: AnalyserNode; receiver?: RTCRtpReceiver }>
    ): void {
      if (activeAudioTracks.has(track.id)) {
        console.error(`[NetworkInterceptor] Track ${track.id} already being monitored`)
        return
      }

      try {
        // Abort any existing processing for this track (in case of replacement)
        const existingController = trackAbortControllers.get(track.id)
        if (existingController) {
          console.error(
            `[NetworkInterceptor] 🛑 Aborting existing processing for track: ${track.id}`
          )
          existingController.abort()
          trackAbortControllers.delete(track.id)
        }

        // Create new AbortController for this track
        const abortController = new AbortController()
        trackAbortControllers.set(track.id, abortController)

        // Clean up AbortController when track ends
        track.onended = () => {
          console.error(`[NetworkInterceptor] 🎬 Track ended: ${track.id}`)
          abortController.abort()
          releaseTrackHealth(track.id, abortController.signal)
          activeAudioTracks.delete(track.id)
        }

        linkReceiverToTrack(receiverManager, receiver, track.id)

        // Log track state when track arrives
        console.error(
          `[NetworkInterceptor] 📊 Track state when received: id=${track.id}, readyState=${track.readyState}, muted=${track.muted}, kind=${track.kind}`
        )

        // Set up track event listeners for logging
        track.addEventListener("ended", () => {
          console.error(`[NetworkInterceptor] 📊 Track event: ended for track ${track.id}`)
        })
        track.addEventListener("mute", () => {
          console.error(`[NetworkInterceptor] 📊 Track event: muted for track ${track.id}`)
        })
        track.addEventListener("unmute", () => {
          console.error(`[NetworkInterceptor] 📊 Track event: unmuted for track ${track.id}`)
        })

        console.error(
          `[NetworkInterceptor] 🎵 Starting audio frame processing for track: ${track.id}`
        )
        processAudioFrames(track, receiver, receiverManager, userManager, abortController.signal)
          .then((success) => {
            if (!success) {
              console.error(
                `[NetworkInterceptor] ⚠️ MediaStreamTrackProcessor failed for track: ${track.id}`
              )
              // Failure signal already sent in processAudioFrames() for timeout/immediate_failure cases
              // For processor_unavailable, signal was also sent
            } else {
              console.error(
                `[NetworkInterceptor] ✅ MediaStreamTrackProcessor succeeded for track: ${track.id}`
              )
            }
          })
          .catch((error) => {
            console.error(
              `[NetworkInterceptor] ❌ Error processing audio frames for track: ${track.id}:`,
              error
            )
            // Clean up AbortController since processing failed
            trackAbortControllers.delete(track.id)
            sendFailureSignal(track, "immediate_failure")
          })
      } catch (e) {
        console.error("[NetworkInterceptor] Audio Attach Error:", e)
      }
    }

    // ===== MAIN LOGIC =====

    const receiverManager = createReceiverManager()
    const userManager = createUserManager()
    let meetMessagesDataChannel: any = null
    const allDataChannels = new Map<string, any>()
    // Track current speaking state per device ID
    const speakingState = new Map<string, boolean>()
    // Track last broadcasted speaker to avoid duplicate broadcasts
    let lastBroadcastedSpeakerId: string | null = null
    // Track AbortControllers for audio processing loops (one per track)
    // Allows cancelling background processing when tracks end or are replaced
    const trackAbortControllers = new Map<string, AbortController>()
    // trackId → timestamp of the last frame actually read from that track.
    // This is the only proof the audio pipeline is alive; registration is not.
    const tracksDeliveringFrames = new Map<string, number>()

    // Stop counting a track once its reader is finished, whichever way it
    // finished — done, error or abort. Only the controller that still owns the
    // id may clear it: a replacement track can register a new controller under
    // the same id while this one is still unwinding, and clearing then would
    // erase the live track's health.
    function releaseTrackHealth(trackId: string, signal: AbortSignal) {
      if (trackAbortControllers.get(trackId)?.signal !== signal) return
      trackAbortControllers.delete(trackId)
      tracksDeliveringFrames.delete(trackId)
    }

    let csrcProbeMeetCalls = 0
    setupRTCRtpReceiverInterceptor((receiver, contributingSources) => {
      csrcProbeMeetCalls++
      updateContributingSources(receiverManager, receiver, contributingSources)
    })

    // Frame-independent CSRC speaker sampling. The frame loop only consults
    // contributing sources while audio frames flow, but prod shows sessions
    // where frames stall while Meet's own client keeps polling
    // getContributingSources (mirrored into receiverManager above, with real
    // audioLevel values — 0.447 measured during speech). Sample the mirror on
    // a timer and drive the same speaker state the frame loop uses; the shared
    // lastBroadcastedSpeakerId makes the two paths dedupe against each other.
    //
    // Freshness gate uses OUR arrival stamp (see sourceStamp): a receiver we
    // mirrored in the last 2s is live; the CSRC entry's own `timestamp` is on a
    // different clock and gating on it dropped every source (v6 correlation and
    // this sampler both came up empty while speech was clearly loud).
    const csrcSampleInterval = setInterval(() => {
      if ((window as any).__networkInterceptorStopped) return
      try {
        const freshSources: any[] = []
        const now = performance.now()
        for (const [receiver, sources] of receiverManager.receiverMap) {
          const stamp = receiverManager.sourceStamp.get(receiver)
          if (stamp === undefined || now - stamp >= 2000) continue
          for (const s of sources || []) {
            if (s) freshSources.push(s)
          }
        }
        if (freshSources.length === 0) return

        const usersWithAudioLevels = getUsersWithAudio(freshSources, userManager)
        const loudestSpeaker = usersWithAudioLevels[0]
        if (loudestSpeaker?.user) {
          const currentSpeakerId = loudestSpeaker.user.deviceId
          if (currentSpeakerId !== lastBroadcastedSpeakerId) {
            console.error(
              `[NetworkInterceptor] 🎤 Speaker changed (csrc sample): ${lastBroadcastedSpeakerId || "none"} → ${currentSpeakerId} (audioLevel: ${loudestSpeaker.audioLevel})`
            )
            lastBroadcastedSpeakerId = currentSpeakerId
            speakingState.clear()
            speakingState.set(currentSpeakerId, true)
            broadcastSpeakerUpdate(userManager, currentSpeakerId, loudestSpeaker.audioLevel, "audio")
          }
        } else if (lastBroadcastedSpeakerId !== null) {
          // Fresh packets but nobody above the audio-level threshold — mirrors
          // the frame loop's clearing rule for active audio with no speaker.
          lastBroadcastedSpeakerId = null
          speakingState.clear()
          broadcastSpeakerUpdate(userManager, null, 0, "audio")
        }
      } catch {
        // Sampling must never break the interceptor.
      }
    }, 500)

    // ===== CSRC AUDIO-LEVEL PROBE (read-only, temporary) =====
    // Speaker detection today reads contributing sources only inside the
    // audio-frame loop, so when Meet delivers no per-participant track frames
    // (~half of prod meetings) the CSRC data is never even looked at — although
    // Meet's own client may still be polling it for its speaking indicators.
    // This probe samples the receiver metadata on a timer, independent of
    // frames, and reports whether audioLevel is populated under our browser.
    // Counts only — no ids or names. Answers whether a frame-independent
    // CSRC/SSRC speaker path is viable here.
    const csrcProbeInterval = setInterval(() => {
      try {
        let csrcSources = 0
        let csrcWithLevel = 0
        let csrcMax = 0
        let ssrcSources = 0
        let ssrcWithLevel = 0
        let ssrcMax = 0
        let mapped = 0
        for (const [receiver, sources] of receiverManager.receiverMap) {
          for (const s of sources || []) {
            csrcSources++
            const lvl = s?.audioLevel || 0
            if (lvl > 0) {
              csrcWithLevel++
              if (lvl > csrcMax) csrcMax = lvl
            }
            if (s?.source != null && getUserByStreamId(userManager, s.source.toString())) mapped++
          }
          try {
            const sync = receiver.getSynchronizationSources?.() || []
            for (const s of sync) {
              ssrcSources++
              const lvl = s?.audioLevel || 0
              if (lvl > 0) {
                ssrcWithLevel++
                if (lvl > ssrcMax) ssrcMax = lvl
              }
            }
          } catch {
            // receiver may be closed; skip
          }
        }
        // Page console is not forwarded to the bot log in prod — report through
        // the same exposed callback the health check uses.
        if ((window as any).__networkInterceptorStopped) return
        if (typeof (window as any).onNetworkSpeakerUpdate === "function") {
          ;(window as any).onNetworkSpeakerUpdate({
            users: [],
            timestamp: Date.now(),
            source: "csrc_probe",
            probe: {
              receivers: receiverManager.receiverMap.size,
              meetCalls: csrcProbeMeetCalls,
              csrcSources,
              csrcWithLevel,
              csrcMax,
              ssrcSources,
              ssrcWithLevel,
              ssrcMax,
              mapped,
              timestamp: Date.now()
            }
          })
        }
      } catch (e) {
        console.error("[CsrcProbe] error:", e)
      }
    }, 30000)

    const broadcastCurrentState = () => {
      try {
        const allUsers = getAllUsers(userManager)
        if (allUsers.length === 0) return

        const filteredUsers = filterActiveUsers(allUsers)
        const users = filteredUsers.map((user: any) => {
          const isSpeaking = speakingState.get(user.deviceId) || false
          return {
            deviceId: user.deviceId,
            name: decodeUserName(user),
            isCurrentUser: !!(
              user.isCurrentUserString &&
              user.isCurrentUserString !== "" &&
              user.isCurrentUserString !== "false" &&
              user.isCurrentUserString !== "0"
            ),
            isSpeaking,
            status: user.status,
            isHost: user.isHost === 1,
            audioLevel: isSpeaking ? 1 : 0, // Default audio level for periodic broadcast
            fullName: decodeFullName(user),
            displayName: user.displayName,
            profilePicture: user.profilePicture
          }
        })

        // Note: We don't filter out bots - they'll appear in participants but not speakers (since they don't speak)
        if ((window as any).__networkInterceptorStopped) {
          return // Don't send callbacks if stopped
        }
        if (typeof (window as any).onNetworkSpeakerUpdate === "function") {
          ;(window as any).onNetworkSpeakerUpdate({
            users,
            timestamp: Date.now(),
            source: "roster"
          })
        }
      } catch (e) {
        console.error("[NetworkInterceptor] Broadcast error:", e)
      }
    }

    // Check if in meeting based on network participant count
    ;(window as any).__isNetworkInMeeting = () => {
      const users = filterActiveUsers(getAllUsers(userManager))
      return { inMeeting: users.length > 0, userCount: users.length }
    }

    // Stop network interception: abort all tracks and prevent further callbacks
    ;(window as any).__stopNetworkInterception = () => {
      console.error("[NetworkInterceptor] 🛑 Stopping network interception...")

      // Stop the probes and the CSRC sampler — the stop flag alone would
      // leave them polling forever and only suppress the reports.
      clearInterval(csrcProbeInterval)
      clearInterval(mediaProbeInterval)
      clearInterval(csrcSampleInterval)
      clearInterval(dcProbeInterval)
      // dcChannelInterval intentionally kept running past stop — see its comment.

      // Abort all active track controllers
      for (const [trackId, controller] of trackAbortControllers.entries()) {
        try {
          controller.abort()
          console.error(`[NetworkInterceptor] ✅ Aborted track ${trackId}`)
        } catch (err) {
          console.error(`[NetworkInterceptor] Error aborting track ${trackId}:`, err)
        }
      }
      trackAbortControllers.clear()
      tracksDeliveringFrames.clear()

      // Set flag to prevent further callbacks
      ;(window as any).__networkInterceptorStopped = true

      console.error("[NetworkInterceptor] ✅ Network interception stopped")
    }

    ;(window as any).triggerNetworkBroadcast = broadcastCurrentState

    const messageDecoders = createDecoders(schema)
    console.error("[NetworkInterceptor] ✅ Protobuf decoders ready")

    // ===== DATACHANNEL SPEAKING-SIGNAL PROBE (read-only, temporary) =====
    // On NetEq sessions audio is server-mixed, so there is no per-stream level
    // to read — but Meet still animates speaking rings, so a speaking signal
    // reaches the client somewhere. Our protobuf decoder skips every field not
    // in the schema, which would throw such a signal away. This probe raw-walks
    // each CollectionEvent and records which UNDECODED varint field paths toggle
    // between zero and non-zero over the meeting (a per-device speaking/level
    // field looks exactly like that), plus whether the datachannel is alive at
    // all on this session. Field NUMBERS and counts only — never field bytes,
    // so no names/text can leak.
    const dcProbe = {
      messages: 0,
      bytes: 0,
      isTop: window === window.top,
      // Underscore path "p1_9_2" (field numbers) — never dotted, so the PII
      // redactor cannot mistake it for an IP address and mangle it.
      // instMax/nzMax = most instances of this path (repeated fields = one per
      // device) and most simultaneously non-zero in a single message: nzMax==1
      // with instMax>1 is a single active-speaker flag; nzMax>1 is per-device.
      varintPaths: new Map<
        string,
        { z: boolean; nz: boolean; last: number; instMax: number; nzMax: number; max: number }
      >(),
      // v6 correlation of the field-9 candidate against the CSRC audio level for
      // the same stream. If field 9 means "speaking": onLoud dominates and the
      // cross terms (on while quiet / off while loud) stay small. Uses classic
      // sessions (where CSRC exists and is trusted) to decide what the field
      // means; the same field then carries the meaning onto NetEq sessions.
      corr: { onLoud: 0, onQuiet: 0, offLoud: 0, offQuiet: 0, samples: 0 },
      // v9: field-14 (NetEq active-speaker candidate) vs tap audio energy. If
      // field 14 means "active speaker": onSound dominates, cross terms small.
      // Uses the mixed-stream tap as ground truth, so it works on NetEq — where
      // CSRC (and the v6 correlation) do not exist.
      f14: { onSound: 0, onQuiet: 0, offSound: 0, offQuiet: 0, samples: 0, seen: false },
      // v8: the loud audio SSRC never resolves to a device (mapped>0 yet zero
      // speakers detected), so the CSRC SSRC and the deviceOutput streamId live
      // in different id spaces. Dump both spaces (hex, so the PII redactor can't
      // read them as phone/IP numbers) plus how often a loud SSRC lands in the
      // streamId set or the getSynchronizationSources set — that reveals the
      // mapping (identity? offset? sync-vs-contributing?).
      ssrc: {
        loudCsrc: new Set<string>(),
        allCsrc: new Set<string>(),
        syncSsrc: new Set<string>(),
        audioStreamIds: new Set<string>(),
        loudInStreamIds: 0,
        loudInSync: 0,
        loudSamples: 0
      }
    }
    function hx(n: any): string {
      const v = Number(n)
      return Number.isFinite(v) ? `x${(v >>> 0).toString(16)}` : "x?"
    }
    function dcProbeSsrcMap(deviceOutputs: any[]) {
      const s = dcProbe.ssrc
      const now = performance.now()
      // Audio deviceOutput streamIds (the map's key space).
      const audioIds = new Set<string>()
      for (const o of deviceOutputs || []) {
        if (o?.deviceOutputType === 1 && o?.streamId != null) {
          const h = hx(o.streamId)
          audioIds.add(h)
          if (s.audioStreamIds.size < 60) s.audioStreamIds.add(h)
        }
      }
      // Loud contributing-source SSRCs + synchronization-source SSRCs, from
      // receivers we mirrored recently.
      for (const [receiver, sources] of receiverManager.receiverMap) {
        const stamp = receiverManager.sourceStamp.get(receiver)
        const fresh = stamp !== undefined && now - stamp < 2000
        for (const src of sources || []) {
          if (src?.source == null) continue
          const h = hx(src.source)
          if (s.allCsrc.size < 60) s.allCsrc.add(h)
          if (fresh && (src.audioLevel || 0) > 0.05) {
            s.loudSamples++
            if (s.loudCsrc.size < 60) s.loudCsrc.add(h)
            if (audioIds.has(h)) s.loudInStreamIds++
          }
        }
        try {
          for (const sync of receiver.getSynchronizationSources?.() || []) {
            if (sync?.source != null && s.syncSsrc.size < 60) s.syncSsrc.add(hx(sync.source))
          }
        } catch {
          /* receiver closed */
        }
      }
      // Does a loud SSRC coincide with a synchronization SSRC?
      for (const h of s.loudCsrc) if (s.syncSsrc.has(h)) s.loudInSync++
    }
    // SSRCs whose most recent CSRC packet is loud, from a receiver we mirrored
    // in the last 2s (freshness on OUR arrival stamp, not the CSRC clock).
    function loudSsrcSet(): Set<string> {
      const loud = new Set<string>()
      const now = performance.now()
      for (const [receiver, sources] of receiverManager.receiverMap) {
        const stamp = receiverManager.sourceStamp.get(receiver)
        if (stamp === undefined || now - stamp >= 2000) continue
        for (const s of sources || []) {
          if (s && (s.audioLevel || 0) > 0.05 && s.source != null) {
            loud.add(String(s.source))
          }
        }
      }
      return loud
    }
    // v11: field 14 (deviceOutputActiveSpeaker) on ANY output type — v9/v10
    // wrongly required type 1/2 and only read sub-field 1. Read sub-fields
    // 1/2/3, treat an output "active" if ANY is non-zero, and tie it to a
    // stable masked device index (no PII) so we can see WHICH device lights up
    // against narrated speech. Also record which sub-field and output type
    // carry the signal, so we finally learn field 14's real shape.
    const f14DeviceIndex = new Map<string, number>()
    function maskDevice(deviceId: any): number {
      const key = String(deviceId ?? "")
      const seen = f14DeviceIndex.get(key)
      if (seen !== undefined) return seen
      const next = f14DeviceIndex.size
      f14DeviceIndex.set(key, next)
      return next
    }
    let lastF14Key = ""
    function dcProbeF14(deviceOutputs: any[]) {
      const sound = lastAudioActivityAt > 0 && performance.now() - lastAudioActivityAt < 1500
      const active: string[] = [] // "dev<idx>t<type>f<subfield>" for each active output
      let anyField14 = false
      for (const o of deviceOutputs || []) {
        const as = o?.deviceOutputActiveSpeaker
        if (as === undefined) continue
        anyField14 = true
        const sub = as.v1 ? 1 : as.v2 ? 2 : as.v3 ? 3 : 0
        if (sub !== 0) {
          active.push(`d${maskDevice(o?.deviceId)}t${o?.deviceOutputType ?? "?"}f${sub}`)
        }
      }
      if (!anyField14) return
      dcProbe.f14.seen = true
      dcProbe.f14.samples++
      const on = active.length > 0
      if (on && sound) dcProbe.f14.onSound++
      else if (on) dcProbe.f14.onQuiet++
      else if (sound) dcProbe.f14.offSound++
      else dcProbe.f14.offQuiet++
      // Live edge-triggered emit whenever the active set or sound flag changes.
      const key = `${active.slice().sort().join(",")}|${sound ? 1 : 0}`
      if (key !== lastF14Key) {
        lastF14Key = key
        if (typeof (window as any).onNetworkSpeakerUpdate === "function") {
          ;(window as any).onNetworkSpeakerUpdate({
            users: [],
            timestamp: Date.now(),
            source: "f14_live",
            f14live: { active, sound, at: Date.now() }
          })
        }
      }
    }
    // Fold one decoded CollectionEvent's device outputs into the correlation.
    function dcProbeCorrelate(deviceOutputs: any[]) {
      const loud = loudSsrcSet()
      for (const o of deviceOutputs || []) {
        // Audio outputs only (deviceOutputType 1); field 9 is per output.
        if (o?.deviceOutputType !== 1 || o?.streamId == null) continue
        const on = (o?.deviceOutputActivity?.value ?? 0) !== 0
        const isLoud = loud.has(String(o.streamId))
        dcProbe.corr.samples++
        if (on && isLoud) dcProbe.corr.onLoud++
        else if (on && !isLoud) dcProbe.corr.onQuiet++
        else if (!on && isLoud) dcProbe.corr.offLoud++
        else dcProbe.corr.offQuiet++
      }
    }
    function dcRawWalk(
      reader: any,
      end: number,
      path: string,
      depth: number,
      budget: { fields: number },
      msg: Map<string, { inst: number; nz: number }>
    ) {
      // Depth and distinct-path caps alone don't bound a payload with many
      // repeated fields on one path — this runs a second full parse inside the
      // datachannel message handler, so a hard field budget keeps it off the
      // renderer's critical path.
      if (depth > 6 || dcProbe.varintPaths.size > 250 || budget.fields <= 0) return
      while (reader.pos < end) {
        if (budget.fields-- <= 0) return
        let tag: number
        try {
          tag = reader.uint32()
        } catch {
          return
        }
        const fieldNumber = tag >>> 3
        const wireType = tag & 7
        const p = path ? `${path}_${fieldNumber}` : `p${fieldNumber}`
        try {
          if (wireType === 0) {
            const v = reader.uint32()
            const rec = dcProbe.varintPaths.get(p) || {
              z: false,
              nz: false,
              last: 0,
              instMax: 0,
              nzMax: 0,
              max: 0
            }
            if (v === 0) rec.z = true
            else rec.nz = true
            rec.last = v
            if (v > rec.max) rec.max = v
            dcProbe.varintPaths.set(p, rec)
            // Per-message instance counting for device correlation.
            const m = msg.get(p) || { inst: 0, nz: 0 }
            m.inst++
            if (v !== 0) m.nz++
            msg.set(p, m)
          } else if (wireType === 2) {
            const len = reader.uint32()
            const sub = reader.pos + len
            // Try to descend as a nested message; if the bytes are not valid
            // sub-fields, treat as an opaque leaf (string/bytes). Either way the
            // reader resumes exactly at the end of this field.
            try {
              dcRawWalk(reader, sub, p, depth + 1, budget, msg)
            } catch {
              /* opaque leaf */
            }
            reader.pos = sub
          } else if (wireType === 1) {
            reader.pos += 8
          } else if (wireType === 5) {
            reader.pos += 4
          } else {
            reader.skipType(wireType)
          }
        } catch {
          return
        }
      }
    }
    // One raw-walk over an inflated CollectionEvent, folding per-message
    // instance counts into the running instMax/nzMax.
    function dcProbeScan(inflated: Uint8Array) {
      dcProbe.messages++
      dcProbe.bytes += inflated.length
      const msg = new Map<string, { inst: number; nz: number }>()
      const reader = (window as any).protobuf.Reader.create(inflated)
      dcRawWalk(reader, reader.len, "", 0, { fields: 4000 }, msg)
      for (const [p, m] of msg) {
        const rec = dcProbe.varintPaths.get(p)
        if (!rec) continue
        if (m.inst > rec.instMax) rec.instMax = m.inst
        if (m.nz > rec.nzMax) rec.nzMax = m.nz
      }
    }

    const dcProbeInterval = setInterval(() => {
      if ((window as any).__networkInterceptorStopped) return
      // Child frames (recaptcha, feedback) run this bundle too and never see a
      // datachannel — stay silent there so they don't drown the top frame's
      // signal. The top frame reports even at zero so "no datachannel" is
      // visible.
      if (!dcProbe.isTop && dcProbe.messages === 0) return
      // Undecoded varint paths that flipped both ways = speaking-signal
      // candidates. instMax/nzMax reveal per-device (nzMax>1) vs single active
      // speaker (nzMax==1, instMax>1).
      const toggling = Array.from(dcProbe.varintPaths.entries())
        .filter(([, r]) => r.z && r.nz)
        .map(([p, r]) => `${p}=${r.last}(inst${r.instMax}/nz${r.nzMax}/max${r.max})`)
        .slice(0, 30)
      // Fields that take a RANGE of values (max>1) are candidate audio LEVELS —
      // richer than a binary speaking flag. Surfaced separately so we notice
      // them even if they never hit zero.
      const levels = Array.from(dcProbe.varintPaths.entries())
        .filter(([, r]) => r.max > 1)
        .map(([p, r]) => `${p}(max${r.max})`)
        .slice(0, 20)
      if (typeof (window as any).onNetworkSpeakerUpdate === "function") {
        ;(window as any).onNetworkSpeakerUpdate({
          users: [],
          timestamp: Date.now(),
          source: "dc_probe",
          dc: {
            messages: dcProbe.messages,
            bytes: dcProbe.bytes,
            distinctPaths: dcProbe.varintPaths.size,
            toggling,
            levels,
            corr: dcProbe.corr,
            f14: dcProbe.f14,
            ssrc: {
              loudCsrc: Array.from(dcProbe.ssrc.loudCsrc).slice(0, 20),
              audioStreamIds: Array.from(dcProbe.ssrc.audioStreamIds).slice(0, 20),
              syncSsrc: Array.from(dcProbe.ssrc.syncSsrc).slice(0, 20),
              allCsrc: Array.from(dcProbe.ssrc.allCsrc).slice(0, 20),
              loudInStreamIds: dcProbe.ssrc.loudInStreamIds,
              loudInSync: dcProbe.ssrc.loudInSync,
              loudSamples: dcProbe.ssrc.loudSamples
            },
            timestamp: Date.now()
          }
        })
      }
    }, 30000)

    const activeAudioTracks = new Map<
      string,
      { analyser: AnalyserNode; receiver?: RTCRtpReceiver }
    >()

    // SUBSCRIBE to centralized audio track layer
    // Wait for audio track layer to be available (audio capture script runs first, but may not be ready immediately)
    function subscribeToAudioTrackLayer() {
      const audioTrackLayer = (window as any).__audioTrackLayer
      if (audioTrackLayer && typeof audioTrackLayer.subscribe === "function") {
        console.error("[NetworkInterceptor] 🔌 Subscribing to centralized audio track layer")
        audioTrackLayer.subscribe({
          onTrack: (track: any, receiver: any) => {
            console.error(
              `[NetworkInterceptor] 🎵 Received track from centralized layer: ${track.id}`
            )
            monitorTrack(track, receiver, receiverManager, userManager, activeAudioTracks)
          }
        })
        return true
      }
      return false
    }

    // Health check mechanism to report audio processing status
    let healthCheckInterval: number | null = null

    function reportHealthCheck() {
      const audioTrackLayer = (window as any).__audioTrackLayer
      const subscribed = audioTrackLayer && typeof audioTrackLayer.subscribe === "function"
      // A registered track is NOT a working track. trackAbortControllers is
      // populated before processAudioFrames() even runs, and that function can
      // then sit waiting for the track to unmute or for a first frame that
      // never arrives — so counting registrations reported "Audio processing
      // active (3 tracks)" for a whole meeting that produced an empty
      // diarization file. Report what actually happened: how many tracks have
      // delivered at least one frame, and how long ago the last one arrived.
      const registeredTrackCount = trackAbortControllers.size
      const activeTrackCount = tracksDeliveringFrames.size
      const audioProcessingActive = activeTrackCount > 0
      const now = Date.now()
      let lastFrameAgeMs: number | null = null
      for (const at of tracksDeliveringFrames.values()) {
        const age = now - at
        if (lastFrameAgeMs === null || age < lastFrameAgeMs) lastFrameAgeMs = age
      }

      // Check if we had subscription errors
      let subscriptionError: string | null = null
      if (!subscribed && typeof audioTrackLayer === "undefined") {
        subscriptionError = "Audio track layer not found"
      } else if (!subscribed) {
        subscriptionError = "Audio track layer exists but subscribe function not available"
      }

      const health = {
        subscribed,
        activeTrackCount,
        registeredTrackCount,
        lastFrameAgeMs,
        audioProcessingActive,
        subscriptionError,
        timestamp: Date.now()
      }

      if ((window as any).__networkInterceptorStopped) {
        return // Don't send callbacks if stopped
      }
      if (typeof (window as any).onNetworkSpeakerUpdate === "function") {
        ;(window as any).onNetworkSpeakerUpdate({
          users: [],
          timestamp: Date.now(),
          source: "health_check",
          health
        })
      }
    }

    // Try to subscribe immediately
    if (!subscribeToAudioTrackLayer()) {
      console.error("[NetworkInterceptor] ⚠️ Audio track layer not ready yet, will retry...")
      // Retry after a short delay (audio capture script may still be initializing)
      let retryCount = 0
      const maxRetries = 10
      const retryInterval = setInterval(() => {
        retryCount++
        if (subscribeToAudioTrackLayer()) {
          console.error(
            `[NetworkInterceptor] ✅ Subscribed to audio track layer after ${retryCount} attempt(s)`
          )
          clearInterval(retryInterval)
          // Report health check after successful subscription
          setTimeout(() => reportHealthCheck(), 500)
        } else if (retryCount >= maxRetries) {
          console.error(
            "[NetworkInterceptor] ⚠️ WARNING: Centralized audio track layer not found after retries!"
          )
          console.error(
            "[NetworkInterceptor] ⚠️ Speaker detection will not work. Ensure audio-capture is enabled first."
          )
          clearInterval(retryInterval)
          // Report health check after failed subscription
          setTimeout(() => reportHealthCheck(), 500)
        }
      }, 100) // Check every 100ms

      // Report initial health check (not subscribed yet)
      setTimeout(() => reportHealthCheck(), 500)
    } else {
      // Report health check immediately if subscribed
      setTimeout(() => reportHealthCheck(), 1000)
    }

    // Report health check periodically (every 10 seconds) to monitor status
    healthCheckInterval = window.setInterval(() => {
      reportHealthCheck()
    }, 10000)

    // v12: per-datachannel-label raw traffic stats. counts messages/bytes and
    // how many landed while the tap reports sound — the channel whose traffic
    // tracks speech is the live speaker signal, even if we can't decode it yet.
    const dcChannels = new Map<
      string,
      { msgs: number; bytes: number; msgsWhileSound: number; lastLen: number }
    >()
    // Raw-decode a dcrpc/media-director frame (not gzip, not CollectionEvent):
    // walk the protobuf wire format and emit a compact field dump live, so the
    // active-speaker payload can be read against known speech. Field numbers +
    // varint values + string lengths only — no string bytes (avoid PII).
    function dcRpcWalk(bytes: Uint8Array, path: string, depth: number, out: string[]) {
      if (depth > 4 || out.length > 40) return
      const reader = (window as any).protobuf.Reader.create(bytes)
      let guard = 0
      while (reader.pos < reader.len && guard++ < 64) {
        let tag: number
        try {
          tag = reader.uint32()
        } catch {
          return
        }
        const field = tag >>> 3
        const wt = tag & 7
        const p = path ? `${path}.${field}` : `${field}`
        try {
          if (wt === 0) out.push(`${p}:v${reader.uint32()}`)
          else if (wt === 1) {
            reader.pos += 8
            out.push(`${p}:f64`)
          } else if (wt === 5) {
            reader.pos += 4
            out.push(`${p}:f32`)
          } else if (wt === 2) {
            const len = reader.uint32()
            const sub = new Uint8Array(bytes.buffer, bytes.byteOffset + reader.pos, len)
            reader.pos += len
            // Small blobs are almost always nested messages here — recurse; big
            // ones (roster/config) get a length marker only to stay compact.
            if (len > 0 && len <= 64) {
              out.push(`${p}{`)
              dcRpcWalk(sub, p, depth + 1, out)
              out.push(`}`)
            } else {
              out.push(`${p}:b${len}`)
            }
          } else {
            reader.skipType(wt)
          }
        } catch {
          return
        }
      }
    }
    function dcRpcDecode(label: string, bytes: Uint8Array) {
      const parts: string[] = []
      try {
        dcRpcWalk(bytes, "", 0, parts)
      } catch {
        /* partial parse is fine */
      }
      const sound = lastAudioActivityAt > 0 && performance.now() - lastAudioActivityAt < 1500
      if (typeof (window as any).onNetworkSpeakerUpdate === "function") {
        ;(window as any).onNetworkSpeakerUpdate({
          users: [],
          timestamp: Date.now(),
          source: "dcrpc_decode",
          rpc: { label, fields: parts.slice(0, 24), sound }
        })
      }
    }
    function dcChannelStat(label: string, len: number) {
      const sound = lastAudioActivityAt > 0 && performance.now() - lastAudioActivityAt < 1500
      const rec = dcChannels.get(label) || { msgs: 0, bytes: 0, msgsWhileSound: 0, lastLen: 0 }
      rec.msgs++
      rec.bytes += len
      rec.lastLen = len
      if (sound) rec.msgsWhileSound++
      dcChannels.set(label, rec)
    }
    // NOT gated on __networkInterceptorStopped and NOT cleared on stop: on
    // NetEq the diarization tracker stays empty, so the stale monitor retires
    // the "network path" within ~13s — but Meet keeps delivering datachannel
    // messages to the listeners, which is exactly what this probe measures.
    // Keep reporting past the fallback so speech can be correlated.
    const dcChannelInterval = setInterval(() => {
      if (dcChannels.size === 0) return
      const rows = Array.from(dcChannels.entries())
        .map(([l, r]) => `${l}:${r.msgs}m/${r.bytes}b/snd${r.msgsWhileSound}/len${r.lastLen}`)
        .slice(0, 20)
      if (typeof (window as any).onNetworkSpeakerUpdate === "function") {
        ;(window as any).onNetworkSpeakerUpdate({
          users: [],
          timestamp: Date.now(),
          source: "dc_channels",
          channels: rows
        })
      }
    }, 10000)

    // Decode + probe one datachannel message. Shared by every path a channel
    // can reach us — the passive "datachannel" event (remote-created channels)
    // AND createDataChannel (channels Meet builds locally, which the event
    // never fires for; missing those meant no roster/chat/speaker data at all
    // on those sessions).
    const handledChannels = new WeakSet<any>()
    function attachDcHandler(channel: any, label: string) {
      if (!channel || handledChannels.has(channel)) return
      handledChannels.add(channel)
      allDataChannels.set(label, channel)
      if (label === "meet_messages") {
        meetMessagesDataChannel = channel
        console.error("[NetworkInterceptor] 💬 Chat channel ready")
      }
      channel.addEventListener("message", (msg: any) => {
        try {
          const rawData = new Uint8Array(msg.data)
          // v12: count RAW messages per channel label BEFORE inflate. The
          // meet_messages CollectionEvent channel is roster/chat and nearly
          // silent (~2 msgs a meeting), yet Meet animates speaking rings — so
          // the live speaker signal is on another channel, likely one whose
          // frames are not gzip and get dropped at inflate below. Find the
          // channel that is busy during speech.
          dcChannelStat(label, rawData.length)
          // dcrpc carries the live speaker signal (message arrivals track
          // speech; confirmed against deterministic ground truth). Its frames
          // are small and NOT gzip, so they die at the inflate below — raw-walk
          // them here and emit the field values live to decode the payload.
          if (label === "dcrpc" || label === "media-director") {
            try {
              dcRpcDecode(label, rawData)
            } catch {
              /* probe must never break */
            }
          }
          try {
            if (
              typeof (window as any).pako === "undefined" ||
              typeof (window as any).pako.inflate !== "function"
            ) {
              throw new Error("pako.inflate is not available")
            }
            const inflated = (window as any).pako.inflate(rawData)
            // Probe: raw-walk the bytes for undecoded speaking-signal candidates.
            // Read-only, never touches the decoded pipeline below.
            try {
              dcProbeScan(inflated)
            } catch {
              /* probe must never break decoding */
            }
            const eventData = messageDecoders["CollectionEvent"](inflated)
            const body = eventData.body
            if (body) {
              const wrapper = body.userInfoListWrapperAndChatWrapperWrapper
              if (wrapper?.deviceInfoWrapper?.deviceOutputInfoList) {
                const deviceOutputs = wrapper.deviceInfoWrapper.deviceOutputInfoList
                updateDeviceOutputs(userManager, deviceOutputs)
                try {
                  dcProbeCorrelate(deviceOutputs)
                  dcProbeSsrcMap(deviceOutputs)
                  dcProbeF14(deviceOutputs)
                } catch {
                  /* probe must never break decoding */
                }
              }
              if (wrapper?.userInfoListWrapperAndChatWrapper?.userInfoListWrapper?.userInfoList) {
                const users =
                  wrapper.userInfoListWrapperAndChatWrapper.userInfoListWrapper.userInfoList
                updateUsers(userManager, users)
                console.error(`[NetworkInterceptor] 👥 Updated ${users.length} users`)
              }
              const chatMessages = wrapper?.userInfoListWrapperAndChatWrapper?.chatMessageWrapper
              if (chatMessages && chatMessages.length > 0) {
                for (const chatMsgWrapper of chatMessages) {
                  const chatMsg = chatMsgWrapper.chatMessage
                  if (chatMsg && chatMsg.chatMessageContent?.text) {
                    const senderUser = userManager.allUsersMap.get(chatMsg.deviceId)
                    const senderName = senderUser ? decodeUserName(senderUser) : "Unknown"
                    if (typeof (window as any).onChatMessageReceived === "function") {
                      ;(window as any).onChatMessageReceived({
                        messageId: chatMsg.messageId,
                        deviceId: chatMsg.deviceId,
                        timestamp: chatMsg.timestamp,
                        text: chatMsg.chatMessageContent.text,
                        senderName
                      })
                    }
                  }
                }
              }
            }
          } catch (e) {
            console.error(
              `[NetworkInterceptor] ⚠️ Failed to decode collections message on "${label}":`,
              e
            )
          }
        } catch (e) {
          console.error("[NetworkInterceptor] Critical Message Error:", e)
        }
      })
    }

    // Intercept RTCPeerConnection for datachannel only (track handling now centralized)
    if (typeof (window as any).RTCPeerConnection !== "undefined") {
      const OriginalPC = (window as any).RTCPeerConnection
      // biome-ignore lint/complexity/useArrowFunction: We need to use a function expression to avoid issues with the RTCPeerConnection object being replaced
      ;(window as any).RTCPeerConnection = function (...args: any[]) {
        mediaProbe.pcCreated++
        const pc = new OriginalPC(...args)

        // Track whether we"ve attempted proactive creation for this PC instance
        let hasAttemptedProactiveCreation = false

        // Locally-created channels (Meet builds meet_messages itself in many
        // sessions) never fire the "datachannel" event — catch them at the
        // source so roster/chat/speaker data flows on every session.
        const originalCreateDataChannel = pc.createDataChannel.bind(pc)
        pc.createDataChannel = (dcLabel: string, dcOpts: any) => {
          const channel = originalCreateDataChannel(dcLabel, dcOpts)
          try {
            console.error(`[NetworkInterceptor] 🔌 DataChannel created locally: "${dcLabel}"`)
            attachDcHandler(channel, dcLabel)
          } catch (e) {
            console.error("[NetworkInterceptor] Error attaching to created channel:", e)
          }
          return channel
        }

        // Passive path: remotely-created channels.
        pc.addEventListener("datachannel", (event: any) => {
          const label = event.channel.label
          console.error(`[NetworkInterceptor] 🔌 DataChannel attached: "${label}"`)
          attachDcHandler(event.channel, label)
        })

        // Proactive channel creation (disabled by default)
        // Google Meet typically creates the "meet_messages" channel itself
        // Only enable if passive listener doesn"t receive the channel
        if (ENABLE_PROACTIVE_MEET_CHANNEL) {
          setTimeout(() => {
            // Guard: Only attempt once per PC instance
            if (hasAttemptedProactiveCreation) {
              console.warn(
                "[NetworkInterceptor] ⚠️ Proactive creation already attempted for this PC"
              )
              return
            }
            hasAttemptedProactiveCreation = true

            // Guard: Check if channel already exists (received via passive listener)
            if (allDataChannels.has("meet_messages")) {
              console.error(
                "[NetworkInterceptor] ℹ️ meet_messages channel already exists (passive), skipping proactive creation"
              )
              return
            }

            // Guard: Check if we already have a working channel reference
            if (meetMessagesDataChannel) {
              console.error(
                "[NetworkInterceptor] ℹ️ meet_messages channel already set, skipping proactive creation"
              )
              return
            }

            try {
              console.error("[NetworkInterceptor] 🔨 Proactively creating meet_messages channel...")
              const meetMessagesChannel = pc.createDataChannel("meet_messages", { ordered: true })

              meetMessagesChannel.addEventListener("open", () => {
                meetMessagesDataChannel = meetMessagesChannel
                console.error("[NetworkInterceptor] ✅ Proactive chat channel ready")
              })

              meetMessagesChannel.addEventListener("close", () => {
                if (meetMessagesDataChannel === meetMessagesChannel) {
                  meetMessagesDataChannel = null
                }
              })
            } catch (e) {
              console.error("[NetworkInterceptor] ❌ Failed to create proactive chat channel:", e)
            }
          }, 100)
        } else {
          console.error(
            "[NetworkInterceptor] ℹ️ Proactive channel creation disabled, relying on passive listener"
          )
        }

        return pc
      }
    }
    // ===== EXPOSE CHAT MESSAGE SENDING =====
    ;(window as any)._sendChatMessage = async (messageText: string): Promise<boolean> => {
      try {
        console.error(`[NetworkInterceptor] 📤 Sending chat message: "${messageText}"`)

        // Check if meet_messages channel is available
        if (!meetMessagesDataChannel || meetMessagesDataChannel.readyState !== "open") {
          console.error("[NetworkInterceptor] ❌ meet_messages channel not available")
          return false
        }
        // Get current user for message metadata
        const allUsers = Array.from(userManager.allUsersMap.values())
        const currentUser = allUsers.find(
          (u: any) =>
            u.isCurrentUserString &&
            u.isCurrentUserString !== "" &&
            u.isCurrentUserString !== "false" &&
            u.isCurrentUserString !== "0"
        )

        if (!currentUser) {
          console.error("[NetworkInterceptor] ❌ Current user not found")
          return false
        }

        const timestampMillis = Date.now()

        // Initialize message counter
        if (!(window as any).__meetMessagesCounter) {
          ;(window as any).__meetMessagesCounter = 1
        }
        const messageCounter = (window as any).__meetMessagesCounter++

        // Build protobuf message structure
        // Structure: Field1[Field1[Field1(counter) + Field3[Field1[Field2[Field3(timestamp) + Field5[Field1(text)] + Field6(1)]]]]]

        // Layer 1: Text wrapper (Field 5 -> Field 1)
        const textWriter = (window as any).protobuf.Writer.create()
        textWriter.uint32((1 << 3) | 2)
        textWriter.string(messageText)
        const textBytes = textWriter.finish()

        // Layer 2: Message data (Field 3, Field 5, Field 6)
        const dataWriter = (window as any).protobuf.Writer.create()
        dataWriter.uint32((3 << 3) | 0)
        dataWriter.uint64(timestampMillis)
        dataWriter.uint32((5 << 3) | 2)
        dataWriter.bytes(textBytes)
        dataWriter.uint32((6 << 3) | 0)
        dataWriter.uint32(1)
        const dataBytes = dataWriter.finish()

        // Layer 3: Message wrapper (Field 2)
        const wrapperWriter = (window as any).protobuf.Writer.create()
        wrapperWriter.uint32((2 << 3) | 2)
        wrapperWriter.bytes(dataBytes)
        const wrapperBytes = wrapperWriter.finish()

        // Layer 4: Content wrapper (Field 1)
        const contentWriter = (window as any).protobuf.Writer.create()
        contentWriter.uint32((1 << 3) | 2)
        contentWriter.bytes(wrapperBytes)
        const contentBytes = contentWriter.finish()

        // Layer 5: Inner wrapper (Field 1 counter + Field 3 content)
        const innerWriter = (window as any).protobuf.Writer.create()
        innerWriter.uint32((1 << 3) | 0)
        innerWriter.uint32(messageCounter)
        innerWriter.uint32((3 << 3) | 2)
        innerWriter.bytes(contentBytes)
        const innerBytes = innerWriter.finish()

        // Layer 6: Double wrapper (Field 1)
        const doubleWriter = (window as any).protobuf.Writer.create()
        doubleWriter.uint32((1 << 3) | 2)
        doubleWriter.bytes(innerBytes)
        const doubleBytes = doubleWriter.finish()

        // Layer 7: Root message (Field 1)
        const rootWriter = (window as any).protobuf.Writer.create()
        rootWriter.uint32((1 << 3) | 2)
        rootWriter.bytes(doubleBytes)
        const finalMessage = rootWriter.finish()

        // Send message
        meetMessagesDataChannel.send(finalMessage)
        console.error("[NetworkInterceptor] ✅ Chat message sent successfully")
        return true
      } catch (e) {
        console.error("[NetworkInterceptor] ❌ Error sending message:", e)
        return false
      }
    }

    // Periodic state broadcasting
    const broadcastIntervalId = setInterval(() => {
      broadcastCurrentState()
    }, 5000)
    const broadcastTimeoutId = setTimeout(() => {
      broadcastCurrentState()
    }, 2000)

    // Clean up timers on page unload
    window.addEventListener("beforeunload", () => {
      clearInterval(broadcastIntervalId)
      clearTimeout(broadcastTimeoutId)
      if (healthCheckInterval !== null) {
        clearInterval(healthCheckInterval)
      }
    })

    const originalFetch = window.fetch
    window.fetch = async (...args) => {
      const url = args[0] instanceof Request ? args[0].url : args[0]
      const response = await originalFetch.apply(window, args)
      try {
        if (
          typeof url === "string" &&
          (url.includes("SyncMeetingSpaceCollections") || url.includes("meet/"))
        ) {
          const cloned = response.clone()
          const text = await cloned.text()
          try {
            const bytes = base64ToUint8Array(text)
            const decoded = messageDecoders["UserInfoListResponse"](bytes)
            if (decoded) {
              const userInfoList =
                decoded.userInfoListWrapperWrapper?.userInfoListWrapper?.userInfoList || []
              if (userInfoList.length > 0) {
                updateUsers(userManager, userInfoList)
                console.error(
                  `[NetworkInterceptor] 👥 Updated ${userInfoList.length} users from fetch`
                )
              }
            }
          } catch (decodeError) {
            // Log decode/base64 failures (no PII, just error type)
            const errorMsg =
              decodeError instanceof Error ? decodeError.message : "Unknown decode error"
            console.error("[NetworkInterceptor] Failed to decode fetch response:", {
              url: typeof url === "string" ? url.substring(0, 100) : "[non-string]",
              error: errorMsg
            })
          }
        }
      } catch (fetchError) {
        // Log fetch/runtime errors (no response body or PII)
        const errorMsg = fetchError instanceof Error ? fetchError.message : "Unknown fetch error"
        console.error("[NetworkInterceptor] Fetch override error:", {
          url: typeof url === "string" ? url.substring(0, 100) : "[non-string]",
          error: errorMsg
        })
      }
      return response
    }
  } catch (e: any) {
    console.error("[NetworkInterceptor] Fatal Error:", {
      name: e?.name,
      message: e?.message,
      stack: e?.stack
    })
  }
}
