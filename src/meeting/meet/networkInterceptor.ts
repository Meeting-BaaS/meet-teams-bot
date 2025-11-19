import { Page } from 'playwright';
import * as fs from 'fs';

// Protobuf schema definition (Keep exactly as is)
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
            { name: 'deviceOutputType', fieldNumber: 2, type: 'int32' }, 
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
            { name: 'status', fieldNumber: 4, type: 'int32' },
            { name: 'isCurrentUserString', fieldNumber: 7, type: 'string' },
            { name: 'displayName', fieldNumber: 29, type: 'string' },
            { name: 'isHost', fieldNumber: 34, type: 'int32' }
        ]
    }
];

function browserInterceptionLogic(schema: any[]) {
    try {
        console.error('[NetworkInterceptor] Initializing AudioContext Mode...');

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

        console.error('[NetworkInterceptor] ✅ Network Interceptor loaded - VERSION 2.1 with full diagnostics');
        
        // --- Global State ---
        const ssrcToDeviceId = new Map<string, string>(); 
        const trackIdToSSRC = new Map<string, string>(); 
        const deviceIdToUser = new Map<string, any>();     
        
        const activePeerConnections = new Set<RTCPeerConnection>();
        const activeAudioReceivers = new Set<any>();
        // Keep streams alive to prevent GC
        const activeStreams = new Set<MediaStream>();
        
        // Audio Context State
        let audioCtx: AudioContext | null = null;
        // Updated map signature to include element
        const audioNodes = new Map<string, { source: MediaStreamAudioSourceNode, analyser: AnalyserNode, gain: GainNode, element: HTMLAudioElement }>();

        // Speaking State
        const speakingState = new Map<string, { isSpeaking: boolean, lastUpdate: number }>();
        const SILENCE_TIMEOUT = 200;
        const AUDIO_LEVEL_THRESHOLD = 2; // Drastically lowered threshold (was 10)

        // --- Audio Context Helper ---
        // 
        // We insert ourselves here to force the browser to process the audio
        function ensureAudioContext() {
            if (!audioCtx || audioCtx.state === 'closed') {
                const AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
                if (AudioContext) {
                    audioCtx = new AudioContext();
                }
            }
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume();
            }
            return audioCtx;
        }

        function attachToAudioContext(track: MediaStreamTrack) {
            if (audioNodes.has(track.id)) return; // Already attached

            const ctx = ensureAudioContext();
            if (!ctx) return;

            try {
                const stream = new MediaStream([track]);
                activeStreams.add(stream); // Prevent GC

                // Ensure track is enabled
                track.enabled = true;

                // Bridge via Audio Element to bypass headless/CORS silence issues
                const audioEl = document.createElement('audio');
                audioEl.srcObject = stream;
                audioEl.muted = true; // We mute the element output to speakers...
                // ...but we need to capture it. However, createMediaElementSource OUT of a muted element is silence.
                // Workaround: Don't mute the element, but disconnect the destination in the graph?
                // Actually, createMediaStreamSource IS the standard way. 
                // If that fails, we try connecting the graph without an element first, as we are doing.
                // BUT, let's try adding the element purely to "pull" the bytes.
                
                audioEl.volume = 1.0;
                audioEl.muted = true; // Muted element = silence in createMediaElementSource? No, usually it works if we crossOrigin it.
                // Actually, the best headless fix is often just having the element PLAYING attached to DOM.
                // We don't necessarily need createMediaElementSource, just the element existing keeps the stream active.
                // Let's stick to createMediaStreamSource but ADD the playing element helper back.
                
                document.body.appendChild(audioEl);
                audioEl.play().catch(e => console.error('Play fail', e));

                const source = ctx.createMediaStreamSource(stream);
                const analyser = ctx.createAnalyser();
                const gainNode = ctx.createGain();

                analyser.fftSize = 256; 
                analyser.smoothingTimeConstant = 0.1;

                // Gain to 0.001 to force processing but keep it silent
                gainNode.gain.value = 0.001; 
                
                source.connect(analyser);
                analyser.connect(gainNode);
                gainNode.connect(ctx.destination);
                
                // Store everything including the element for cleanup
                audioNodes.set(track.id, { source, analyser, gain: gainNode, element: audioEl });
                console.error(`[NetworkInterceptor] 🔊 Attached to AudioContext: ${track.id}`);
                
                track.onended = () => {
                    console.error(`[NetworkInterceptor] 🔇 Track ended: ${track.id}`);
                    source.disconnect();
                    analyser.disconnect();
                    gainNode.disconnect();
                    
                    // Cleanup element
                    audioEl.pause();
                    audioEl.srcObject = null;
                    audioEl.remove();

                    audioNodes.delete(track.id);
                    activeStreams.delete(stream);
                };
            } catch (e) {
                console.error('[NetworkInterceptor] AudioContext attach error:', e);
            }
        }

        function processNetworkEvent(data: any, source: string) {
            try {
                console.error(`[NetworkInterceptor] 📨 processNetworkEvent called from ${source}. Keys:`, Object.keys(data));
                console.error(`[NetworkInterceptor] 📨 Full data structure:`, JSON.stringify(data, null, 2).substring(0, 500));
                let hasUpdates = false;
                if (data.userInfoList) {
                    data.userInfoList.forEach((user: any) => {
                        if (user.deviceId) {
                            deviceIdToUser.set(user.deviceId, {
                                deviceId: user.deviceId,
                                name: user.fullName || user.displayName || 'Unknown',
                                status: user.status,
                                isCurrentUser: !!user.isCurrentUserString,
                                isHost: !!user.isHost
                            });
                            hasUpdates = true;
                        }
                    });
                }

                if (data.deviceOutputInfoList) {
                    console.error(`[NetworkInterceptor] 📦 deviceOutputInfoList received! Count: ${data.deviceOutputInfoList.length}`);
                    if (data.deviceOutputInfoList.length > 0) {
                        console.error(`[NetworkInterceptor] 📦 Sample entry:`, JSON.stringify(data.deviceOutputInfoList[0], null, 2));
                    }
                    data.deviceOutputInfoList.forEach((output: any) => {
                        if (output.streamId && output.deviceId && output.deviceOutputType === 1) {
                            console.error(`[NetworkInterceptor] 📥 Mapping SSRC: ${output.streamId} -> DeviceID: ${output.deviceId.substring(0,16)}...`);
                            ssrcToDeviceId.set(output.streamId, output.deviceId);
                            hasUpdates = true;
                        }
                    });
                }

                if (hasUpdates) {
                    setTimeout(() => broadcastState('roster-update'), 50);
                }
            } catch (error) {}
        }

        function broadcastState(reason: string) {
            try {
                if (!(window as any).onNetworkSpeakerUpdate) {
                    (window as any).__hasPendingUpdate = true;
                    return;
                }
                const users = Array.from(deviceIdToUser.values()).map(user => ({
                    ...user,
                    isSpeaking: speakingState.get(user.deviceId)?.isSpeaking || false
                }));
                
                // Debug log for broadcast (can be removed later)
                const speakingCount = users.filter(u => u.isSpeaking).length;
                if (speakingCount > 0) {
                    // console.error(`[NetworkInterceptor] 📡 Broadcasting update: ${users.length} users, ${speakingCount} speaking`);
                }

                (window as any).onNetworkSpeakerUpdate({
                    source: 'network-interceptor',
                    reason: reason,
                    timestamp: Date.now(),
                    users: users
                });
            } catch (error) {}
        }

        // --- Fetch Interceptor ---
        const originalFetch = window.fetch;
        window.fetch = async function (...args) {
            const response = await originalFetch.apply(window, args);
            try {
                const url = args[0] instanceof Request ? args[0].url : args[0];
                if (typeof url === 'string' && url.includes('SyncMeetingSpaceCollections')) {
                    const cloned = response.clone();
                    const text = await cloned.text();
                    const bytes = base64ToUint8Array(text);
                    const decoded = messageDecoders['UserInfoListResponse'](bytes);
                    const wrapper = decoded?.userInfoListWrapperWrapper?.userInfoListWrapper;
                    if (wrapper) processNetworkEvent(wrapper, 'fetch');
                }
            } catch (e) {}
            return response;
        };

        // --- WebRTC Interceptor ---
        if (typeof (window as any).RTCPeerConnection !== 'undefined') {
            const OriginalPC = (window as any).RTCPeerConnection;
            (window as any).RTCPeerConnection = function (...args: any[]) {
                const pc = new OriginalPC(...args);
                activePeerConnections.add(pc);

                pc.addEventListener('track', (event: any) => {
                    if (event.track && event.track.kind === 'audio') {
                        activeAudioReceivers.add(event.receiver);
                        attachToAudioContext(event.track);
                    }
                });

                pc.addEventListener('datachannel', (event: any) => {
                    if (event.channel.label === "collections") {
                        event.channel.addEventListener("message", (msg: any) => {
                            try {
                                const data = (window as any).pako.inflate(new Uint8Array(msg.data));
                                const eventData = messageDecoders['CollectionEvent'](data);
                                const body = eventData.body?.userInfoListWrapperAndChatWrapperWrapper;
                                if (body) {
                                    if (body.userInfoListWrapperAndChatWrapper?.userInfoListWrapper?.userInfoList)
                                        processNetworkEvent({userInfoList: body.userInfoListWrapperAndChatWrapper.userInfoListWrapper.userInfoList}, 'dc');
                                    if (body.deviceInfoWrapper?.deviceOutputInfoList)
                                        processNetworkEvent({deviceOutputInfoList: body.deviceInfoWrapper.deviceOutputInfoList}, 'dc');
                                }
                            } catch (e) {}
                        });
                    }
                });

                const originalClose = pc.close;
                pc.close = function() {
                    activePeerConnections.delete(pc);
                    return originalClose.apply(this, arguments);
                };
                return pc;
            };
        }

        // --- Stats Poller (The Bridge) ---
        setInterval(() => {
            // Log map stats occasionally
            // if (Math.random() < 0.05) console.error(`[NetworkInterceptor] Track->SSRC Map Size: ${trackIdToSSRC.size}`);

            activePeerConnections.forEach(pc => {
                if (pc.signalingState === 'closed') {
                    activePeerConnections.delete(pc);
                    return;
                }
                
                // Re-hydrate receivers - check by ID to avoid duplicates/churn
                try {
                    const receivers = pc.getReceivers();
                    receivers.forEach(r => {
                        if (r.track && r.track.kind === 'audio' && r.track.readyState !== 'ended') {
                            // Check if we already have this track ID tracked
                            let alreadyTracked = false;
                            for (const existing of activeAudioReceivers) {
                                if (existing.track && existing.track.id === r.track.id) {
                                    alreadyTracked = true;
                                    break;
                                }
                            }

                            if (!alreadyTracked) {
                                activeAudioReceivers.add(r);
                                attachToAudioContext(r.track);
                            }
                        }
                    });
                } catch(e) {}

                // Only poll stats if we need to map IDs
                // Always poll if we have unmapped active receivers
                if (true) { 
                    pc.getStats().then(stats => {
                        let debugLogOnce = false;
                        stats.forEach(report => {
                            // DEBUG: Log all inbound-rtp report fields once
                            if (!debugLogOnce && report.type === 'inbound-rtp' && report.kind === 'audio') {
                                console.error(`[NetworkInterceptor] 🔍 Sample inbound-rtp report:`, JSON.stringify(report, null, 2));
                                debugLogOnce = true;
                            }
                            
                            // Standard inbound-rtp check
                            if (report.type === 'inbound-rtp' && report.kind === 'audio' && report.trackIdentifier) {
                                // Prefer explicit SSRC
                                if (report.ssrc) {
                                    const wasNew = !trackIdToSSRC.has(report.trackIdentifier);
                                    trackIdToSSRC.set(report.trackIdentifier, String(report.ssrc));
                                    if (wasNew) {
                                        console.error(`[NetworkInterceptor] 🔗 Discovered Track->SSRC: ${report.trackIdentifier.substring(0,8)} -> ${report.ssrc}`);
                                    }
                                }
                                // ALSO try to extract SSRC from remoteId (e.g. "ROA6666" -> "6666")
                                if (report.remoteId) {
                                    const match = report.remoteId.match(/(\d+)$/);
                                    if (match && match[1]) {
                                        const extractedSSRC = match[1];
                                        // Store both the official SSRC and the remoteId-based one
                                        trackIdToSSRC.set(report.trackIdentifier + '_remote', extractedSSRC);
                                    }
                                }
                            }
                            // Fallback: Check 'track' stats which sometimes link trackId to SSRC indirectly
                            if (report.type === 'track' && report.kind === 'audio' && report.trackIdentifier && report.ssrc) {
                                const wasNew = !trackIdToSSRC.has(report.trackIdentifier);
                                trackIdToSSRC.set(report.trackIdentifier, String(report.ssrc));
                                if (wasNew) {
                                    console.error(`[NetworkInterceptor] 🔗 Discovered Track->SSRC (track): ${report.trackIdentifier.substring(0,8)} -> ${report.ssrc}`);
                                }
                            }
                        });
                    }).catch(e => {});
                }
            });
        }, 1000);

        // --- Audio Polling Loop (Manual Volume Calculation) ---
        let pollCount = 0;
        const dataArray = new Uint8Array(128); // Half of fftSize (256)

        // Helper: Better SSRC Resolution
        function resolveDeviceIdFromSource(source: any, receiver: any): string | null {
            // Method 1: Use trackId -> SSRC mapping from getStats()
            let ssrc = trackIdToSSRC.get(receiver.track.id);

            // Method 1b: Try the remoteId-extracted SSRC
            if (!ssrc) {
                ssrc = trackIdToSSRC.get(receiver.track.id + '_remote');
            }

            // Method 2: Use packet SSRC from contributing source (if available)
            if (!ssrc && source && source.source) {
                ssrc = String(source.source);
            }

            // Method 3: Try rtpTimestamp as alternative identifier (Google Meet specific)
            if (!ssrc && source && source.rtpTimestamp) {
                ssrc = String(source.rtpTimestamp);
            }

            // Now resolve SSRC to deviceId
            if (ssrc) {
                let deviceId = ssrcToDeviceId.get(ssrc);

                // Fallback: Try partial SSRC match (sometimes only part of SSRC matches)
                if (!deviceId) {
                    for (const [mappedSsrc, mappedDeviceId] of ssrcToDeviceId.entries()) {
                        if (ssrc.includes(mappedSsrc) || mappedSsrc.includes(ssrc)) {
                            deviceId = mappedDeviceId;
                            // Only log once to avoid spam
                            if (!trackIdToSSRC.has(receiver.track.id + '_partial')) {
                                console.error(`[NetworkInterceptor] Partial SSRC match: ${ssrc} -> ${mappedSsrc}`);
                                trackIdToSSRC.set(receiver.track.id + '_partial', 'true');
                            }
                            break;
                        }
                    }
                }

                return deviceId || null;
            }

            return null;
        }

        setInterval(() => {
            const now = Date.now();
            let changed = false;
            
            // Ensure AudioContext is running
            ensureAudioContext();

            // Loudest Speaker Logic: Collect all potential speakers first
            const currentSpeakers = new Map<string, number>(); // DeviceID -> Max Volume

            activeAudioReceivers.forEach((receiver) => {
                if (!receiver.track) return;

                // Only remove if explicitly ended
                if (receiver.track.readyState === 'ended') {
                    activeAudioReceivers.delete(receiver);
                    return;
                }
                
                const nodeData = audioNodes.get(receiver.track.id);
                if (!nodeData) {
                    attachToAudioContext(receiver.track);
                    return;
                }

                const { analyser } = nodeData;
                analyser.getByteFrequencyData(dataArray);

                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    sum += dataArray[i];
                }
                const averageVolume = sum / dataArray.length;
                
                // Diagnostic: Check why volume is 0
                if (pollCount % 60 === 0) {
                   console.error(`[NetworkInterceptor] Track: ${receiver.track.id.substring(0,8)} | Vol: ${averageVolume.toFixed(2)} | Muted: ${receiver.track.muted} | Enabled: ${receiver.track.enabled} | State: ${receiver.track.readyState} | Ctx: ${audioCtx?.state}`);
                }

                if (averageVolume > AUDIO_LEVEL_THRESHOLD) {
                    // Use robust SSRC resolution
                    // Pass empty object as source since we aren't using getSynchronizationSources anymore
                    // But we can pass a dummy source if needed, or rely on Method 1 (trackId->SSRC)
                    const deviceId = resolveDeviceIdFromSource({}, receiver);

                    // Diagnostic: Log if we have volume but no DeviceID resolved
                    if (!deviceId && pollCount % 20 === 0) {
                         console.error(`[NetworkInterceptor] ⚠️ Volume ${averageVolume.toFixed(1)} on track ${receiver.track.id.substring(0,8)} but NO DeviceID resolved. Map size: ${trackIdToSSRC.size}`);
                         console.error(`[NetworkInterceptor] Full Track ID: ${receiver.track.id}`);
                         console.error(`[NetworkInterceptor] trackIdToSSRC map contents:`, Array.from(trackIdToSSRC.entries()).map(([k, v]) => `${k} -> ${v}`));
                         console.error(`[NetworkInterceptor] ssrcToDeviceId map contents:`, Array.from(ssrcToDeviceId.entries()).map(([k, v]) => `${k} -> ${v.substring(0,16)}`));
                    }
                    
                    if (deviceId) {
                        // Keep the loudest volume for this user (handle multiple tracks/SSRCs per user)
                        const currentMax = currentSpeakers.get(deviceId) || 0;
                        if (averageVolume > currentMax) {
                            currentSpeakers.set(deviceId, averageVolume);
                        }
                    }
                }
            });

            // Apply updates based on loudest speakers
            currentSpeakers.forEach((vol, deviceId) => {
                const current = speakingState.get(deviceId);
                if (!current || !current.isSpeaking) {
                    speakingState.set(deviceId, { isSpeaking: true, lastUpdate: now });
                    changed = true;
                    console.error(`[NetworkInterceptor] 🔊 Speaking: ${deviceId.substring(0,8)}... (Vol: ${vol.toFixed(1)})`);
                } else {
                    current.lastUpdate = now;
                }
            });

            speakingState.forEach((state, devId) => {
                if (state.isSpeaking && (now - state.lastUpdate > SILENCE_TIMEOUT)) {
                    state.isSpeaking = false;
                    changed = true;
                }
            });

            if (changed) broadcastState('speaking-change');
            
            pollCount++;
            // Removed periodic table log to reduce noise
            // if (pollCount % 60 === 0) { ... }

        }, 50);

        (window as any).triggerNetworkBroadcast = function() { broadcastState('manual-trigger'); };
        console.error('[NetworkInterceptor] ✅ Ready');

    } catch (error) {
        console.error('[NetworkInterceptor] Init Error:', error);
    }
}

export async function enableNetworkInterception(page: Page, onSpeakersChange: (speakers: any[]) => void) {
    await page.exposeFunction('onNetworkSpeakerUpdate', (speakers: any[]) => {
        onSpeakersChange(speakers);
    });

    await page.addInitScript(() => {
        (window as any)._updateNetworkCallback = (callback: any) => {
            if ((window as any).triggerNetworkBroadcast) (window as any).triggerNetworkBroadcast();
        };
    });

    let libs = '';
    try {
        libs += fs.readFileSync(require.resolve('protobufjs/dist/protobuf.min.js'), 'utf8');
        libs += fs.readFileSync(require.resolve('pako/dist/pako.min.js'), 'utf8');
    } catch (e) { return; }

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
    `;

    try {
        await page.addInitScript(script);
    } catch (e) {}
}

export async function verifyNetworkInterception(page: Page): Promise<boolean> {
    try {
        const status = await page.evaluate(() => {
            return {
                hasInterceptor: typeof (window as any).__networkInterceptorMain !== 'undefined',
                hasProtobuf: typeof (window as any).protobuf !== 'undefined',
                hasPako: typeof (window as any).pako !== 'undefined',
                hasCallback: typeof (window as any).onNetworkSpeakerUpdate !== 'undefined',
                canTrigger: typeof (window as any).triggerNetworkBroadcast !== 'undefined',
            };
        });

        console.error('[NetworkInterceptor] Status:', status);

        if (!status.hasInterceptor) {
            console.error('[NetworkInterceptor] ❌ Main interceptor not loaded');
            return false;
        }

        if (!status.hasProtobuf || !status.hasPako) {
            console.error('[NetworkInterceptor] ❌ Dependencies missing');
            return false;
        }

        if (!status.hasCallback) {
            console.warn('[NetworkInterceptor] ⚠️ Callback not registered yet (expected early in lifecycle)');
        }

        return true;
    } catch (e) {
        console.error('[NetworkInterceptor] ❌ Verification failed:', e);
        return false;
    }
}