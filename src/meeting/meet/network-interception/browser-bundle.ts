// Single-file browser-side bundle (no imports to avoid module issues when stringified)

export function browserInterceptionLogic(schema: any[]) {
    try {
        console.error('[NetworkInterceptor] ✅ Activated')

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
                        fullName = ''
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

            return 'Unknown'
        }

        function createMessageDecoder(messageType: any) {
            return function decode(readerOrBuffer: any, length?: number) {
                let reader = readerOrBuffer
                if (!(reader instanceof (window as any).protobuf.Reader)) {
                    reader = (window as any).protobuf.Reader.create(reader)
                }
                const end =
                    length === undefined ? reader.len : reader.pos + length
                const message: any = {}
                while (reader.pos < end) {
                    const tag = reader.uint32()
                    const fieldNumber = tag >>> 3
                    const wireType = tag & 7
                    const field = messageType.fields.find(
                        (f: any) => f.fieldNumber === fieldNumber,
                    )
                    if (!field) {
                        reader.skipType(wireType)
                        continue
                    }
                    let value
                    switch (field.type) {
                        case 'string':
                            value = reader.string()
                            break
                        case 'int64':
                            value = reader.int64()
                            break
                        case 'varint':
                            value = reader.uint32()
                            break
                        case 'bytes':
                            value = reader.bytes()
                            break
                        case 'message':
                            value = messageDecoders[field.messageType](
                                reader,
                                reader.uint32(),
                            )
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
            }
        }

        function createUserManager() {
            return {
                deviceOutputMap: new Map(),
                allUsersMap: new Map(),
                ssrcToDeviceMap: new Map(),
            }
        }

        function updateContributingSources(
            receiverManager: any,
            receiver: any,
            contributingSources: any,
        ) {
            receiverManager.receiverMap.set(receiver, contributingSources)
        }

        function getContributingSources(receiverManager: any, receiver: any) {
            return receiverManager.receiverMap.get(receiver) || []
        }

        function linkReceiverToTrack(
            receiverManager: any,
            receiver: any,
            trackId: any,
        ) {
            receiverManager.receiverToTrackMap.set(receiver, trackId)
        }

        function updateDeviceOutputs(userManager: any, deviceOutputs: any[]) {
            deviceOutputs
                .filter((o) => o && o.deviceId)
                .forEach((output) => {
                    const key = `${output.deviceId}-${output.deviceOutputType}`
                    const deviceOutput = {
                        deviceId: output.deviceId,
                        outputType: output.deviceOutputType,
                        streamId: output.streamId,
                        lastUpdated: Date.now(),
                    }
                    userManager.deviceOutputMap.set(key, deviceOutput)
                    if (output.streamId) {
                        userManager.ssrcToDeviceMap.set(
                            output.streamId,
                            output.deviceId,
                        )
                        const numericSSRC = parseInt(output.streamId, 10)
                        if (!isNaN(numericSSRC)) {
                            userManager.ssrcToDeviceMap.set(
                                numericSSRC,
                                output.deviceId,
                            )
                        }
                    }
                })
        }

        function updateUsers(userManager: any, users: any[]) {
            users
                .filter((u) => u && u.deviceId)
                .forEach((user) => {
                    userManager.allUsersMap.set(user.deviceId, user)
                })
        }

        function getAllUsers(userManager: any) {
            return Array.from(userManager.allUsersMap.values())
        }

        function getUserByStreamId(userManager: any, streamId: any) {
            let deviceId = userManager.ssrcToDeviceMap.get(streamId)
            if (!deviceId && typeof streamId !== 'string') {
                deviceId = userManager.ssrcToDeviceMap.get(streamId.toString())
            }
            if (!deviceId && typeof streamId === 'string') {
                const numericSSRC = parseInt(streamId, 10)
                if (!isNaN(numericSSRC)) {
                    deviceId = userManager.ssrcToDeviceMap.get(numericSSRC)
                }
            }
            if (deviceId) {
                return userManager.allUsersMap.get(deviceId)
            }
            const normalizedStreamId = streamId != null ? String(streamId) : null
            for (const deviceOutput of userManager.deviceOutputMap.values()) {
                const normalizedDeviceStreamId = deviceOutput.streamId != null ? String(deviceOutput.streamId) : null
                if (normalizedDeviceStreamId === normalizedStreamId) {
                    return userManager.allUsersMap.get(deviceOutput.deviceId)
                }
            }
            return null
        }

        function setupRTCRtpReceiverInterceptor(onGetContributingSources: any) {
            const OriginalRTCRtpReceiver = (window as any).RTCRtpReceiver
            if (
                !OriginalRTCRtpReceiver ||
                !OriginalRTCRtpReceiver.prototype.getContributingSources
            ) {
                console.error(
                    '[NetworkInterceptor] ⚠️ RTCRtpReceiver.getContributingSources not available',
                )
                return
            }
            const originalGetContributingSources =
                OriginalRTCRtpReceiver.prototype.getContributingSources
            OriginalRTCRtpReceiver.prototype.getContributingSources =
                function () {
                    const result = originalGetContributingSources.apply(
                        this,
                        arguments,
                    )
                    if (
                        onGetContributingSources &&
                        result &&
                        result.length > 0
                    ) {
                        onGetContributingSources(this, result)
                    }
                    return result
                }
            console.error(
                '[NetworkInterceptor] ✅ RTCRtpReceiver.getContributingSources intercepted',
            )
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
        function getUsersWithAudio(
            contributingSources: any[],
            userManager: any,
        ): any[] {
            return contributingSources
                .map((source) => ({
                    audioLevel: source?.audioLevel || 0,
                    ssrc: source.source,
                    timestamp: source.timestamp,
                    user: getUserByStreamId(userManager, source.source.toString()),
                }))
                .filter((x) => x.user && x.audioLevel > 0.05)
                .sort((a, b) => b.audioLevel - a.audioLevel)
        }

        // Build user state list with speaking status
        function buildUserStateList(
            filteredUsers: any[],
            speakingDeviceId: string | null,
            audioLevel: number = 0,
        ): any[] {
            return filteredUsers.map((user: any) => {
                const isCurrentlySpeaking = user.deviceId === speakingDeviceId
                return {
                    deviceId: user.deviceId,
                    name: decodeUserName(user),
                    isCurrentUser:
                        user.isCurrentUserString === 'true' ||
                        user.isCurrentUserString === '1',
                    isSpeaking: isCurrentlySpeaking,
                    status: user.status,
                    isHost: user.isHost === 1,
                    audioLevel: isCurrentlySpeaking ? audioLevel : 0,
                    fullName: decodeFullName(user),
                    displayName: user.displayName,
                    profilePicture: user.profilePicture,
                }
            })
        }

        // Broadcast speaker update with all users
        function broadcastSpeakerUpdate(
            userManager: any,
            speakingDeviceId: string | null,
            audioLevel: number = 0,
            source: string = 'audio',
        ): void {
            if (typeof (window as any).onNetworkSpeakerUpdate !== 'function') {
                return
            }

            const allUsers = getAllUsers(userManager)
            const filteredUsers = filterActiveUsers(allUsers)
            const users = buildUserStateList(filteredUsers, speakingDeviceId, audioLevel)

            ;(window as any).onNetworkSpeakerUpdate({
                users,
                timestamp: Date.now(),
                source,
            })
        }

        async function processAudioFrames(
            track: MediaStreamTrack,
            receiver: RTCRtpReceiver,
            receiverManager: any,
            userManager: any,
        ): Promise<boolean> {
            let reader: ReadableStreamDefaultReader<any> | null = null
            try {
                if (
                    typeof (window as any).MediaStreamTrackProcessor ===
                    'undefined' ||
                    typeof (window as any).MediaStreamTrackGenerator ===
                    'undefined'
                ) {
                    console.error(
                        '[NetworkInterceptor] ⚠️ MediaStreamTrackProcessor/Generator not available, using fallback',
                    )
                    return false
                }
                const processor = new (window as any).MediaStreamTrackProcessor(
                    { track },
                )
                reader = processor.readable.getReader()

                const processFrames = async () => {
                    try {
                        while (true) {
                            const { done, value: frame } = await reader.read()
                            if (done) break
                            if (!frame) continue

                            try {
                                // Extract and process audio data
                                const audioData = extractAudioData(frame)

                                if (hasAudioActivity(audioData)) {
                                    const contributingSources = getContributingSources(
                                        receiverManager,
                                        receiver,
                                    )

                                    if (contributingSources && contributingSources.length > 0) {
                                        const usersWithAudioLevels = getUsersWithAudio(
                                            contributingSources,
                                            userManager,
                                        )
                                        const loudestSpeaker = usersWithAudioLevels[0]

                                        if (loudestSpeaker?.user) {
                                            // Update speaking state - clear previous and set current speaker
                                            speakingState.clear()
                                            speakingState.set(loudestSpeaker.user.deviceId, true)

                                            // Broadcast with current speaker
                                            broadcastSpeakerUpdate(
                                                userManager,
                                                loudestSpeaker.user.deviceId,
                                                loudestSpeaker.audioLevel,
                                                'audio',
                                            )
                                        } else {
                                            // No speaker with meaningful audio - clear speaking state
                                            if (speakingState.size > 0) {
                                                speakingState.clear()
                                                broadcastSpeakerUpdate(userManager, null, 0, 'audio')
                                            }
                                        }
                                    } else {
                                        // No contributing sources - clear speaking state if set
                                        if (speakingState.size > 0) {
                                            speakingState.clear()
                                        }
                                    }
                                }

                                frame.close()
                            } catch (frameError) {
                                console.error(
                                    '[NetworkInterceptor] Frame Processing Error:',
                                    frameError,
                                )
                                if (frame) frame.close()
                            }
                        }
                    } catch (readError) {
                        console.error(
                            '[NetworkInterceptor] Reader Error:',
                            readError,
                        )
                    } finally {
                        if (reader) {
                            try {
                                await reader.cancel()
                                reader.releaseLock()
                            } catch { }
                        }
                    }
                }

                // Read first frame to verify processing works before returning true
                const firstRead = await reader.read()
                if (firstRead.done) {
                    console.error(
                        '[NetworkInterceptor] ⚠️ Audio stream ended immediately',
                    )
                    return false
                }
                if (firstRead.value) firstRead.value.close()

                console.error(
                    `[NetworkInterceptor] 🎬 Audio Frame Processing Started: ${track.id}`,
                )
                // Start background processing
                processFrames()
                return true
            } catch (e) {
                console.error(
                    '[NetworkInterceptor] Audio Frame Processing Setup Error:',
                    e,
                )
                return false
            }
        }

        function setupWebAudioMonitoring(
            track: MediaStreamTrack,
            receiver: RTCRtpReceiver,
            audioCtx: AudioContext,
            activeAudioTracks: Map<string, { analyser: AnalyserNode; receiver?: RTCRtpReceiver }>,
        ): void {
            try {
                if (audioCtx.state === 'suspended') audioCtx.resume()
                const stream = new MediaStream([track])
                const source = audioCtx.createMediaStreamSource(stream)
                const analyser = audioCtx.createAnalyser()
                analyser.fftSize = 256
                const gain = audioCtx.createGain()
                gain.gain.value = 0.001
                source.connect(analyser)
                analyser.connect(gain)
                gain.connect(audioCtx.destination)
                activeAudioTracks.set(track.id, { analyser, receiver })
                console.error(
                    `[NetworkInterceptor] 🎤 Web Audio Monitoring: ${track.id}`,
                )
                track.onended = () => {
                    activeAudioTracks.delete(track.id)
                }
            } catch (e) {
                console.error('[NetworkInterceptor] Web Audio Setup Error:', e)
            }
        }

        function monitorTrack(
            track: MediaStreamTrack,
            receiver: RTCRtpReceiver,
            receiverManager: any,
            userManager: any,
            audioCtx: AudioContext,
            activeAudioTracks: Map<string, { analyser: AnalyserNode; receiver?: RTCRtpReceiver }>,
        ): void {
            if (activeAudioTracks.has(track.id)) return
            try {
                linkReceiverToTrack(receiverManager, receiver, track.id)
                processAudioFrames(
                    track,
                    receiver,
                    receiverManager,
                    userManager,
                )
                    .then((success) => {
                        if (!success) {
                            setupWebAudioMonitoring(
                                track,
                                receiver,
                                audioCtx,
                                activeAudioTracks,
                            )
                        }
                    })
                    .catch(() => {
                        setupWebAudioMonitoring(
                            track,
                            receiver,
                            audioCtx,
                            activeAudioTracks,
                        )
                    })
            } catch (e) {
                console.error('[NetworkInterceptor] Audio Attach Error:', e)
            }
        }

        // ===== MAIN LOGIC =====

        const receiverManager = createReceiverManager()
        const userManager = createUserManager()
        let meetMessagesDataChannel: any = null
        const allDataChannels = new Map<string, any>()
        // Track current speaking state per device ID
        const speakingState = new Map<string, boolean>()

        setupRTCRtpReceiverInterceptor((receiver, contributingSources) => {
            updateContributingSources(
                receiverManager,
                receiver,
                contributingSources,
            )
        })

        const broadcastCurrentState = () => {
            try {
                const allUsers = getAllUsers(userManager)
                if (allUsers.length === 0) return

                // Find who is currently speaking from the state map
                const currentSpeakingDeviceId = Array.from(speakingState.entries())
                    .find(([_, isSpeaking]) => isSpeaking)?.[0] || null

                const filteredUsers = filterActiveUsers(allUsers)
                const users = filteredUsers.map((user: any) => {
                    const isSpeaking = speakingState.get(user.deviceId) || false
                    return {
                        deviceId: user.deviceId,
                        name: decodeUserName(user),
                        isCurrentUser: !!(
                            user.isCurrentUserString &&
                            user.isCurrentUserString !== '' &&
                            user.isCurrentUserString !== 'false' &&
                            user.isCurrentUserString !== '0'
                        ),
                        isSpeaking,
                        status: user.status,
                        isHost: user.isHost === 1,
                        audioLevel: isSpeaking ? 1 : 0, // Default audio level for periodic broadcast
                        fullName: decodeFullName(user),
                        displayName: user.displayName,
                        profilePicture: user.profilePicture,
                    }
                })

                if (typeof (window as any).onNetworkSpeakerUpdate === 'function') {
                    ;(window as any).onNetworkSpeakerUpdate({
                        users,
                        timestamp: Date.now(),
                        source: 'roster',
                    })
                }
            } catch (e) {
                console.error('[NetworkInterceptor] Broadcast error:', e)
            }
        }

            ; (window as any).triggerNetworkBroadcast = broadcastCurrentState

        const messageDecoders = createDecoders(schema)
        console.error('[NetworkInterceptor] ✅ Protobuf decoders ready')

        const audioCtx = new ((window as any).AudioContext ||
            (window as any).webkitAudioContext)()
        const activeAudioTracks = new Map<
            string,
            { analyser: AnalyserNode; ssrc?: string; receiver?: RTCRtpReceiver }
        >()

        if (typeof (window as any).RTCPeerConnection !== 'undefined') {
            const OriginalPC = (window as any).RTCPeerConnection
            ;(window as any).RTCPeerConnection = function (...args: any[]) {
                const pc = new OriginalPC(...args)
                pc.addEventListener('track', (event: any) => {
                    if (event.track.kind === 'audio') {
                        monitorTrack(
                            event.track,
                            event.receiver,
                            receiverManager,
                            userManager,
                            audioCtx,
                            activeAudioTracks,
                        )
                    }
                })
                pc.addEventListener('datachannel', (event: any) => {
                    const label = event.channel.label
                    allDataChannels.set(label, event.channel)

                    console.error(
                        `[NetworkInterceptor] 🔌 DataChannel attached: "${label}"`,
                    )

                    if (label === 'meet_messages') {
                        meetMessagesDataChannel = event.channel
                        console.error(
                            '[NetworkInterceptor] 💬 Chat channel ready',
                        )
                    }
                    event.channel.addEventListener('message', (msg: any) => {
                        try {
                            const rawData = new Uint8Array(msg.data)
                            try {
                                // Defensive check for pako availability
                                if (
                                    typeof (window as any).pako === 'undefined' ||
                                    typeof (window as any).pako.inflate !== 'function'
                                ) {
                                    console.error(
                                        '[NetworkInterceptor] ⚠️ CRITICAL: pako library or pako.inflate function is not available',
                                    )
                                    console.warn(
                                        '[NetworkInterceptor] ⚠️ Cannot decode message - pako is required for decompression',
                                    )
                                    throw new Error(
                                        'pako.inflate is not available',
                                    )
                                }
                                const inflated = (window as any).pako.inflate(
                                    rawData,
                                )
                                const eventData =
                                    messageDecoders['CollectionEvent'](inflated)
                                const body = eventData.body
                                if (body) {
                                    const wrapper =
                                        body.userInfoListWrapperAndChatWrapperWrapper
                                    if (
                                        wrapper?.deviceInfoWrapper
                                            ?.deviceOutputInfoList
                                    ) {
                                        const deviceOutputs =
                                            wrapper.deviceInfoWrapper
                                                .deviceOutputInfoList
                                        updateDeviceOutputs(
                                            userManager,
                                            deviceOutputs,
                                        )
                                    }
                                    if (
                                        wrapper
                                            ?.userInfoListWrapperAndChatWrapper
                                            ?.userInfoListWrapper?.userInfoList
                                    ) {
                                        const users =
                                            wrapper
                                                .userInfoListWrapperAndChatWrapper
                                                .userInfoListWrapper
                                                .userInfoList
                                        updateUsers(userManager, users)
                                        console.error(
                                            `[NetworkInterceptor] 👥 Updated ${users.length} users`,
                                        )
                                    }
                                }
                            } catch (e) {
                                console.error(
                                    `[NetworkInterceptor] ⚠️ Failed to decode collections message on "${label}":`,
                                    e,
                                )
                            }
                        } catch (e) {
                            console.error(
                                '[NetworkInterceptor] Critical Message Error:',
                                e,
                            )
                        }
                    })
                })

                    // Create meet_messages channel for chat functionality
                    setTimeout(() => {
                        try {
                            const meetMessagesChannel = pc.createDataChannel(
                                'meet_messages',
                                { ordered: true },
                            )

                            meetMessagesChannel.addEventListener('open', () => {
                                meetMessagesDataChannel = meetMessagesChannel
                                console.error(
                                    '[NetworkInterceptor] ✅ Chat channel ready',
                                )
                            })

                            meetMessagesChannel.addEventListener('close', () => {
                                if (
                                    meetMessagesDataChannel === meetMessagesChannel
                                ) {
                                    meetMessagesDataChannel = null
                                }
                            })
                        } catch (e) {
                            console.error(
                                '[NetworkInterceptor] ❌ Failed to create chat channel:',
                                e,
                            )
                        }
                    }, 100)

                    return pc
                }
        }

        // ===== EXPOSE CHAT MESSAGE SENDING =====
        ; (window as any)._sendChatMessage = async (
            messageText: string,
        ): Promise<boolean> => {
            try {
                console.error(
                    `[NetworkInterceptor] 📤 Sending chat message: "${messageText}"`,
                )

                // Check if meet_messages channel is available
                if (
                    !meetMessagesDataChannel ||
                    meetMessagesDataChannel.readyState !== 'open'
                ) {
                    console.error(
                        '[NetworkInterceptor] ❌ meet_messages channel not available',
                    )
                    return false
                }
                // Get current user for message metadata
                const allUsers = Array.from(userManager.allUsersMap.values())
                const currentUser = allUsers.find(
                    (u: any) =>
                        u.isCurrentUserString &&
                        u.isCurrentUserString !== '' &&
                        u.isCurrentUserString !== 'false' &&
                        u.isCurrentUserString !== '0',
                )

                if (!currentUser) {
                    console.error(
                        '[NetworkInterceptor] ❌ Current user not found',
                    )
                    return false
                }

                const timestampMillis = Date.now()

                // Initialize message counter
                if (!(window as any).__meetMessagesCounter) {
                    ; (window as any).__meetMessagesCounter = 1
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
                console.error(
                    '[NetworkInterceptor] ✅ Chat message sent successfully',
                )
                return true
            } catch (e) {
                console.error(
                    '[NetworkInterceptor] ❌ Error sending message:',
                    e,
                )
                return false
            }
        }

        setInterval(() => {
            broadcastCurrentState()
        }, 5000)
        setTimeout(() => {
            broadcastCurrentState()
        }, 2000)

        const originalFetch = window.fetch
        window.fetch = async function (...args) {
            const url = args[0] instanceof Request ? args[0].url : args[0]
            const response = await originalFetch.apply(window, args)
            try {
                if (
                    typeof url === 'string' &&
                    (url.includes('SyncMeetingSpaceCollections') ||
                        url.includes('meet/'))
                ) {
                    const cloned = response.clone()
                    const text = await cloned.text()
                    try {
                        const bytes = base64ToUint8Array(text)
                        const decoded =
                            messageDecoders['UserInfoListResponse'](bytes)
                        if (decoded) {
                            const userInfoList =
                                decoded.userInfoListWrapperWrapper
                                    ?.userInfoListWrapper?.userInfoList || []
                            if (userInfoList.length > 0) {
                                updateUsers(userManager, userInfoList)
                                console.error(
                                    `[NetworkInterceptor] 👥 Updated ${userInfoList.length} users from fetch`,
                                )
                            }
                        }
                    } catch { }
                }
            } catch { }
            return response
        }
    } catch (e: any) {
        console.error('[NetworkInterceptor] Fatal Error:', {
            name: e?.name,
            message: e?.message,
            stack: e?.stack,
        })
    }
}
