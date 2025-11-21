// Main browser-side orchestration logic

import type { ReceiverManager, UserManager } from '../types'
import { monitorTrack } from './audio'
import {
    createReceiverManager,
    createUserManager,
    getAllUsers,
    setupRTCRtpReceiverInterceptor,
    updateContributingSources,
    updateDeviceOutputs,
    updateUsers,
} from './managers'
import { base64ToUint8Array, createDecoders, decodeUserName } from './utils'

export function browserInterceptionLogic(schema: any[]) {
    try {
        console.error('[NetworkInterceptor] ✅ Activated')

        // Initialize managers
        const receiverManager: ReceiverManager = createReceiverManager()
        const userManager: UserManager = createUserManager()

        // Initialize RTCRtpReceiver interceptor
        setupRTCRtpReceiverInterceptor((receiver, contributingSources) => {
            updateContributingSources(
                receiverManager,
                receiver,
                contributingSources,
            )

            // Logs reduced for performance
        })

        // Broadcast current state function
        const broadcastCurrentState = () => {
            try {
                const allUsers = getAllUsers(userManager)
                if (allUsers.length === 0) return

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

        // --- Protobuf Setup ---
        const messageDecoders = createDecoders(schema)

        console.error('[NetworkInterceptor] ✅ Protobuf decoders ready')

        // --- Audio Monitoring State ---
        const audioCtx = new ((window as any).AudioContext ||
            (window as any).webkitAudioContext)()
        const activeAudioTracks = new Map<
            string,
            { analyser: AnalyserNode; ssrc?: string; receiver?: any }
        >()

        // --- WebRTC Interceptor ---
        if (typeof (window as any).RTCPeerConnection !== 'undefined') {
            const OriginalPC = (window as any).RTCPeerConnection
            ;(window as any).RTCPeerConnection = function (...args: any[]) {
                const pc = new OriginalPC(...args)

                // 1. Intercept Audio Tracks
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
                                        updateDeviceOutputs(
                                            userManager,
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
                                        updateUsers(userManager, users)
                                        console.error(
                                            `[NetworkInterceptor] 👥 Updated ${users.length} users`,
                                        )
                                    }

                                    // Extract and broadcast chat messages
                                    if (
                                        wrapper
                                            ?.userInfoListWrapperAndChatWrapper
                                            ?.chatMessageWrapper
                                    ) {
                                        const chatWrappers =
                                            wrapper
                                                .userInfoListWrapperAndChatWrapper
                                                .chatMessageWrapper
                                        const chatMessages = chatWrappers
                                            .map((wrapper: any) => {
                                                const msg = wrapper?.chatMessage
                                                if (!msg) return null

                                                const allUsers =
                                                    getAllUsers(userManager)
                                                const sender = allUsers.find(
                                                    (u: any) =>
                                                        u.deviceId ===
                                                        msg.deviceId,
                                                )

                                                return {
                                                    messageId: msg.messageId,
                                                    deviceId: msg.deviceId,
                                                    timestamp: msg.timestamp,
                                                    text:
                                                        msg.chatMessageContent
                                                            ?.text || '',
                                                    senderName: sender
                                                        ? decodeUserName(sender)
                                                        : 'Unknown',
                                                }
                                            })
                                            .filter((msg: any) => msg !== null)

                                        if (
                                            chatMessages.length > 0 &&
                                            typeof (window as any)
                                                .onNetworkSpeakerUpdate ===
                                                'function'
                                        ) {
                                            ;(
                                                window as any
                                            ).onNetworkSpeakerUpdate({
                                                users: getAllUsers(
                                                    userManager,
                                                ).map((user: any) => ({
                                                    deviceId: user.deviceId,
                                                    name: decodeUserName(user),
                                                    isCurrentUser:
                                                        user.isCurrentUserString ===
                                                            'true' ||
                                                        user.isCurrentUserString ===
                                                            '1',
                                                    isSpeaking: false,
                                                    status: user.status,
                                                    isHost: user.isHost === 1,
                                                })),
                                                timestamp: Date.now(),
                                                source: 'chat',
                                                chatMessages,
                                            })
                                            console.error(
                                                `[NetworkInterceptor] 💬 Broadcast ${chatMessages.length} chat messages`,
                                            )
                                        }
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

                return pc
            }
        }

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
                                updateUsers(userManager, userInfoList)
                                console.error(
                                    `[NetworkInterceptor] 👥 Updated ${userInfoList.length} users from fetch`,
                                )
                            }
                        }
                    } catch {}
                }
            } catch {}
            return response
        }
    } catch (e) {
        console.error('[NetworkInterceptor] Fatal Error:', e)
    }
}
