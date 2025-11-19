// Client-side code for sending participant streams to the server
// This is injected directly into the meeting page via Playwright

class ParticipantStreamClient {
    private ws: WebSocket | null = null
    private participantId: string = ''
    private participantName: string = ''
    private isConnected: boolean = false

    constructor(serverUrl: string = 'ws://localhost:8080') {
        this.connect(serverUrl)
    }

    private connect(serverUrl: string): void {
        try {
            this.ws = new WebSocket(serverUrl)

            this.ws.onopen = () => {
                console.log('🔌 Connected to participant stream server')
                this.isConnected = true
                this.registerParticipant()
            }

            this.ws.onclose = () => {
                console.log('🔌 Disconnected from participant stream server')
                this.isConnected = false
            }

            this.ws.onerror = (error) => {
                console.error('❌ WebSocket error:', error)
            }
        } catch (error) {
            console.error('❌ Failed to connect to stream server:', error)
        }
    }

    private registerParticipant(): void {
        // Extract participant info from the meeting page
        this.participantId = this.extractParticipantId()
        this.participantName = this.extractParticipantName()

        if (this.ws && this.isConnected) {
            this.ws.send(
                JSON.stringify({
                    type: 'participant-joined',
                    participantId: this.participantId,
                    participantName: this.participantName,
                    timestamp: Date.now(),
                }),
            )

            console.log(
                `👤 Registered participant: ${this.participantName} (${this.participantId})`,
            )
        }
    }

    private extractParticipantId(): string {
        // This would extract the participant ID from the meeting page DOM
        // For Google Meet, Teams, etc. - implementation would be platform-specific
        const videoElement = document.querySelector('video[srcObject]')
        if (videoElement) {
            return videoElement.id || `participant_${Date.now()}`
        }
        return `participant_${Date.now()}`
    }

    private extractParticipantName(): string {
        // Extract participant name from the meeting page
        // This would be platform-specific implementation
        const nameElement =
            document.querySelector('[data-participant-name]') ||
            document.querySelector('.participant-name') ||
            document.querySelector('[aria-label*="participant"]')

        if (nameElement) {
            return (
                nameElement.textContent?.trim() ||
                nameElement.getAttribute('aria-label') ||
                'Unknown'
            )
        }
        return 'Unknown Participant'
    }

    public startAudioCapture(): void {
        if (!this.ws || !this.isConnected) {
            console.warn('⚠️ Not connected to stream server')
            return
        }

        // Get user's microphone
        navigator.mediaDevices
            .getUserMedia({ audio: true })
            .then((stream) => {
                const audioContext = new AudioContext()
                const source = audioContext.createMediaStreamSource(stream)
                const processor = audioContext.createScriptProcessor(4096, 1, 1)

                processor.onaudioprocess = (event) => {
                    const inputBuffer = event.inputBuffer
                    const inputData = inputBuffer.getChannelData(0)

                    // Convert Float32Array to base64 for transmission
                    const buffer = new ArrayBuffer(inputData.length * 4)
                    const view = new Float32Array(buffer)
                    view.set(inputData)

                    const base64 = btoa(
                        String.fromCharCode(...new Uint8Array(buffer)),
                    )

                    this.ws?.send(
                        JSON.stringify({
                            type: 'audio-chunk',
                            participantId: this.participantId,
                            data: base64,
                            timestamp: Date.now(),
                        }),
                    )
                }

                source.connect(processor)
                processor.connect(audioContext.destination)

                console.log('🎵 Started audio capture')
            })
            .catch((error) => {
                console.error('❌ Failed to start audio capture:', error)
            })
    }

    public startVideoCapture(): void {
        if (!this.ws || !this.isConnected) {
            console.warn('⚠️ Not connected to stream server')
            return
        }

        // Get user's camera
        navigator.mediaDevices
            .getUserMedia({ video: true })
            .then((stream) => {
                const video = document.createElement('video')
                video.srcObject = stream
                video.play()

                const canvas = document.createElement('canvas')
                const ctx = canvas.getContext('2d')

                // Capture video frames
                const captureFrame = () => {
                    if (video.videoWidth > 0 && video.videoHeight > 0) {
                        canvas.width = video.videoWidth
                        canvas.height = video.videoHeight

                        ctx?.drawImage(video, 0, 0)

                        canvas.toBlob(
                            (blob) => {
                                if (blob) {
                                    const reader = new FileReader()
                                    reader.onload = () => {
                                        const base64 = reader.result
                                            ?.toString()
                                            .split(',')[1]
                                        if (base64) {
                                            this.ws?.send(
                                                JSON.stringify({
                                                    type: 'video-chunk',
                                                    participantId:
                                                        this.participantId,
                                                    data: base64,
                                                    timestamp: Date.now(),
                                                }),
                                            )
                                        }
                                    }
                                    reader.readAsDataURL(blob)
                                }
                            },
                            'image/jpeg',
                            0.8,
                        )
                    }

                    requestAnimationFrame(captureFrame)
                }

                captureFrame()
                console.log('🎬 Started video capture')
            })
            .catch((error) => {
                console.error('❌ Failed to start video capture:', error)
            })
    }

    public updateSpeakingStatus(isSpeaking: boolean): void {
        if (this.ws && this.isConnected) {
            this.ws.send(
                JSON.stringify({
                    type: 'speaking-status',
                    participantId: this.participantId,
                    isSpeaking: isSpeaking,
                    timestamp: Date.now(),
                }),
            )
        }
    }

    public disconnect(): void {
        if (this.ws && this.isConnected) {
            this.ws.send(
                JSON.stringify({
                    type: 'participant-left',
                    participantId: this.participantId,
                    timestamp: Date.now(),
                }),
            )

            this.ws.close()
        }
    }
}

// Example usage:
// const streamClient = new ParticipantStreamClient('ws://localhost:8080')
// streamClient.startAudioCapture()
// streamClient.startVideoCapture()

// Monitor speaking status (this would integrate with your existing SpeakerManager)
// setInterval(() => {
//     const isSpeaking = /* check if current participant is speaking */
//     streamClient.updateSpeakingStatus(isSpeaking)
// }, 1000)

export { ParticipantStreamClient }
