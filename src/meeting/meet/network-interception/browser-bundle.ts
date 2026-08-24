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

    // Check if audio data contains meaningful audio
    function hasAudioActivity(audioData: Float32Array): boolean {
      return audioData.some((v) => Math.abs(v) > 0.001)
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

    // Emit a speaker update derived from the dcrpc datachannel (NetEq sessions).
    // Uses the same NetworkUser[] shape and "audio" source as the CSRC path, so
    // it flows through SpeakerManager.handleNetworkSpeakerUpdate identically.
    // Speaking device ids with no roster entry yet are still emitted (name
    // "Unknown", real deviceId) so the opening seconds are not dropped — the
    // finalize step relabels those segments by device once the roster resolves.
    // The `dcrpc: true` marker lets the node side note that the network path is
    // alive on NetEq without changing how the update is processed.
    function broadcastDcrpcSpeakers(userManager: any, speakingIds: string[]): void {
      if ((window as any).__networkInterceptorStopped) return
      if (typeof (window as any).onNetworkSpeakerUpdate !== "function") return

      const speakingSet = new Set(speakingIds)
      const filteredUsers = filterActiveUsers(getAllUsers(userManager))
      const seen = new Set<string>()
      const users = filteredUsers.map((user: any) => {
        seen.add(user.deviceId)
        const isSpeaking = speakingSet.has(user.deviceId)
        return {
          deviceId: user.deviceId,
          name: decodeUserName(user),
          isCurrentUser: user.isCurrentUserString === "true" || user.isCurrentUserString === "1",
          isSpeaking,
          status: user.status,
          isHost: user.isHost === 1,
          audioLevel: isSpeaking ? 1 : 0,
          fullName: decodeFullName(user),
          displayName: user.displayName,
          profilePicture: user.profilePicture
        }
      })
      for (const deviceId of speakingIds) {
        if (seen.has(deviceId)) continue
        users.push({
          deviceId,
          name: "Unknown",
          isCurrentUser: false,
          isSpeaking: true,
          status: 1,
          isHost: false,
          audioLevel: 1,
          fullName: undefined,
          displayName: undefined,
          profilePicture: undefined
        })
      }

      ;(window as any).onNetworkSpeakerUpdate({
        users,
        timestamp: Date.now(),
        source: "audio",
        dcrpc: true
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
    // Last set of speaking device ids emitted from the dcrpc path (sorted,
    // joined). dcrpc only drives an update when this set changes.
    let lastDcrpcSpeakingKey: string | null = null
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

    setupRTCRtpReceiverInterceptor((receiver: any, contributingSources: any) => {
      updateContributingSources(receiverManager, receiver, contributingSources)
    })

    // Frame-independent CSRC speaker sampling. The frame loop only consults
    // contributing sources while audio frames flow, but prod shows sessions
    // where frames stall while Meet's own client keeps polling
    // getContributingSources (mirrored into receiverManager above, with real
    // audioLevel values). Sample the mirror on a timer and drive the same
    // speaker state the frame loop uses; the shared lastBroadcastedSpeakerId
    // makes the two paths dedupe against each other.
    //
    // Freshness gate uses OUR arrival stamp (see sourceStamp): a receiver we
    // mirrored in the last 2s is live; the CSRC entry's own `timestamp` is on a
    // different clock and gating on it dropped every source.
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
      clearInterval(csrcSampleInterval)

      console.error("[NetworkInterceptor] ✅ Network interception stopped")
    }

    ;(window as any).triggerNetworkBroadcast = broadcastCurrentState

    const messageDecoders = createDecoders(schema)
    console.error("[NetworkInterceptor] ✅ Protobuf decoders ready")

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

    // Decode the active-speaker state carried on the dcrpc datachannel (NetEq
    // sessions). Returns the sorted set of speaking device ids for dedupe, or
    // null when the frame is a keepalive / not a state frame.
    function handleDcrpcFrame(rawData: Uint8Array): void {
      const decode = (window as any).__decodeDcrpcFrame
      const pako = (window as any).pako
      if (typeof decode !== "function" || !pako || typeof pako.inflate !== "function") {
        return
      }
      let participants: Array<{
        deviceId: string
        speaking: boolean
        numericIds?: string[]
      }> | null
      try {
        participants = decode(rawData, pako.inflate)
      } catch {
        return
      }
      if (participants === null) return // keepalive / non-state frame

      // Bridge the numeric device id(s) dcrpc carries for each participant to
      // their device-path, into the same ssrcToDeviceMap the CSRC path reads.
      // The force-native CSRC path resolves speakers by a raw numeric SSRC that
      // the roster (keyed by device-path) never maps, so those speakers land as
      // "Unknown"; this lets getUserByStreamId resolve them to the real name.
      for (const p of participants) {
        if (!p.deviceId || !p.numericIds || p.numericIds.length === 0) continue
        for (const numeric of p.numericIds) {
          if (userManager.ssrcToDeviceMap.get(numeric) === p.deviceId) continue
          userManager.ssrcToDeviceMap.set(numeric, p.deviceId)
          const asNumber = Number.parseInt(numeric, 10)
          if (!Number.isNaN(asNumber)) {
            userManager.ssrcToDeviceMap.set(asNumber, p.deviceId)
          }
          console.error(
            `[NetworkInterceptor] 🔗 dcrpc bridged numeric ${numeric} → device (roster-known: ${userManager.allUsersMap.has(p.deviceId)})`
          )
        }
      }

      const speakingIds: string[] = []
      for (const p of participants) {
        if (p.speaking) speakingIds.push(p.deviceId)
      }
      speakingIds.sort()
      const key = speakingIds.join("|")
      if (key === lastDcrpcSpeakingKey) return
      lastDcrpcSpeakingKey = key
      broadcastDcrpcSpeakers(userManager, speakingIds)
    }

    // Decode one datachannel message. Shared by every path a channel can reach
    // us — the passive "datachannel" event (remote-created channels) AND
    // createDataChannel (channels Meet builds locally, which the event never
    // fires for; missing those meant no roster/chat/speaker data at all on those
    // sessions). Deduped via a WeakSet so a channel is only wired once.
    const handledChannels = new WeakSet<any>()
    function attachDcHandler(channel: any, label: string) {
      if (!channel || handledChannels.has(channel)) return
      handledChannels.add(channel)
      allDataChannels.set(label, channel)

      console.error(`[NetworkInterceptor] 🔌 DataChannel attached: "${label}"`)

      if (label === "meet_messages") {
        meetMessagesDataChannel = channel
        console.error("[NetworkInterceptor] 💬 Chat channel ready")
      }
      channel.addEventListener("message", (msg: any) => {
        try {
          const rawData = new Uint8Array(msg.data)

          // dcrpc carries the live active-speaker signal on NetEq sessions. Its
          // frames are gzip'd per-participant state, not CollectionEvents, so
          // they never reach the collections decode below — handle them here.
          if (label === "dcrpc") {
            try {
              handleDcrpcFrame(rawData)
            } catch (e) {
              console.error("[NetworkInterceptor] dcrpc decode error:", e)
            }
            return
          }

          try {
            // CollectionEvents are always zlib/gzip framed. Since
            // createDataChannel now wraps every locally-created channel, this
            // branch also sees channels that never carry CollectionEvents — skip
            // those instead of inflating and logging a decode error per message
            // for the whole session. Match the full gzip signature (0x1f 0x8b),
            // not just the first byte, and validate the zlib header checksum.
            const isGzip =
              rawData.length >= 2 && rawData[0] === 0x1f && rawData[1] === 0x8b
            const isZlib =
              rawData.length >= 2 &&
              rawData[0] === 0x78 &&
              (((rawData[0] << 8) | rawData[1]) % 31 === 0)
            if (!isGzip && !isZlib) {
              return
            }
            // Defensive check for pako availability
            if (
              typeof (window as any).pako === "undefined" ||
              typeof (window as any).pako.inflate !== "function"
            ) {
              console.error(
                "[NetworkInterceptor] ⚠️ CRITICAL: pako library or pako.inflate function is not available"
              )
              console.warn(
                "[NetworkInterceptor] ⚠️ Cannot decode message - pako is required for decompression"
              )
              throw new Error("pako.inflate is not available")
            }
            const inflated = (window as any).pako.inflate(rawData)
            const eventData = messageDecoders["CollectionEvent"](inflated)
            const body = eventData.body
            if (body) {
              const wrapper = body.userInfoListWrapperAndChatWrapperWrapper
              if (wrapper?.deviceInfoWrapper?.deviceOutputInfoList) {
                const deviceOutputs = wrapper.deviceInfoWrapper.deviceOutputInfoList
                updateDeviceOutputs(userManager, deviceOutputs)
              }
              if (wrapper?.userInfoListWrapperAndChatWrapper?.userInfoListWrapper?.userInfoList) {
                const users =
                  wrapper.userInfoListWrapperAndChatWrapper.userInfoListWrapper.userInfoList
                updateUsers(userManager, users)
                console.error(`[NetworkInterceptor] 👥 Updated ${users.length} users`)
              }

              // Extract chat messages
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
                        senderName: senderName
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
        const pc = new OriginalPC(...args)

        // Track whether we"ve attempted proactive creation for this PC instance
        let hasAttemptedProactiveCreation = false

        // Locally-created channels (Meet builds meet_messages and dcrpc itself
        // in many sessions) never fire the "datachannel" event — catch them at
        // the source so roster/chat/speaker data flows on every session.
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
          attachDcHandler(event.channel, event.channel.label)
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
      clearInterval(csrcSampleInterval)
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
