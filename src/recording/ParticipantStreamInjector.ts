import { Page } from '@playwright/test'
import { ParticipantStreamCapture } from './ParticipantStreamCapture'

export interface ParticipantStreamInjectionConfig {
    enabled: boolean
    websocketPort: number
    captureAudio: boolean
    captureVideo: boolean
    chunkSizeMs: number
    serverUrl?: string
}

export class ParticipantStreamInjector {
    private static instance: ParticipantStreamInjector | null = null
    private config: ParticipantStreamInjectionConfig
    private participantStreamCapture: ParticipantStreamCapture | null = null
    private injectedPages: Set<Page> = new Set()

    constructor(config: Partial<ParticipantStreamInjectionConfig> = {}) {
        this.config = {
            enabled: true,
            websocketPort: 8081, // Use same port as ScreenRecorder
            captureAudio: true,
            captureVideo: true,
            chunkSizeMs: 1000,
            serverUrl: 'ws://localhost:8081',
            ...config,
        }

        // Initialize participant stream capture
        this.participantStreamCapture = ParticipantStreamCapture.getInstance({
            enabled: this.config.enabled,
            websocketPort: this.config.websocketPort,
            captureAudio: this.config.captureAudio,
            captureVideo: this.config.captureVideo,
            chunkSizeMs: this.config.chunkSizeMs,
        })
    }

    public static getInstance(
        config?: Partial<ParticipantStreamInjectionConfig>,
    ): ParticipantStreamInjector {
        if (!ParticipantStreamInjector.instance) {
            ParticipantStreamInjector.instance = new ParticipantStreamInjector(
                config,
            )
        }
        return ParticipantStreamInjector.instance
    }

    public async injectIntoPage(page: Page): Promise<void> {
        if (!this.config.enabled) {
            console.log('ℹ️ Participant stream injection disabled')
            return
        }

        try {
            console.log('🎯 Injecting participant stream capture into page...')

            // Get the actual port being used by the WebSocket server
            const actualPort =
                this.participantStreamCapture?.getActualPort() ||
                this.config.websocketPort
            const serverUrl = `ws://localhost:${actualPort}`

            // Inject the client-side code with the correct server URL
            await this.injectStreamCaptureScript(page, serverUrl)

            // Set up monitoring for participant changes
            await this.setupParticipantMonitoring(page)

            this.injectedPages.add(page)

            console.log(
                `✅ Participant stream capture injected successfully (connecting to ${serverUrl})`,
            )
        } catch (error) {
            console.error(
                '❌ Failed to inject participant stream capture:',
                error,
            )
        }
    }

    private async injectStreamCaptureScript(
        page: Page,
        serverUrl: string,
    ): Promise<void> {
        const script = `
            (function() {
                console.log('🎯 ParticipantStreamClient initializing...');
                
                class ParticipantStreamClient {
                    constructor(serverUrl) {
                        this.ws = null;
                        this.participantId = '';
                        this.participantName = '';
                        this.isConnected = false;
                        this.audioContext = null;
                        this.videoStream = null;
                        this.audioStream = null;
                        this.connect(serverUrl);
                    }

                    connect(serverUrl) {
                        try {
                            console.log('🔌 Creating WebSocket connection to:', serverUrl);
                            this.ws = new WebSocket(serverUrl);
                            
                            this.ws.onopen = () => {
                                console.log('🔌 Connected to participant stream server');
                                this.isConnected = true;
                                this.registerParticipant();
                            };

                            this.ws.onclose = () => {
                                console.log('🔌 Disconnected from participant stream server');
                                this.isConnected = false;
                            };

                            this.ws.onerror = (error) => {
                                console.error('❌ WebSocket error:', error);
                            };
                        } catch (error) {
                            console.error('❌ Failed to connect to stream server:', error);
                        }
                    }

                    registerParticipant() {
                        this.participantId = this.extractParticipantId();
                        this.participantName = this.extractParticipantName();

                        if (this.ws && this.isConnected) {
                            this.ws.send(JSON.stringify({
                                type: 'participant-joined',
                                participantId: this.participantId,
                                participantName: this.participantName,
                                timestamp: Date.now()
                            }));

                            console.log(\`👤 Registered participant: \${this.participantName} (\${this.participantId})\`);
                        }
                    }

                    extractParticipantId() {
                        // Try to find a unique identifier for this participant
                        const videoElement = document.querySelector('video[srcObject]');
                        if (videoElement) {
                            return videoElement.id || \`participant_\${Date.now()}\`;
                        }
                        
                        // For Google Meet, try to get from participant list
                        const participantElement = document.querySelector('[data-participant-id]');
                        if (participantElement) {
                            return participantElement.getAttribute('data-participant-id');
                        }
                        
                        return \`participant_\${Date.now()}\`;
                    }

                    extractParticipantName() {
                        console.log('🔍 Extracting participant name...');
                        
                        // Debug: Log available DOM elements
                        const debugElements = document.querySelectorAll('[data-participant-id], [data-self-name], [data-participant-name], video[aria-label]');
                        console.log(\`🔍 Found \${debugElements.length} potential name elements:\`);
                        debugElements.forEach((el, i) => {
                            console.log(\`  \${i}: \${el.tagName} - \${el.textContent?.trim() || el.getAttribute('aria-label') || 'no text'}\`);
                        });
                        
                        // Google Meet specific selectors
                        const meetSelectors = [
                            // People panel participant names
                            '[data-participant-id] [jsname="BOHaEe"]',
                            '[data-participant-id] [jsname="BOHaEe"] span',
                            '[data-participant-id] .zWGUib',
                            '[data-participant-id] .zWGUib span',
                            
                            // Video tile names
                            '[data-self-name]',
                            '[data-participant-name]',
                            
                            // Generic participant name elements
                            '.participant-name',
                            '[aria-label*="participant"]',
                            '[data-testid*="participant"]',
                            '.participant-item [aria-label]',
                            
                            // Google Meet video elements with names
                            'video[aria-label]',
                            '[data-participant-id] video[aria-label]'
                        ];

                        for (const selector of meetSelectors) {
                            const elements = document.querySelectorAll(selector);
                            for (const element of elements) {
                                let name = element.textContent?.trim() || 
                                          element.getAttribute('aria-label') || 
                                          element.getAttribute('data-participant-name') ||
                                          element.getAttribute('data-self-name');
                                
                                if (name && name !== 'Unknown' && name.length > 0) {
                                    // Clean up the name (remove "camera" etc.)
                                    name = name.replace(/camera.*$/i, '').trim();
                                    name = name.replace(/microphone.*$/i, '').trim();
                                    name = name.replace(/speaker.*$/i, '').trim();
                                    
                                    if (name.length > 0) {
                                        console.log(\`✅ Found participant name: "\${name}" using selector: \${selector}\`);
                                        return name;
                                    }
                                }
                            }
                        }

                        // Try to get from the bot's own name (if we're the bot)
                        const botNameElement = document.querySelector('[data-self-name]');
                        if (botNameElement) {
                            const botName = botNameElement.getAttribute('data-self-name');
                            if (botName) {
                                console.log(\`✅ Found bot name: "\${botName}"\`);
                                return botName;
                            }
                        }

                        console.log('⚠️ Could not extract participant name, using fallback');
                        return 'Unknown Participant';
                    }

                    async startAudioCapture() {
                        if (!this.ws || !this.isConnected) {
                            console.warn('⚠️ Not connected to stream server');
                            return;
                        }

                        try {
                            this.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                            this.audioContext = new AudioContext();
                            const source = this.audioContext.createMediaStreamSource(this.audioStream);
                            const processor = this.audioContext.createScriptProcessor(4096, 1, 1);

                            processor.onaudioprocess = (event) => {
                                const inputBuffer = event.inputBuffer;
                                const inputData = inputBuffer.getChannelData(0);
                                
                                // Convert Float32Array to base64 for transmission
                                const buffer = new ArrayBuffer(inputData.length * 4);
                                const view = new Float32Array(buffer);
                                view.set(inputData);
                                
                                const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
                                
                                this.ws?.send(JSON.stringify({
                                    type: 'audio-chunk',
                                    participantId: this.participantId,
                                    data: base64,
                                    timestamp: Date.now()
                                }));
                            };

                            source.connect(processor);
                            processor.connect(this.audioContext.destination);

                            console.log('🎵 Started audio capture');
                        } catch (error) {
                            console.error('❌ Failed to start audio capture:', error);
                        }
                    }

                    async startVideoCapture() {
                        if (!this.ws || !this.isConnected) {
                            console.warn('⚠️ Not connected to stream server');
                            return;
                        }

                        try {
                            this.videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
                            const video = document.createElement('video');
                            video.srcObject = this.videoStream;
                            video.play();

                            const canvas = document.createElement('canvas');
                            const ctx = canvas.getContext('2d');

                            const captureFrame = () => {
                                if (video.videoWidth > 0 && video.videoHeight > 0) {
                                    canvas.width = video.videoWidth;
                                    canvas.height = video.videoHeight;
                                    
                                    ctx?.drawImage(video, 0, 0);
                                    
                                    canvas.toBlob((blob) => {
                                        if (blob) {
                                            const reader = new FileReader();
                                            reader.onload = () => {
                                                const base64 = reader.result?.toString().split(',')[1];
                                                if (base64) {
                                                    this.ws?.send(JSON.stringify({
                                                        type: 'video-chunk',
                                                        participantId: this.participantId,
                                                        data: base64,
                                                        timestamp: Date.now()
                                                    }));
                                                }
                                            };
                                            reader.readAsDataURL(blob);
                                        }
                                    }, 'image/jpeg', 0.8);
                                }
                                
                                requestAnimationFrame(captureFrame);
                            };

                            captureFrame();
                            console.log('🎬 Started video capture');
                        } catch (error) {
                            console.error('❌ Failed to start video capture:', error);
                        }
                    }

                    updateSpeakingStatus(isSpeaking) {
                        if (this.ws && this.isConnected) {
                            this.ws.send(JSON.stringify({
                                type: 'speaking-status',
                                participantId: this.participantId,
                                isSpeaking: isSpeaking,
                                timestamp: Date.now()
                            }));
                        }
                    }

                    disconnect() {
                        if (this.ws && this.isConnected) {
                            this.ws.send(JSON.stringify({
                                type: 'participant-left',
                                participantId: this.participantId,
                                timestamp: Date.now()
                            }));
                            
                            this.ws.close();
                        }

                        // Clean up media streams
                        if (this.audioStream) {
                            this.audioStream.getTracks().forEach(track => track.stop());
                        }
                        if (this.videoStream) {
                            this.videoStream.getTracks().forEach(track => track.stop());
                        }
                        if (this.audioContext) {
                            this.audioContext.close();
                        }
                    }
                }

                // Initialize the client
                console.log('🔌 Attempting to connect to WebSocket server at: ${serverUrl}');
                window.participantStreamClient = new ParticipantStreamClient('${serverUrl}');
                
                // Start capturing after a short delay to ensure connection is established
                setTimeout(() => {
                    if (window.participantStreamClient) {
                        console.log('🎯 Starting audio and video capture...');
                        window.participantStreamClient.startAudioCapture();
                        window.participantStreamClient.startVideoCapture();
                        
                        // Periodically re-extract participant names (DOM might change)
                        setInterval(() => {
                            if (window.participantStreamClient) {
                                const newName = window.participantStreamClient.extractParticipantName();
                                if (newName !== window.participantStreamClient.participantName) {
                                    console.log(\`🔄 Participant name updated: \${window.participantStreamClient.participantName} -> \${newName}\`);
                                    window.participantStreamClient.participantName = newName;
                                    window.participantStreamClient.registerParticipant();
                                }
                            }
                        }, 10000); // Check every 10 seconds
                    }
                }, 2000);

                console.log('✅ ParticipantStreamClient initialized');
            })();
        `

        await page.evaluate(script)
    }

    private async setupParticipantMonitoring(page: Page): Promise<void> {
        // Monitor for participant changes and speaking status
        const monitoringScript = `
            (function() {
                let lastParticipantCount = 0;
                let lastSpeakingStatus = {};

                function checkParticipantChanges() {
                    // Count participants (this is platform-specific)
                    const participantElements = document.querySelectorAll('[data-participant-id], .participant-item, [aria-label*="participant"]');
                    const currentCount = participantElements.length;

                    if (currentCount !== lastParticipantCount) {
                        console.log(\`📊 Participant count changed: \${lastParticipantCount} -> \${currentCount}\`);
                        lastParticipantCount = currentCount;
                    }

                    // Check speaking status for each participant
                    participantElements.forEach((element, index) => {
                        const participantId = element.getAttribute('data-participant-id') || \`participant_\${index}\`;
                        const isSpeaking = element.classList.contains('speaking') || 
                                         element.getAttribute('aria-label')?.includes('speaking') ||
                                         element.querySelector('.speaking-indicator');

                        if (lastSpeakingStatus[participantId] !== isSpeaking) {
                            console.log(\`🎤 Participant \${participantId} speaking status: \${isSpeaking}\`);
                            lastSpeakingStatus[participantId] = isSpeaking;
                            
                            if (window.participantStreamClient) {
                                window.participantStreamClient.updateSpeakingStatus(isSpeaking);
                            }
                        }
                    });
                }

                // Check every second
                setInterval(checkParticipantChanges, 1000);

                // Also listen for DOM changes
                const observer = new MutationObserver(() => {
                    checkParticipantChanges();
                });

                observer.observe(document.body, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['class', 'aria-label']
                });

                console.log('✅ Participant monitoring started');
            })();
        `

        await page.evaluate(monitoringScript)
    }

    public async startCapture(): Promise<void> {
        if (this.participantStreamCapture) {
            try {
                await this.participantStreamCapture.startCapture()

                // Update the server URL with the actual port being used
                const actualPort = this.participantStreamCapture.getActualPort()
                this.config.serverUrl = `ws://localhost:${actualPort}`

                console.log('✅ Participant stream injector started capture')
            } catch (error) {
                console.error(
                    '❌ Failed to start participant stream capture:',
                    error,
                )
            }
        }
    }

    public async stopCapture(): Promise<void> {
        if (this.participantStreamCapture) {
            try {
                await this.participantStreamCapture.stopCapture()
                console.log('✅ Participant stream injector stopped capture')

                // Log statistics
                this.participantStreamCapture.logParticipantStats()
            } catch (error) {
                console.error(
                    '❌ Failed to stop participant stream capture:',
                    error,
                )
            }
        }

        // Clean up injected pages
        for (const page of this.injectedPages) {
            try {
                await page.evaluate(() => {
                    if ((window as any).participantStreamClient) {
                        ;(window as any).participantStreamClient.disconnect()
                        delete (window as any).participantStreamClient
                    }
                })
            } catch (error) {
                console.warn('⚠️ Error cleaning up page:', error)
            }
        }
        this.injectedPages.clear()
    }

    public getParticipantStreamCapture(): ParticipantStreamCapture | null {
        return this.participantStreamCapture
    }

    public isCurrentlyCapturing(): boolean {
        return this.participantStreamCapture?.isCurrentlyCapturing() || false
    }

    public getConfig(): ParticipantStreamInjectionConfig {
        return { ...this.config }
    }
}
