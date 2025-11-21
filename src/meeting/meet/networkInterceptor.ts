import * as fs from 'fs'
import { Page } from 'playwright'

// Protobuf schema definition (Keep exactly as is)
const PROTO_SCHEMA = [
    {
        name: 'CollectionEvent',
        fields: [
            {
                name: 'body',
                fieldNumber: 1,
                type: 'message',
                messageType: 'CollectionEventBody',
            },
        ],
    },
    {
        name: 'CollectionEventBody',
        fields: [
            {
                name: 'userInfoListWrapperAndChatWrapperWrapper',
                fieldNumber: 2,
                type: 'message',
                messageType: 'UserInfoListWrapperAndChatWrapperWrapper',
            },
        ],
    },
    {
        name: 'UserInfoListWrapperAndChatWrapperWrapper',
        fields: [
            {
                name: 'deviceInfoWrapper',
                fieldNumber: 3,
                type: 'message',
                messageType: 'DeviceInfoWrapper',
            },
            {
                name: 'userInfoListWrapperAndChatWrapper',
                fieldNumber: 13,
                type: 'message',
                messageType: 'UserInfoListWrapperAndChatWrapper',
            },
        ],
    },
    {
        name: 'UserInfoListWrapperAndChatWrapper',
        fields: [
            {
                name: 'userInfoListWrapper',
                fieldNumber: 1,
                type: 'message',
                messageType: 'UserInfoListWrapper',
            },
            {
                name: 'chatMessageWrapper',
                fieldNumber: 4,
                type: 'message',
                messageType: 'ChatMessageWrapper',
                repeated: true,
            },
        ],
    },
    {
        name: 'ChatMessageWrapper',
        fields: [
            {
                name: 'chatMessage',
                fieldNumber: 2,
                type: 'message',
                messageType: 'ChatMessage',
            },
        ],
    },
    {
        name: 'ChatMessage',
        fields: [
            { name: 'messageId', fieldNumber: 1, type: 'string' },
            { name: 'deviceId', fieldNumber: 2, type: 'string' },
            { name: 'timestamp', fieldNumber: 3, type: 'int64' },
            {
                name: 'chatMessageContent',
                fieldNumber: 5,
                type: 'message',
                messageType: 'ChatMessageContent',
            },
        ],
    },
    {
        name: 'ChatMessageContent',
        fields: [{ name: 'text', fieldNumber: 1, type: 'string' }],
    },
    {
        name: 'UserEventInfo',
        fields: [{ name: 'eventNumber', fieldNumber: 1, type: 'varint' }],
    },
    {
        name: 'UserInfoListWrapper',
        fields: [
            {
                name: 'userEventInfo',
                fieldNumber: 1,
                type: 'message',
                messageType: 'UserEventInfo',
            },
            {
                name: 'userInfoList',
                fieldNumber: 2,
                type: 'message',
                messageType: 'UserInfoList',
                repeated: true,
            },
        ],
    },
    {
        name: 'DeviceInfoWrapper',
        fields: [
            {
                name: 'deviceOutputInfoList',
                fieldNumber: 2,
                type: 'message',
                messageType: 'DeviceOutputInfoList',
                repeated: true,
            },
        ],
    },
    {
        name: 'DeviceOutputInfoList',
        fields: [
            { name: 'deviceOutputType', fieldNumber: 2, type: 'varint' }, // 1=audio, 2=video
            { name: 'streamId', fieldNumber: 4, type: 'string' }, // This IS the SSRC
            { name: 'deviceId', fieldNumber: 6, type: 'string' }, // The actual Device ID
            {
                name: 'deviceOutputStatus',
                fieldNumber: 10,
                type: 'message',
                messageType: 'DeviceOutputStatus',
            },
        ],
    },
    {
        name: 'DeviceOutputStatus',
        fields: [{ name: 'disabled', fieldNumber: 1, type: 'varint' }],
    },
    {
        name: 'UserInfoList',
        fields: [
            { name: 'deviceId', fieldNumber: 1, type: 'string' },
            { name: 'fullName', fieldNumber: 2, type: 'string' },
            { name: 'profilePicture', fieldNumber: 3, type: 'string' },
            { name: 'status', fieldNumber: 4, type: 'varint' },
            { name: 'isCurrentUserString', fieldNumber: 7, type: 'string' },
            { name: 'parentDeviceId', fieldNumber: 21, type: 'string' },
            { name: 'displayName', fieldNumber: 29, type: 'string' },
            { name: 'isHost', fieldNumber: 34, type: 'varint' },
        ],
    },
    // Fetch Response Wrapper
    {
        name: 'UserInfoListResponse',
        fields: [
            {
                name: 'userInfoListWrapperWrapper',
                fieldNumber: 2,
                type: 'message',
                messageType: 'UserInfoListWrapperWrapper',
            },
        ],
    },
    {
        name: 'UserInfoListWrapperWrapper',
        fields: [
            {
                name: 'userInfoListWrapper',
                fieldNumber: 2,
                type: 'message',
                messageType: 'UserInfoListWrapper',
            },
        ],
    },
]

function browserInterceptionLogic(schema: any[]) {
    try {
        console.error('[NetworkInterceptor] ✅ Activated')

        // --- Helper Functions ---
        function base64ToUint8Array(base64: string) {
            const binaryString = window.atob(base64)
            const len = binaryString.length
            const bytes = new Uint8Array(len)
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i)
            }
            return bytes
        }

        function uint8ArrayToBase64(bytes: Uint8Array) {
            let binary = ''
            const len = bytes.byteLength
            for (let i = 0; i < len; i++) {
                binary += String.fromCharCode(bytes[i])
            }
            return window.btoa(binary)
        }

        function bytesToHex(bytes: Uint8Array) {
            return Array.from(bytes)
                .map((b) => b.toString(16).padStart(2, '0'))
                .join(' ')
        }

        // --- REUSABLE COMPONENT 1: ReceiverManager ---
        class ReceiverManager {
            receiverMap: any
            receiverToTrackMap: any

            constructor() {
                this.receiverMap = new Map()
                this.receiverToTrackMap = new Map()
            }

            updateContributingSources(receiver: any, result: any) {
                this.receiverMap.set(receiver, result)
            }

            getContributingSources(receiver: any) {
                return this.receiverMap.get(receiver) || []
            }

            linkReceiverToTrack(receiver: any, trackId: any) {
                this.receiverToTrackMap.set(receiver, trackId)
            }

            getTrackIdForReceiver(receiver: any) {
                return this.receiverToTrackMap.get(receiver)
            }
        }

        // --- REUSABLE COMPONENT 2: UserManager ---
        class UserManager {
            deviceOutputMap: any
            allUsersMap: any
            ssrcToDeviceMap: any

            constructor() {
                this.deviceOutputMap = new Map() // Maps device-output pairs to stream info
                this.allUsersMap = new Map() // Maps device IDs to user info
                this.ssrcToDeviceMap = new Map() // Maps SSRC to device ID
            }

            // Update device output mapping (device ID -> stream ID)
            updateDeviceOutputs(deviceOutputs: any[]) {
                for (const output of deviceOutputs) {
                    const key = `${output.deviceId}-${output.deviceOutputType}`
                    const deviceOutput = {
                        deviceId: output.deviceId,
                        outputType: output.deviceOutputType, // 1=audio, 2=video
                        streamId: output.streamId, // This IS the SSRC
                        lastUpdated: Date.now(),
                    }
                    this.deviceOutputMap.set(key, deviceOutput)

                    // Map streamId (SSRC) to device ID
                    if (output.streamId) {
                        // Store as string
                        this.ssrcToDeviceMap.set(
                            output.streamId,
                            output.deviceId,
                        )
                        // Also try mapping as number since contributing sources might return numbers
                        const numericSSRC = parseInt(output.streamId, 10)
                        if (!isNaN(numericSSRC)) {
                            this.ssrcToDeviceMap.set(
                                numericSSRC,
                                output.deviceId,
                            )
                        }
                    }
                }
            }

            // Update user info
            updateUsers(users: any[]) {
                for (const user of users) {
                    if (user.deviceId) {
                        this.allUsersMap.set(user.deviceId, user)
                    }
                }
            }

            // Find user by their stream ID (SSRC)
            getUserByStreamId(streamId: any) {
                // Try direct lookup first (as-is)
                let deviceId = this.ssrcToDeviceMap.get(streamId)

                // Try as string
                if (!deviceId && typeof streamId !== 'string') {
                    deviceId = this.ssrcToDeviceMap.get(streamId.toString())
                }

                // Try as number
                if (!deviceId && typeof streamId === 'string') {
                    const numericSSRC = parseInt(streamId, 10)
                    if (!isNaN(numericSSRC)) {
                        deviceId = this.ssrcToDeviceMap.get(numericSSRC)
                    }
                }

                if (deviceId) {
                    return this.allUsersMap.get(deviceId)
                }

                // Fallback: Look through device outputs to find matching stream
                for (const deviceOutput of this.deviceOutputMap.values()) {
                    if (
                        deviceOutput.streamId === streamId ||
                        deviceOutput.streamId === streamId.toString() ||
                        deviceOutput.streamId === String(streamId)
                    ) {
                        return this.allUsersMap.get(deviceOutput.deviceId)
                    }
                }
                return null
            }

            getAllUsers() {
                return Array.from(this.allUsersMap.values())
            }
        }

        // --- REUSABLE COMPONENT 3: RTCRtpReceiverInterceptor ---
        class RTCRtpReceiverInterceptor {
            constructor(onGetContributingSources: any) {
                // Store the original method
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

                // Replace with intercepted version
                OriginalRTCRtpReceiver.prototype.getContributingSources =
                    function () {
                        // Call original method
                        const result = originalGetContributingSources.apply(
                            this,
                            arguments,
                        )

                        // Callback with receiver and result
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
        }

        // Initialize managers
        const receiverManager = new ReceiverManager()
        const userManager = new UserManager()

        // Initialize RTCRtpReceiver interceptor
        new RTCRtpReceiverInterceptor((receiver, contributingSources) => {
            receiverManager.updateContributingSources(
                receiver,
                contributingSources,
            )

            // Logs reduced for performance
        })

        // Broadcast current state function
        const broadcastCurrentState = () => {
            try {
                const allUsers = userManager.getAllUsers()
                if (allUsers.length === 0) return

                // Helper to decode fullName if it's Uint8Array
                const decodeUserName = (user: any) => {
                    if (user.displayName) return user.displayName
                    if (user.fullName) {
                        if (user.fullName instanceof Uint8Array) {
                            try {
                                return new TextDecoder().decode(user.fullName)
                            } catch {
                                return 'Unknown'
                            }
                        }
                        return user.fullName
                    }
                    return 'Unknown'
                }

                // Build user list with speaking status
                const users = allUsers.map((user: any) => ({
                    deviceId: user.deviceId,
                    name: decodeUserName(user),
                    isCurrentUser:
                        user.isCurrentUserString === 'true' ||
                        user.isCurrentUserString === '1',
                    isSpeaking: false, // Will be updated by audio frame processor
                    status: user.status,
                    isHost: user.isHost === 1,
                }))

                // Send to Node.js
                if (
                    typeof (window as any).onNetworkSpeakerUpdate === 'function'
                ) {
                    ;(window as any).onNetworkSpeakerUpdate({
                        users,
                        timestamp: Date.now(),
                        source: 'roster',
                    })
                    console.error(
                        `[NetworkInterceptor] 📢 Broadcast: ${users.length} users`,
                    )
                }
            } catch (e) {
                console.error('[NetworkInterceptor] Broadcast error:', e)
            }
        }

        // Expose broadcast function to be called manually
        ;(window as any).triggerNetworkBroadcast = broadcastCurrentState

        // --- Protobuf Setup: Use CUSTOM decoder like working JS code ---
        const messageDecoders: { [key: string]: any } = {}

        // Generic message decoder factory (SAME AS WORKING JS CODE)
        function createMessageDecoder(messageType: any) {
            return function decode(reader: any, length?: number) {
                if (!(reader instanceof (window as any).protobuf.Reader)) {
                    reader = (window as any).protobuf.Reader.create(reader)
                }

                const end =
                    length === undefined ? reader.len : reader.pos + length
                const message: any = {}

                while (reader.pos < end) {
                    const tag = reader.uint32()
                    const fieldNumber = tag >>> 3

                    const field = messageType.fields.find(
                        (f: any) => f.fieldNumber === fieldNumber,
                    )
                    if (!field) {
                        reader.skipType(tag & 7)
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
                            reader.skipType(tag & 7)
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

        // Create decoders for all message types
        schema.forEach((type: any) => {
            messageDecoders[type.name] = createMessageDecoder(type)
        })

        // --- Audio Monitoring State ---
        const audioCtx = new ((window as any).AudioContext ||
            (window as any).webkitAudioContext)()
        const activeAudioTracks = new Map<
            string,
            { analyser: AnalyserNode; ssrc?: string; receiver?: any }
        >()
        const trackIdToSSRC = new Map<string, string>()

        // --- REUSABLE COMPONENT 4: Audio Frame Processor ---
        async function processAudioFrames(track: any, receiver: any) {
            let reader: any = null

            try {
                // Check if MediaStreamTrackProcessor is available
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

                console.error(
                    `[NetworkInterceptor] 🎬 Audio Frame Processing Started: ${track.id}`,
                )

                // Helper to decode fullName if it's Uint8Array
                const decodeUserName = (user: any) => {
                    if (user.displayName) return user.displayName
                    if (user.fullName) {
                        // If it's bytes, decode it
                        if (user.fullName instanceof Uint8Array) {
                            try {
                                // Try to decode as UTF-8
                                return new TextDecoder().decode(user.fullName)
                            } catch {
                                return 'Unknown'
                            }
                        }
                        return user.fullName
                    }
                    return 'Unknown'
                }

                // Process frames in a loop
                ;(async () => {
                    try {
                        while (true) {
                            const { done, value: frame } = await reader.read()
                            if (done) break
                            if (!frame) continue

                            try {
                                // Extract audio data from frame
                                const numChannels = frame.numberOfChannels
                                const numSamples = frame.numberOfFrames
                                const audioData = new Float32Array(numSamples)

                                // Convert to mono if needed
                                if (numChannels > 1) {
                                    const channelData = new Float32Array(
                                        numSamples,
                                    )
                                    for (
                                        let channel = 0;
                                        channel < numChannels;
                                        channel++
                                    ) {
                                        frame.copyTo(channelData, {
                                            planeIndex: channel,
                                        })
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

                                // Check if audio has content (not silence)
                                const hasAudio = audioData.some(
                                    (v) => Math.abs(v) > 0.001,
                                )

                                if (hasAudio) {
                                    // Get attribution from contributing sources
                                    const contributingSources =
                                        receiverManager.getContributingSources(
                                            receiver,
                                        )

                                    if (
                                        contributingSources &&
                                        contributingSources.length > 0
                                    ) {
                                        // Map SSRCs to users with audio levels
                                        const usersWithAudioLevels =
                                            contributingSources
                                                .map((source) => ({
                                                    audioLevel:
                                                        source?.audioLevel || 0,
                                                    ssrc: source.source,
                                                    timestamp: source.timestamp,
                                                    user: userManager.getUserByStreamId(
                                                        source.source.toString(),
                                                    ),
                                                }))
                                                .filter(
                                                    (x) =>
                                                        x.user &&
                                                        x.audioLevel > 0.05,
                                                ) // Only keep entries with valid users and meaningful audio
                                                .sort(
                                                    (a, b) =>
                                                        b.audioLevel -
                                                        a.audioLevel,
                                                ) // Sort by loudness

                                        // Get the loudest speaker
                                        const loudestSpeaker =
                                            usersWithAudioLevels[0]

                                        if (loudestSpeaker?.user) {
                                            const userName = decodeUserName(
                                                loudestSpeaker.user,
                                            )

                                            console.error(
                                                '[NetworkInterceptor] 🗣️ Audio Attributed:',
                                                {
                                                    userName,
                                                    deviceId:
                                                        loudestSpeaker.user
                                                            .deviceId,
                                                    audioLevel:
                                                        loudestSpeaker.audioLevel.toFixed(
                                                            3,
                                                        ),
                                                    ssrc: loudestSpeaker.ssrc,
                                                    trackId: track.id.substring(
                                                        0,
                                                        8,
                                                    ),
                                                    samples: numSamples,
                                                },
                                            )

                                            // Broadcast speaker info to Node.js
                                            if (
                                                typeof (window as any)
                                                    .onNetworkSpeakerUpdate ===
                                                'function'
                                            ) {
                                                // Get all users and mark the speaking one
                                                const allUsers =
                                                    userManager.getAllUsers()
                                                const users = allUsers.map(
                                                    (user: any) => {
                                                        const decodedName =
                                                            decodeUserName(user)
                                                        return {
                                                            deviceId:
                                                                user.deviceId,
                                                            name: decodedName,
                                                            isCurrentUser:
                                                                user.isCurrentUserString ===
                                                                    'true' ||
                                                                user.isCurrentUserString ===
                                                                    '1',
                                                            isSpeaking:
                                                                user.deviceId ===
                                                                loudestSpeaker
                                                                    .user
                                                                    .deviceId,
                                                            status: user.status,
                                                            isHost:
                                                                user.isHost ===
                                                                1,
                                                            audioLevel:
                                                                user.deviceId ===
                                                                loudestSpeaker
                                                                    .user
                                                                    .deviceId
                                                                    ? loudestSpeaker.audioLevel
                                                                    : 0,
                                                        }
                                                    },
                                                )

                                                ;(
                                                    window as any
                                                ).onNetworkSpeakerUpdate({
                                                    users,
                                                    timestamp: Date.now(),
                                                    source: 'audio',
                                                })
                                            }
                                        }
                                    }
                                }

                                // Close the frame
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
                            } catch {}
                        }
                    }
                })()

                return true
            } catch (e) {
                console.error(
                    '[NetworkInterceptor] Audio Frame Processing Setup Error:',
                    e,
                )
                return false
            }
        }

        function setupWebAudioMonitoring(track: any, receiver: any) {
            try {
                if (audioCtx.state === 'suspended') audioCtx.resume()

                const stream = new MediaStream([track])
                const source = audioCtx.createMediaStreamSource(stream)
                const analyser = audioCtx.createAnalyser()
                analyser.fftSize = 256
                const gain = audioCtx.createGain()
                gain.gain.value = 0.001 // Mute but keep processing

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
        ) {
            if (activeAudioTracks.has(track.id)) return

            try {
                // Link receiver to track in manager
                receiverManager.linkReceiverToTrack(receiver, track.id)

                // Try to use audio frame processing first (preferred method)
                processAudioFrames(track, receiver).then((success) => {
                    if (!success) {
                        // Fallback to Web Audio API monitoring
                        setupWebAudioMonitoring(track, receiver)
                    }
                })

                // Also set up Web Audio API as backup for volume monitoring
                setupWebAudioMonitoring(track, receiver)
            } catch (e) {
                console.error('[NetworkInterceptor] Audio Attach Error:', e)
            }
        }

        // --- WebRTC Interceptor ---
        if (typeof (window as any).RTCPeerConnection !== 'undefined') {
            const OriginalPC = (window as any).RTCPeerConnection
            ;(window as any).RTCPeerConnection = function (...args: any[]) {
                const pc = new OriginalPC(...args)

                // 1. Intercept Audio Tracks
                pc.addEventListener('track', (event: any) => {
                    if (event.track.kind === 'audio') {
                        monitorTrack(event.track, event.receiver)
                    }
                })

                // 2. Intercept Data Channels
                pc.addEventListener('datachannel', (event: any) => {
                    const label = event.channel.label
                    console.error(
                        `[NetworkInterceptor] 🔌 DataChannel Attached: "${label}"`,
                    )

                    event.channel.addEventListener('message', (msg: any) => {
                        try {
                            const rawData = new Uint8Array(msg.data)

                            // Try to decode as CollectionEvent
                            try {
                                const inflated = (window as any).pako.inflate(
                                    rawData,
                                )
                                const eventData =
                                    messageDecoders['CollectionEvent'](inflated)
                                const body = eventData.body

                                if (body) {
                                    // Log what's actually in the body
                                    const wrapper =
                                        body.userInfoListWrapperAndChatWrapperWrapper

                                    // Extract and update device outputs
                                    if (
                                        wrapper?.deviceInfoWrapper
                                            ?.deviceOutputInfoList
                                    ) {
                                        const deviceOutputs =
                                            wrapper.deviceInfoWrapper
                                                .deviceOutputInfoList
                                        userManager.updateDeviceOutputs(
                                            deviceOutputs,
                                        )
                                    }

                                    // Extract and update user info
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
                                        userManager.updateUsers(users)
                                        console.error(
                                            `[NetworkInterceptor] 👥 Updated ${users.length} users`,
                                        )
                                    }

                                    console.error(
                                        `dump::${label}::body`,
                                        JSON.stringify(
                                            body,
                                            (key, value) => {
                                                if (
                                                    key.startsWith('field') &&
                                                    value &&
                                                    value.constructor ===
                                                        Uint8Array
                                                ) {
                                                    return `[Bytes: ${value.length}]`
                                                }
                                                return typeof value === 'bigint'
                                                    ? value.toString()
                                                    : value
                                            },
                                            2,
                                        ),
                                    )
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

                // 3. Poll Stats for SSRC
                setInterval(async () => {
                    try {
                        const stats = await pc.getStats()
                        stats.forEach((report: any) => {
                            if (
                                report.type === 'inbound-rtp' &&
                                report.kind === 'audio'
                            ) {
                                if (report.trackIdentifier) {
                                    if (report.ssrc) {
                                        trackIdToSSRC.set(
                                            report.trackIdentifier,
                                            String(report.ssrc),
                                        )
                                        const trackInfo = activeAudioTracks.get(
                                            report.trackIdentifier,
                                        )
                                        if (trackInfo)
                                            trackInfo.ssrc = String(report.ssrc)
                                    }
                                }
                            }
                        })
                    } catch {}
                }, 2000)

                return pc
            }
        }

        // --- Audio Level Poller (Fallback for browsers without MediaStreamTrackProcessor) ---
        setInterval(() => {
            const dataArray = new Uint8Array(128)
            activeAudioTracks.forEach((info, trackId) => {
                info.analyser.getByteFrequencyData(dataArray)
                let sum = 0
                for (let i = 0; i < dataArray.length; i++) sum += dataArray[i]
                const vol = sum / dataArray.length

                // Audio log reduced for performance
            })
        }, 500)

        // --- Periodic Roster Broadcast (Every 5 seconds) ---
        setInterval(() => {
            broadcastCurrentState()
        }, 5000)

        // Initial broadcast after a short delay to let data populate
        setTimeout(() => {
            broadcastCurrentState()
        }, 2000)

        // --- Fetch Interceptor ---
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
                            // Extract and update user info from fetch response
                            const userInfoList =
                                decoded.userInfoListWrapperWrapper
                                    ?.userInfoListWrapper?.userInfoList || []
                            if (userInfoList.length > 0) {
                                userManager.updateUsers(userInfoList)
                                console.error(
                                    `[NetworkInterceptor] 👥 Updated ${userInfoList.length} users from fetch`,
                                )
                            }

                            // Deep scan for fullName to decode
                            const scanForFullName = (obj: any) => {
                                if (!obj) return
                                if (typeof obj === 'object') {
                                    // Check for fullName as BYTES (Uint8Array)
                                    if (
                                        obj.fullName &&
                                        obj.fullName.constructor === Uint8Array
                                    ) {
                                        try {
                                            const rawBytes =
                                                obj.fullName as Uint8Array
                                            obj.fullName_HEX =
                                                bytesToHex(rawBytes)
                                            obj.fullName_Base64 =
                                                uint8ArrayToBase64(rawBytes)

                                            // Try to decode as UserExtraInfo
                                            try {
                                                const extra =
                                                    messageDecoders[
                                                        'UserExtraInfo'
                                                    ](rawBytes)
                                                obj.fullName_decoded = extra
                                            } catch (e) {
                                                obj.fullName_decode_error =
                                                    e.toString()
                                            }
                                        } catch (e) {
                                            obj.fullName_error = e.toString()
                                        }
                                    }
                                    for (const key in obj) {
                                        if (
                                            Object.prototype.hasOwnProperty.call(
                                                obj,
                                                key,
                                            ) &&
                                            typeof obj[key] === 'object' &&
                                            obj[key] !== null
                                        ) {
                                            scanForFullName(obj[key])
                                        }
                                    }
                                }
                            }
                            scanForFullName(decoded)
                        }
                    } catch {}
                }
            } catch {}
            return response
        }

        // --- XHR Interceptor ---
        const OriginalXHR = (window as any).XMLHttpRequest
        ;(window as any).XMLHttpRequest = function () {
            const xhr = new OriginalXHR()
            const originalOpen = xhr.open
            xhr.open = function () {
                return originalOpen.apply(this, arguments)
            }
            return xhr
        }
    } catch (e) {
        console.error('[NetworkInterceptor] Fatal Error:', e)
    }
}

export async function enableNetworkInterception(
    page: Page,
    onSpeakersChange: (payload: {
        users: any[]
        timestamp: number
        source: string
    }) => void,
) {
    await page.exposeFunction('onNetworkSpeakerUpdate', onSpeakersChange)

    await page.addInitScript(() => {
        ;(window as any)._updateNetworkCallback = () => {
            if ((window as any).triggerNetworkBroadcast)
                (window as any).triggerNetworkBroadcast()
        }
    })

    let libs = ''
    try {
        libs += fs.readFileSync(
            require.resolve('protobufjs/dist/protobuf.min.js'),
            'utf8',
        )
        libs += fs.readFileSync(
            require.resolve('pako/dist/pako.min.js'),
            'utf8',
        )
    } catch {
        return
    }

    const script = `
        (function() {
            try {
                window.__networkInterceptorMain = true;
                ${libs}
                if (typeof window !== 'undefined') {
                    window.protobuf = window.protobuf || window.protobufjs;
                    window.pako = window.pako;
                }
                if (!window.protobuf || !window.pako) return;
                
                (${browserInterceptionLogic.toString()})(${JSON.stringify(PROTO_SCHEMA)});
            } catch (e) { console.error(e); }
        })();
    `

    try {
        await page.addInitScript(script)
    } catch {}
}

export async function verifyNetworkInterception(page: Page): Promise<boolean> {
    try {
        const status = await page.evaluate(() => {
            return {
                hasInterceptor:
                    typeof (window as any).__networkInterceptorMain !==
                    'undefined',
                hasProtobuf: typeof (window as any).protobuf !== 'undefined',
                hasPako: typeof (window as any).pako !== 'undefined',
                hasCallback:
                    typeof (window as any).onNetworkSpeakerUpdate !==
                    'undefined',
                canTrigger:
                    typeof (window as any).triggerNetworkBroadcast !==
                    'undefined',
            }
        })

        console.error('[NetworkInterceptor] Status:', status)

        if (!status.hasInterceptor) {
            console.error('[NetworkInterceptor] ❌ Main interceptor not loaded')
            return false
        }

        if (!status.hasProtobuf || !status.hasPako) {
            console.error('[NetworkInterceptor] ❌ Dependencies missing')
            return false
        }

        if (!status.hasCallback) {
            console.warn(
                '[NetworkInterceptor] ⚠️ Callback not registered yet (expected early in lifecycle)',
            )
        }

        return true
    } catch (e) {
        console.error('[NetworkInterceptor] ❌ Verification failed:', e)
        return false
    }
}
