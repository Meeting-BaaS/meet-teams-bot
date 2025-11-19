import { Page } from 'playwright';
import * as fs from 'fs';

// Protobuf schema definition
const PROTO_SCHEMA = [
    {
        name: 'CollectionEvent',
        fields: [
            { name: 'body', fieldNumber: 1, type: 'message', messageType: 'CollectionEventBody' }
        ]
    },
    {
        name: 'CollectionEventBody',
        fields: [
            { name: 'userInfoListWrapperAndChatWrapperWrapper', fieldNumber: 2, type: 'message', messageType: 'UserInfoListWrapperAndChatWrapperWrapper' }
        ]
    },
    {
        name: 'UserInfoListWrapperAndChatWrapperWrapper',
        fields: [
            { name: 'deviceInfoWrapper', fieldNumber: 3, type: 'message', messageType: 'DeviceInfoWrapper' },
            { name: 'userInfoListWrapperAndChatWrapper', fieldNumber: 13, type: 'message', messageType: 'UserInfoListWrapperAndChatWrapper' }
        ]
    },
    {
        name: 'UserInfoListWrapperAndChatWrapper',
        fields: [
            { name: 'userInfoListWrapper', fieldNumber: 1, type: 'message', messageType: 'UserInfoListWrapper' }
        ]
    },
    {
        name: 'DeviceInfoWrapper',
        fields: [
            { name: 'deviceOutputInfoList', fieldNumber: 2, type: 'message', messageType: 'DeviceOutputInfoList', repeated: true }
        ]
    },
    {
        name: 'DeviceOutputInfoList',
        fields: [
            { name: 'deviceOutputType', fieldNumber: 2, type: 'int32' }, // 1 = audio, 2 = video
            { name: 'streamId', fieldNumber: 4, type: 'string' },
            { name: 'deviceId', fieldNumber: 6, type: 'string' },
            { name: 'deviceOutputStatus', fieldNumber: 10, type: 'message', messageType: 'DeviceOutputStatus' }
        ]
    },
    {
        name: 'DeviceOutputStatus',
        fields: [
            { name: 'disabled', fieldNumber: 1, type: 'int32' }
        ]
    },
    {
        name: 'UserInfoListResponse',
        fields: [
            { name: 'userInfoListWrapperWrapper', fieldNumber: 2, type: 'message', messageType: 'UserInfoListWrapperWrapper' }
        ]
    },
    {
        name: 'UserInfoListWrapperWrapper',
        fields: [
            { name: 'userInfoListWrapper', fieldNumber: 2, type: 'message', messageType: 'UserInfoListWrapper' }
        ]
    },
    {
        name: 'UserEventInfo',
        fields: [
            { name: 'eventNumber', fieldNumber: 1, type: 'int32' }
        ]
    },
    {
        name: 'UserInfoListWrapper',
        fields: [
            { name: 'userEventInfo', fieldNumber: 1, type: 'message', messageType: 'UserEventInfo' },
            { name: 'userInfoList', fieldNumber: 2, type: 'message', messageType: 'UserInfoList', repeated: true }
        ]
    },
    {
        name: 'UserInfoList',
        fields: [
            { name: 'deviceId', fieldNumber: 1, type: 'string' },
            { name: 'fullName', fieldNumber: 2, type: 'string' },
            { name: 'profilePicture', fieldNumber: 3, type: 'string' },
            { name: 'status', fieldNumber: 4, type: 'int32' }, // 1 = in meeting, 6 = not in meeting
            { name: 'isCurrentUserString', fieldNumber: 7, type: 'string' },
            { name: 'displayName', fieldNumber: 29, type: 'string' },
            { name: 'isHost', fieldNumber: 34, type: 'int32' }
        ]
    }
];

// The main interception logic function.
function browserInterceptionLogic(schema: any[]) {
    try {
        console.log('[NetworkInterceptor] Initializing...');

        // --- Helper Functions ---
        function base64ToUint8Array(base64: string) {
            const binaryString = window.atob(base64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            return bytes;
        }

        // --- Protobuf Setup ---
        const root = new (window as any).protobuf.Root();
        const messageDecoders: { [key: string]: any } = {};

        schema.forEach(typeDef => {
            const type = new (window as any).protobuf.Type(typeDef.name);
            typeDef.fields.forEach((field: any) => {
                if (field.type === 'message') {
                    const fieldRule = field.repeated ? 'repeated' : undefined;
                    type.add(new (window as any).protobuf.Field(field.name, field.fieldNumber, field.messageType, fieldRule));
                } else {
                    type.add(new (window as any).protobuf.Field(field.name, field.fieldNumber, field.type));
                }
            });
            root.add(type);
            messageDecoders[typeDef.name] = (buffer: Uint8Array) => type.decode(buffer);
        });

        // --- State Maps ---
        const receiverToStreamId = new Map<any, string>(); // RTCRtpReceiver -> streamId
        const streamIdToDeviceId = new Map<string, string>(); // streamId -> deviceId
        const deviceIdToUser = new Map<string, any>();     // deviceId -> UserInfo

        // Active Audio Receivers for Polling
        const activeAudioReceivers = new Set<any>();

        // Speaking State
        const speakingState = new Map<string, { isSpeaking: boolean, lastUpdate: number }>();
        const SILENCE_TIMEOUT = 200; 

        function processNetworkEvent(data: any, source: string) {
            try {
            let hasUpdates = false;

            if (data.userInfoList) {
                data.userInfoList.forEach((user: any) => {
                    if (user.deviceId) {
                            const userInfo = {
                            deviceId: user.deviceId,
                                name: user.fullName || user.displayName || 'Unknown',
                            status: user.status,
                            isCurrentUser: !!user.isCurrentUserString,
                            isHost: !!user.isHost
                            };
                            deviceIdToUser.set(user.deviceId, userInfo);
                        hasUpdates = true;
                    }
                });
            }

            if (data.deviceOutputInfoList) {
                data.deviceOutputInfoList.forEach((output: any) => {
                        // Only map audio streams (deviceOutputType: 1 = audio, 2 = video)
                        if (output.streamId && output.deviceId && output.deviceOutputType === 1) {
                        streamIdToDeviceId.set(output.streamId, output.deviceId);
                        hasUpdates = true;
                    }
                });
            }

            if (hasUpdates) {
                broadcastState('roster-update');
                }
            } catch (error) {
                console.error(`[NetworkInterceptor] Error in processNetworkEvent (${source}):`, error);
            }
        }

        function broadcastState(reason: string) {
            try {
            if (!(window as any).onNetworkSpeakerUpdate) return;

            const users = Array.from(deviceIdToUser.values()).map(user => {
                const isSpeaking = speakingState.get(user.deviceId)?.isSpeaking || false;
                return {
                    deviceId: user.deviceId,
                    name: user.name,
                    status: user.status,
                    isCurrentUser: user.isCurrentUser,
                    isHost: user.isHost,
                    isSpeaking: isSpeaking
                };
            });

            (window as any).onNetworkSpeakerUpdate({
                source: 'network-interceptor',
                reason: reason,
                timestamp: Date.now(),
                users: users
            });
            } catch (error) {
                console.error(`[NetworkInterceptor] Error in broadcastState:`, error);
            }
        }

        // --- Fetch Interceptor (Roster Initialization) ---
        const syncMeetingSpaceCollectionsUrl = "https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollections";
        const originalFetch = window.fetch;
        window.fetch = async function (...args) {
            const response = await originalFetch.apply(window, args);
            try {
                const url = args[0] instanceof Request ? args[0].url : args[0];
                if (url === syncMeetingSpaceCollectionsUrl) {
                    const clonedResponse = response.clone();
                    try {
                        const responseText = await clonedResponse.text();
                        const uint8Array = base64ToUint8Array(responseText);
                        const decoded = messageDecoders['UserInfoListResponse'](uint8Array);
                        const userInfoListWrapper = decoded?.userInfoListWrapperWrapper?.userInfoListWrapper;
                        if (userInfoListWrapper) {
                            processNetworkEvent(userInfoListWrapper, 'fetch');
                        }
                    } catch (decodeError) {
                        // Try binary fallback
                        const arrayBuffer = await response.clone().arrayBuffer();
                        const uint8Array = new Uint8Array(arrayBuffer);
                        const decoded = messageDecoders['UserInfoListResponse'](uint8Array);
                        const userInfoListWrapper = decoded?.userInfoListWrapperWrapper?.userInfoListWrapper;
                        if (userInfoListWrapper) {
                            processNetworkEvent(userInfoListWrapper, 'fetch');
                        }
                    }
                }
            } catch (e) {
                // Ignore fetch errors
            }
            return response;
        };

        // --- WebRTC & DataChannel Interceptor ---
        function setupWebRTCInterception() {
            try {
                if (typeof (window as any).RTCPeerConnection === 'undefined') return;

                const originalRTCPeerConnection = (window as any).RTCPeerConnection;
                
                // Capture receivers from any existing peer connections
                try {
                    // Try to find existing peer connections (they might be stored globally)
                    if ((window as any).RTCPeerConnection && (window as any).RTCPeerConnection.prototype) {
                        // We can't easily enumerate existing instances, but we'll catch them via track events
                    }
                } catch (e) { }
                
                (window as any).RTCPeerConnection = function (...args: any[]) {
                    const pc = new originalRTCPeerConnection(...args);

                    // 1. Capture Audio Receivers for Polling
                    pc.addEventListener('track', (event: any) => {
                        try {
                            const track = event.track;
                            if (track && track.kind === 'audio' && event.receiver) {
                                // Add to our active set for polling
                                activeAudioReceivers.add(event.receiver);

                                // Try to get streamId from event streams first
                                if (event.streams && event.streams.length > 0) {
                                    const streamId = event.streams[0].id;
                                    receiverToStreamId.set(event.receiver, streamId);
                                } else if (track.id) {
                                    // Fallback: use track.id as streamId if streams not available yet
                                    receiverToStreamId.set(event.receiver, track.id);
                                }
                            }
                        } catch (e) { }
                    }, { capture: true });

                    // Also capture receivers from existing tracks (in case track event already fired)
                    // Use setTimeout to ensure connection is established
                    setTimeout(() => {
                        try {
                            const receivers = pc.getReceivers();
                            receivers.forEach((receiver: any) => {
                                if (receiver.track && receiver.track.kind === 'audio') {
                                    activeAudioReceivers.add(receiver);
                                    // Try to get streamId from receiver's track or streams
                                    if (receiver.track.id) {
                                        receiverToStreamId.set(receiver, receiver.track.id);
                                    } else if (receiver.track.getStreams && receiver.track.getStreams().length > 0) {
                                        const streamId = receiver.track.getStreams()[0].id;
                                        receiverToStreamId.set(receiver, streamId);
                                    }
                                }
                            });
                        } catch (e) { }
                    }, 100);

                    // 2. Intercept Data Channel for Roster Updates
            pc.addEventListener('datachannel', (event: any) => {
                if (event.channel.label === "collections") {
                    event.channel.addEventListener("message", (messageEvent: any) => {
                        try {
                            const decodedData = (window as any).pako.inflate(new Uint8Array(messageEvent.data));
                            const collectionEvent = messageDecoders['CollectionEvent'](decodedData);
                            const body = collectionEvent.body?.userInfoListWrapperAndChatWrapperWrapper;
                            if (body) {
                                const userInfoList = body?.userInfoListWrapperAndChatWrapper?.userInfoListWrapper?.userInfoList;
                                        if (userInfoList?.length > 0) processNetworkEvent({ userInfoList }, 'datachannel');

                                const deviceOutputInfoList = body?.deviceInfoWrapper?.deviceOutputInfoList;
                                        if (deviceOutputInfoList?.length > 0) processNetworkEvent({ deviceOutputInfoList }, 'datachannel');
                                    }
                                } catch (e) { }
                            });
                        }
                    });
                    return pc;
                };
            } catch (error) {
                console.error('[NetworkInterceptor] Error setting up WebRTC interceptor:', error);
            }
        }

        // Initialize WebRTC Interceptor
        if (typeof (window as any).RTCPeerConnection === 'undefined') {
            const checkRTCPeerConnection = setInterval(() => {
                if (typeof (window as any).RTCPeerConnection !== 'undefined') {
                    clearInterval(checkRTCPeerConnection);
                    setupWebRTCInterception();
                }
            }, 100);
            setTimeout(() => clearInterval(checkRTCPeerConnection), 10000);
        } else {
            setupWebRTCInterception();
        }

        // --- Active Audio Polling ---
        // We store the native function to call it manually
        const originalGetContributingSources = RTCRtpReceiver.prototype.getContributingSources;

        // Poll every 50ms (20Hz)
        setInterval(() => {
            const now = Date.now();
            let changed = false;

            // 1. Check all active audio receivers for levels
            activeAudioReceivers.forEach((receiver) => {
                try {
                    // Cleanup ended tracks
                    if (!receiver.track || receiver.track.readyState === 'ended') {
                        activeAudioReceivers.delete(receiver);
                        return;
                    }

                    // Ensure we have a streamId mapping (try to update if missing)
                    let streamId = receiverToStreamId.get(receiver);
                    if (!streamId && receiver.track) {
                        // Try to get streamId from track.id or track streams
                        if (receiver.track.id) {
                            streamId = receiver.track.id;
                            receiverToStreamId.set(receiver, streamId);
                        } else if (receiver.track.getStreams && receiver.track.getStreams().length > 0) {
                            streamId = receiver.track.getStreams()[0].id;
                            receiverToStreamId.set(receiver, streamId);
                        }
                    }

                    // Manually query the browser for audio sources on this receiver
                    const sources = originalGetContributingSources.call(receiver);

                    if (sources && sources.length > 0) {
                        // Audio detected
                        if (streamId) {
                            const deviceId = streamIdToDeviceId.get(streamId);
                            if (deviceId) {
                                const currentState = speakingState.get(deviceId);
                                if (!currentState || !currentState.isSpeaking) {
                                    speakingState.set(deviceId, { isSpeaking: true, lastUpdate: now });
                                    changed = true;
                                } else {
                                    // Update timestamp to prevent silence timeout
                                    currentState.lastUpdate = now;
                                }
                            }
                        }
                    }
                } catch (e) {
                    // Receiver invalid
                    activeAudioReceivers.delete(receiver);
                }
            });

            // 2. Check for Silence Timeouts
            speakingState.forEach((state, deviceId) => {
                if (state.isSpeaking && (now - state.lastUpdate > SILENCE_TIMEOUT)) {
                    state.isSpeaking = false;
                    changed = true;
                }
            });

            if (changed) {
                broadcastState('speaking-change');
            }
        }, 50);

        // Manual trigger exposure
        (window as any).triggerNetworkBroadcast = function() {
            broadcastState('manual-trigger');
        };

        console.log('[NetworkInterceptor] ✅ Initialization complete');

    } catch (error) {
        console.error('[NetworkInterceptor] ❌ Initialization failed:', error);
        throw error;
    }
}

export async function enableNetworkInterception(page: Page, onSpeakersChange: (speakers: any[]) => void) {
    // Expose the callback to the browser
    await page.exposeFunction('onNetworkSpeakerUpdate', (speakers: any[]) => {
        onSpeakersChange(speakers);
    });

    // Load libraries
    let protobufJsContent = '';
    let pakoJsContent = '';

    try {
        const protobufPath = require.resolve('protobufjs/dist/protobuf.min.js');
        protobufJsContent = fs.readFileSync(protobufPath, 'utf8');

        const pakoPath = require.resolve('pako/dist/pako.min.js');
        pakoJsContent = fs.readFileSync(pakoPath, 'utf8');
    } catch (e) {
        console.error('[NetworkInterceptor] Failed to load libraries:', e);
        return;
    }

    const schemaJson = JSON.stringify(PROTO_SCHEMA);
    const logicString = browserInterceptionLogic.toString();

    // Create a simple test script
    const testScript = `
        (function() {
            try {
                window.__networkInterceptorTest = true;
            } catch (e) {}
        })();
    `;

    const fullScript = `
        (function() {
            try {
                window.__networkInterceptorMain = true;
                console.log('[NetworkInterceptor] Injecting interceptor...');
                
        ${protobufJsContent}
        ${pakoJsContent}
                
                // Ensure libraries are on window
                if (typeof window !== 'undefined') {
                    if (typeof protobuf !== 'undefined') window.protobuf = protobuf;
                    else if (typeof window.protobufjs !== 'undefined') window.protobuf = window.protobufjs;

                    if (typeof pako !== 'undefined') window.pako = pako;
                }
                
                if (!window.protobuf || !window.pako) {
                    throw new Error('Libraries failed to load on window object');
                }
        
        // Inject the schema and logic
        const PROTO_SCHEMA_INJECTED = ${schemaJson};
        
                // Run the interception logic
        (${logicString})(PROTO_SCHEMA_INJECTED);
            } catch (error) {
                console.error('[NetworkInterceptor] ❌ Injection Error:', error);
            }
        })();
    `;

    try {
        await page.addInitScript(testScript);
        await page.addInitScript(fullScript);
        console.log('[NetworkInterceptor] Scripts registered via addInitScript');
    } catch (error) {
        console.error('[NetworkInterceptor] Failed to register via addInitScript:', error);
        throw error;
    }
    
    try {
    const client = await page.context().newCDPSession(page);
        await client.send('Page.addScriptToEvaluateOnNewDocument', { source: testScript });
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: fullScript });
    } catch (cdpError) {
        // Ignore CDP errors
    }
    
    // Fallback check on load
    page.on('load', async () => {
        try {
            await page.waitForTimeout(100);
            const scriptCheck = await page.evaluate(() => {
                return typeof (window as any).__networkInterceptorMain !== 'undefined';
            }).catch(() => false);
            
            if (!scriptCheck) {
                console.log('[NetworkInterceptor] Re-injecting scripts via evaluate...');
                await page.evaluate(fullScript).catch(() => {});
            }
        } catch (e) {}
    });
}