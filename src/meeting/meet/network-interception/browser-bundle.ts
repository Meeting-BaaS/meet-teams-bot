// Single-file browser-side bundle (no imports to avoid module issues when stringified)
/** biome-ignore-all lint/suspicious/noExplicitAny: This is a browser-side bundle. If possible, we will add type definitions later. */

export function browserInterceptionLogic(schema: any[]) {
  try {
    // Guard against duplicate initialization to prevent:
    // - Stacking RTCPeerConnection/fetch overrides
    // - Leaking intervals
    // - Multiple event listeners
    if ((window as any).__networkInterceptorInitialized) {
      console.warn("[NetworkInterceptor] ⚠️ Already initialized, skipping duplicate initialization")
      return
    }
    ;(window as any).__networkInterceptorInitialized = true

    // Feature flag: Proactive datachannel creation
    // Set to false by default - Google Meet creates "meet_messages" channel itself
    // Only enable if passive listener fails to receive the channel
    const ENABLE_PROACTIVE_MEET_CHANNEL = false

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
        receiverToTrackMap: new Map()
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
    }

    function getContributingSources(receiverManager: any, receiver: any) {
      return receiverManager.receiverMap.get(receiver) || []
    }

    function linkReceiverToTrack(receiverManager: any, receiver: any, trackId: any) {
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
        if (onGetContributingSources && result && result.length > 0) {
          onGetContributingSources(this, result)
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

        // Read first frame to verify processing works before returning true
        // Add 60-second timeout to detect hanging tracks
        const TIMEOUT_MS = 60000 // 60 seconds
        const firstReadPromise = reader.read()
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout waiting for first frame")), TIMEOUT_MS)
        )

        let firstRead: any
        try {
          firstRead = await Promise.race([firstReadPromise, timeoutPromise])
        } catch (error: any) {
          if (error?.message === "Timeout waiting for first frame") {
            console.error(
              `[NetworkInterceptor] ⏱️ Timeout: No frames received for track ${track.id} within ${TIMEOUT_MS}ms`
            )
            console.error(
              `[NetworkInterceptor] 📊 Track state at timeout: id=${track.id}, readyState=${track.readyState}, muted=${track.muted}`
            )
            // Clean up AbortController since processing failed
            trackAbortControllers.delete(track.id)
            sendFailureSignal(track, "timeout")
            return false
          }
          throw error
        }

        if (firstRead.done) {
          console.error("[NetworkInterceptor] ⚠️ Audio stream ended immediately")
          // Clean up AbortController since processing failed
          trackAbortControllers.delete(track.id)
          sendFailureSignal(track, "immediate_failure")
          return false
        }
        if (firstRead.value) firstRead.value.close()

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
          trackAbortControllers.delete(track.id)
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

    setupRTCRtpReceiverInterceptor((receiver, contributingSources) => {
      updateContributingSources(receiverManager, receiver, contributingSources)
    })

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

      // Set flag to prevent further callbacks
      ;(window as any).__networkInterceptorStopped = true

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
      // Use trackAbortControllers to track active processing (tracks are added when processing starts)
      const activeTrackCount = trackAbortControllers.size
      const audioProcessingActive = activeTrackCount > 0

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

    // Intercept RTCPeerConnection for datachannel only (track handling now centralized)
    if (typeof (window as any).RTCPeerConnection !== "undefined") {
      const OriginalPC = (window as any).RTCPeerConnection
      // biome-ignore lint/complexity/useArrowFunction: We need to use a function expression to avoid issues with the RTCPeerConnection object being replaced
      ;(window as any).RTCPeerConnection = function (...args: any[]) {
        const pc = new OriginalPC(...args)

        // Track whether we"ve attempted proactive creation for this PC instance
        let hasAttemptedProactiveCreation = false

        // Only handle dataChannel - tracks are handled by centralized layer
        pc.addEventListener("datachannel", (event: any) => {
          const label = event.channel.label
          allDataChannels.set(label, event.channel)

          console.error(`[NetworkInterceptor] 🔌 DataChannel attached: "${label}"`)

          if (label === "meet_messages") {
            meetMessagesDataChannel = event.channel
            console.error("[NetworkInterceptor] 💬 Chat channel ready")
          }
          event.channel.addEventListener("message", (msg: any) => {
            try {
              const rawData = new Uint8Array(msg.data)
              try {
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
                  if (
                    wrapper?.userInfoListWrapperAndChatWrapper?.userInfoListWrapper?.userInfoList
                  ) {
                    const users =
                      wrapper.userInfoListWrapperAndChatWrapper.userInfoListWrapper.userInfoList
                    updateUsers(userManager, users)
                    console.error(`[NetworkInterceptor] 👥 Updated ${users.length} users`)
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
