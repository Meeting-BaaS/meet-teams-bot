import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import { WebSocketServer } from 'ws'
import { PathManager } from '../utils/PathManager'

export interface ParticipantStream {
    participantId: string
    participantName: string
    audioChunks: Buffer[]
    videoChunks: Buffer[]
    startTime: number
    lastActivity: number
    isActive: boolean
}

export interface StreamCaptureConfig {
    enabled: boolean
    websocketPort: number
    captureAudio: boolean
    captureVideo: boolean
    chunkSizeMs: number
}

export class ParticipantStreamCapture extends EventEmitter {
    private static instance: ParticipantStreamCapture | null = null
    private config: StreamCaptureConfig
    private participantStreams: Map<string, ParticipantStream> = new Map()
    private websocketServer: WebSocketServer | null = null
    private isCapturing: boolean = false
    private captureStartTime: number = 0

    constructor(config: Partial<StreamCaptureConfig> = {}) {
        super()

        this.config = {
            enabled: true,
            websocketPort: 8080,
            captureAudio: true,
            captureVideo: true,
            chunkSizeMs: 1000, // 1 second chunks
            ...config,
        }
    }

    public static getInstance(
        config?: Partial<StreamCaptureConfig>,
    ): ParticipantStreamCapture {
        if (!ParticipantStreamCapture.instance) {
            ParticipantStreamCapture.instance = new ParticipantStreamCapture(
                config,
            )
        }
        return ParticipantStreamCapture.instance
    }

    public async startCapture(): Promise<void> {
        if (this.isCapturing) {
            console.log('⚠️ Participant stream capture already running')
            return
        }

        if (!this.config.enabled) {
            console.log('ℹ️ Participant stream capture disabled in config')
            return
        }

        try {
            console.log('🎯 Starting participant stream capture...')

            // Setup WebSocket server for receiving streams
            await this.setupWebSocketServer()

            // Create participant streams directory
            await this.createParticipantDirectories()

            this.isCapturing = true
            this.captureStartTime = Date.now()

            console.log(
                `✅ Participant stream capture started on port ${this.config.websocketPort}`,
            )
            this.emit('started', { port: this.config.websocketPort })
        } catch (error) {
            console.error(
                '❌ Failed to start participant stream capture:',
                error,
            )
            this.emit('error', error)
            throw error
        }
    }

    public async stopCapture(): Promise<void> {
        if (!this.isCapturing) {
            return
        }

        console.log('🛑 Stopping participant stream capture...')

        try {
            // Close WebSocket server
            if (this.websocketServer) {
                this.websocketServer.close()
                this.websocketServer = null
            }

            // Process and save all participant streams
            await this.processAllParticipantStreams()

            // Cleanup
            this.participantStreams.clear()
            this.isCapturing = false

            const duration = Date.now() - this.captureStartTime
            console.log(
                `✅ Participant stream capture stopped after ${duration}ms`,
            )
            this.emit('stopped', { duration })
        } catch (error) {
            console.error(
                '❌ Error stopping participant stream capture:',
                error,
            )
            this.emit('error', error)
        }
    }

    private async setupWebSocketServer(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.websocketServer = new WebSocketServer({
                    port: this.config.websocketPort,
                    perMessageDeflate: false,
                })

                this.websocketServer.on('connection', (ws) => {
                    console.log(
                        '🔌 New participant stream connection established',
                    )

                    ws.on('message', (data) => {
                        this.handleStreamMessage(data.toString())
                    })

                    ws.on('close', () => {
                        console.log('🔌 Participant stream connection closed')
                    })

                    ws.on('error', (error) => {
                        console.error('❌ WebSocket error:', error)
                    })
                })

                this.websocketServer.on('listening', () => {
                    console.log(
                        `🎯 WebSocket server listening on port ${this.config.websocketPort}`,
                    )
                    resolve()
                })

                this.websocketServer.on('error', (error: any) => {
                    console.error('❌ WebSocket server error:', error)
                    // If port is in use, try a different port
                    if (error.code === 'EADDRINUSE') {
                        console.log(
                            `⚠️ Port ${this.config.websocketPort} is in use, trying alternative port...`,
                        )
                        this.tryAlternativePort(resolve, reject)
                    } else {
                        reject(error)
                    }
                })
            } catch (error) {
                reject(error)
            }
        })
    }

    private tryAlternativePort(
        resolve: () => void,
        _reject: (error: any) => void,
    ): void {
        // Try ports 8081-8090
        for (let port = 8081; port <= 8090; port++) {
            try {
                this.websocketServer = new WebSocketServer({
                    port: port,
                    perMessageDeflate: false,
                })

                this.websocketServer.on('connection', (ws) => {
                    console.log(
                        '🔌 New participant stream connection established',
                    )
                    ws.on('message', (data) => {
                        this.handleStreamMessage(data.toString())
                    })
                    ws.on('close', () => {
                        console.log('🔌 Participant stream connection closed')
                    })
                    ws.on('error', (error) => {
                        console.error('❌ WebSocket connection error:', error)
                    })
                })

                this.websocketServer.on('listening', () => {
                    console.log(
                        `🎯 WebSocket server listening on alternative port ${port}`,
                    )
                    this.config.websocketPort = port // Update config with working port
                    resolve()
                })

                this.websocketServer.on('error', (error: any) => {
                    if (error.code === 'EADDRINUSE') {
                        console.log(
                            `⚠️ Port ${port} also in use, trying next...`,
                        )
                        return // Try next port
                    }
                    _reject(error)
                })

                return // Exit the loop if we successfully created the server
            } catch (_error) {
                console.log(
                    `⚠️ Failed to create server on port ${port}, trying next...`,
                )
                continue
            }
        }

        // If we get here, all ports failed
        _reject(new Error('No available ports found for WebSocket server'))
    }

    private handleStreamMessage(data: Buffer | string): void {
        try {
            const message = JSON.parse(data.toString())

            switch (message.type) {
                case 'participant-joined':
                    this.handleParticipantJoined(message)
                    break
                case 'participant-left':
                    this.handleParticipantLeft(message)
                    break
                case 'audio-chunk':
                    this.handleAudioChunk(message)
                    break
                case 'video-chunk':
                    this.handleVideoChunk(message)
                    break
                case 'speaking-status':
                    this.handleSpeakingStatus(message)
                    break
                default:
                    console.log(`ℹ️ Unknown message type: ${message.type}`)
            }
        } catch (error) {
            console.error('❌ Error parsing stream message:', error)
        }
    }

    private handleParticipantJoined(message: any): void {
        const { participantId, participantName } = message

        if (this.participantStreams.has(participantId)) {
            console.log(
                `ℹ️ Participant ${participantName} (${participantId}) already exists`,
            )
            return
        }

        const stream: ParticipantStream = {
            participantId,
            participantName,
            audioChunks: [],
            videoChunks: [],
            startTime: Date.now(),
            lastActivity: Date.now(),
            isActive: true,
        }

        this.participantStreams.set(participantId, stream)

        console.log(
            `👤 Participant joined: ${participantName} (${participantId})`,
        )
        console.log(`📊 Total participants: ${this.participantStreams.size}`)

        this.emit('participantJoined', stream)
    }

    private handleParticipantLeft(message: any): void {
        const { participantId } = message
        const stream = this.participantStreams.get(participantId)

        if (!stream) {
            console.log(`ℹ️ Participant ${participantId} not found in streams`)
            return
        }

        stream.isActive = false
        stream.lastActivity = Date.now()

        console.log(
            `👋 Participant left: ${stream.participantName} (${participantId})`,
        )
        console.log(
            `📊 Remaining participants: ${Array.from(this.participantStreams.values()).filter((s) => s.isActive).length}`,
        )

        this.emit('participantLeft', stream)
    }

    private handleAudioChunk(message: any): void {
        const { participantId, data } = message
        const stream = this.participantStreams.get(participantId)

        if (!stream) {
            console.log(
                `⚠️ Audio chunk received for unknown participant: ${participantId}`,
            )
            return
        }

        if (!this.config.captureAudio) {
            return
        }

        try {
            const audioBuffer = Buffer.from(data, 'base64')
            stream.audioChunks.push(audioBuffer)
            stream.lastActivity = Date.now()

            console.log(
                `🎵 Audio chunk received from ${stream.participantName}: ${audioBuffer.length} bytes`,
            )

            // Log audio activity periodically
            if (stream.audioChunks.length % 10 === 0) {
                console.log(
                    `📊 ${stream.participantName} audio chunks: ${stream.audioChunks.length}`,
                )
            }
        } catch (error) {
            console.error(
                `❌ Error processing audio chunk for ${participantId}:`,
                error,
            )
        }
    }

    private handleVideoChunk(message: any): void {
        const { participantId, data } = message
        const stream = this.participantStreams.get(participantId)

        if (!stream) {
            console.log(
                `⚠️ Video chunk received for unknown participant: ${participantId}`,
            )
            return
        }

        if (!this.config.captureVideo) {
            return
        }

        try {
            const videoBuffer = Buffer.from(data, 'base64')
            stream.videoChunks.push(videoBuffer)
            stream.lastActivity = Date.now()

            console.log(
                `🎬 Video chunk received from ${stream.participantName}: ${videoBuffer.length} bytes`,
            )

            // Log video activity periodically
            if (stream.videoChunks.length % 30 === 0) {
                // Every 30 frames
                console.log(
                    `📊 ${stream.participantName} video chunks: ${stream.videoChunks.length}`,
                )
            }
        } catch (error) {
            console.error(
                `❌ Error processing video chunk for ${participantId}:`,
                error,
            )
        }
    }

    private handleSpeakingStatus(message: any): void {
        const { participantId, isSpeaking, timestamp } = message
        const stream = this.participantStreams.get(participantId)

        if (!stream) {
            console.log(
                `⚠️ Speaking status received for unknown participant: ${participantId}`,
            )
            return
        }

        const status = isSpeaking ? '🎤 SPEAKING' : '🔇 SILENT'
        console.log(
            `${status} ${stream.participantName} (${participantId}) at ${new Date(timestamp).toISOString()}`,
        )

        this.emit('speakingStatusChanged', { stream, isSpeaking, timestamp })
    }

    private async createParticipantDirectories(): Promise<void> {
        try {
            const basePath = PathManager.getInstance().getOutputPath()
            const participantDir = path.join(
                path.dirname(basePath),
                'participants',
            )

            if (!fs.existsSync(participantDir)) {
                fs.mkdirSync(participantDir, { recursive: true })
                console.log(
                    `📁 Created participant streams directory: ${participantDir}`,
                )
            }
        } catch (error) {
            console.error('❌ Error creating participant directories:', error)
        }
    }

    private async processAllParticipantStreams(): Promise<void> {
        console.log(
            `🔄 Processing ${this.participantStreams.size} participant streams...`,
        )

        for (const [, stream] of this.participantStreams) {
            try {
                await this.processParticipantStream(stream)
            } catch (error) {
                console.error(
                    `❌ Error processing stream for ${stream.participantName}:`,
                    error,
                )
            }
        }
    }

    private async processParticipantStream(
        stream: ParticipantStream,
    ): Promise<void> {
        const duration = stream.lastActivity - stream.startTime
        console.log(`🔄 Processing ${stream.participantName}:`)
        console.log(`   📊 Duration: ${duration}ms`)
        console.log(`   🎵 Audio chunks: ${stream.audioChunks.length}`)
        console.log(`   🎬 Video chunks: ${stream.videoChunks.length}`)
        console.log(
            `   📏 Total audio data: ${stream.audioChunks.reduce((sum, chunk) => sum + chunk.length, 0)} bytes`,
        )
        console.log(
            `   📏 Total video data: ${stream.videoChunks.reduce((sum, chunk) => sum + chunk.length, 0)} bytes`,
        )

        // TODO: Save individual participant streams to files
        // This is where you would implement the actual file saving logic
        console.log(
            `💾 Would save ${stream.participantName} stream to individual files`,
        )

        this.emit('streamProcessed', stream)
    }

    public getActualPort(): number {
        return this.config.websocketPort
    }

    public getParticipantStats(): Array<{
        participantId: string
        participantName: string
        duration: number
        audioChunks: number
        videoChunks: number
        totalAudioBytes: number
        totalVideoBytes: number
        isActive: boolean
    }> {
        return Array.from(this.participantStreams.values()).map((stream) => ({
            participantId: stream.participantId,
            participantName: stream.participantName,
            duration: stream.lastActivity - stream.startTime,
            audioChunks: stream.audioChunks.length,
            videoChunks: stream.videoChunks.length,
            totalAudioBytes: stream.audioChunks.reduce(
                (sum, chunk) => sum + chunk.length,
                0,
            ),
            totalVideoBytes: stream.videoChunks.reduce(
                (sum, chunk) => sum + chunk.length,
                0,
            ),
            isActive: stream.isActive,
        }))
    }

    public logParticipantStats(): void {
        const stats = this.getParticipantStats()

        console.log('\n📊 PARTICIPANT STREAM STATISTICS:')
        console.log('='.repeat(60))

        if (stats.length === 0) {
            console.log('No participants captured')
            return
        }

        stats.forEach((stat, index) => {
            console.log(
                `${index + 1}. ${stat.participantName} (${stat.participantId})`,
            )
            console.log(`   Duration: ${(stat.duration / 1000).toFixed(1)}s`)
            console.log(
                `   Audio: ${stat.audioChunks} chunks (${(stat.totalAudioBytes / 1024).toFixed(1)} KB)`,
            )
            console.log(
                `   Video: ${stat.videoChunks} chunks (${(stat.totalVideoBytes / 1024).toFixed(1)} KB)`,
            )
            console.log(`   Status: ${stat.isActive ? 'Active' : 'Left'}`)
            console.log('')
        })

        const totalAudioBytes = stats.reduce(
            (sum, stat) => sum + stat.totalAudioBytes,
            0,
        )
        const totalVideoBytes = stats.reduce(
            (sum, stat) => sum + stat.totalVideoBytes,
            0,
        )

        console.log('TOTALS:')
        console.log(`   Participants: ${stats.length}`)
        console.log(`   Total Audio: ${(totalAudioBytes / 1024).toFixed(1)} KB`)
        console.log(`   Total Video: ${(totalVideoBytes / 1024).toFixed(1)} KB`)
        console.log('='.repeat(60))
    }

    public isCurrentlyCapturing(): boolean {
        return this.isCapturing
    }

    public getConfig(): StreamCaptureConfig {
        return { ...this.config }
    }
}
