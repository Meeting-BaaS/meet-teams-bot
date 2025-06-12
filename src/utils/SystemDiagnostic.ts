import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export interface SystemDiagnosticResult {
    pulseAudioLatency: number
    ffmpegBufferDelay: number
    systemLoad: number
    audioDeviceStatus: string
    timestamp: number
    variance: number
}

export class SystemDiagnostic {
    private diagnosticHistory: SystemDiagnosticResult[] = []
    private isRunning: boolean = false

    /**
     * Simple parallel diagnostic system
     * Measures real delays while the system is running
     */
    public async startParallelDiagnostic(): Promise<void> {
        if (this.isRunning) return
        
        this.isRunning = true
        console.log('Starting parallel system diagnostic...')
        
        // Launch diagnostic in background
        this.runDiagnosticLoop()
    }

    public stopDiagnostic(): void {
        this.isRunning = false
        console.log('Parallel diagnostic stopped')
    }

    private async runDiagnosticLoop(): Promise<void> {
        while (this.isRunning) {
            try {
                const result = await this.measureSystemDelays()
                this.diagnosticHistory.push(result)
                
                // Keep only last 20 measurements
                if (this.diagnosticHistory.length > 20) {
                    this.diagnosticHistory = this.diagnosticHistory.slice(-20)
                }
                
                // Wait 500ms before next measurement
                await new Promise(resolve => setTimeout(resolve, 500))
                
            } catch (error) {
                console.warn('Diagnostic measurement failed:', error)
            }
        }
    }

    private async measureSystemDelays(): Promise<SystemDiagnosticResult> {
        const timestamp = Date.now()
        
        // 1. Measure PulseAudio latency
        const pulseLatency = await this.measurePulseAudioLatency()
        
        // 2. Measure system load
        const systemLoad = await this.measureSystemLoad()
        
        // 3. Check audio device status
        const audioStatus = await this.checkAudioDeviceStatus()
        
        // 4. Estimate FFmpeg delay (based on load)
        const ffmpegDelay = this.estimateFFmpegDelay(systemLoad)
        
        // 5. Calculate recent variance
        const variance = this.calculateRecentVariance()
        
        return {
            pulseAudioLatency: pulseLatency,
            ffmpegBufferDelay: ffmpegDelay,
            systemLoad,
            audioDeviceStatus: audioStatus,
            timestamp,
            variance
        }
    }

    private async measurePulseAudioLatency(): Promise<number> {
        try {
            // Obtenir info PulseAudio
            const { stdout } = await execAsync('pactl info')
            
            // Chercher "Default Sample Rate" pour estimer latence
            const sampleRateMatch = stdout.match(/Default Sample Rate: (\d+)/)
            const sampleRate = sampleRateMatch ? parseInt(sampleRateMatch[1]) : 44100
            
            // Latence estimée basée sur sample rate (très approximatif)
            // 44.1kHz = ~23ms typique, 48kHz = ~21ms
            const estimatedLatency = sampleRate === 48000 ? 21 : 23
            
            return estimatedLatency
            
        } catch (error) {
            return 25 // Fallback
        }
    }

    private async measureSystemLoad(): Promise<number> {
        try {
            // Mesurer charge CPU simple
            const { stdout } = await execAsync('top -bn1 | head -3')
            
            // Chercher "load average"
            const loadMatch = stdout.match(/load average: ([\d.]+)/)
            const load = loadMatch ? parseFloat(loadMatch[1]) : 0
            
            return load
            
        } catch (error) {
            return 0
        }
    }

    private async checkAudioDeviceStatus(): Promise<string> {
        try {
            // Vérifier que virtual_speaker.monitor existe
            const { stdout } = await execAsync('pactl list sources short')
            
            if (stdout.includes('virtual_speaker.monitor')) {
                return 'OK'
            } else {
                return 'MISSING'
            }
            
        } catch (error) {
            return 'ERROR'
        }
    }

    private estimateFFmpegDelay(systemLoad: number): number {
        // Estimation basée sur charge système
        // Charge faible = 20ms, charge élevée = 50ms+
        const baseDelay = 20
        const loadPenalty = Math.min(systemLoad * 10, 30)
        
        return baseDelay + loadPenalty
    }

    private calculateRecentVariance(): number {
        if (this.diagnosticHistory.length < 3) return 0
        
        // Calculer variance des latences récentes
        const recentLatencies = this.diagnosticHistory.slice(-5).map(r => r.pulseAudioLatency)
        const avg = recentLatencies.reduce((sum, val) => sum + val, 0) / recentLatencies.length
        const variance = recentLatencies.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / recentLatencies.length
        
        return Math.sqrt(variance)
    }

    public getInstantDiagnostic(): SystemDiagnosticResult | null {
        return this.diagnosticHistory[this.diagnosticHistory.length - 1] || null
    }

    public getDiagnosticSummary(): string {
        if (this.diagnosticHistory.length === 0) {
            return '🔬 No diagnostic data available'
        }

        const latest = this.diagnosticHistory[this.diagnosticHistory.length - 1]
        const avgLoad = this.diagnosticHistory.reduce((sum, r) => sum + r.systemLoad, 0) / this.diagnosticHistory.length
        const avgLatency = this.diagnosticHistory.reduce((sum, r) => sum + r.pulseAudioLatency, 0) / this.diagnosticHistory.length

        return `🔬 === SYSTEM DIAGNOSTIC SUMMARY ===
📊 Samples: ${this.diagnosticHistory.length}
🔊 Avg PulseAudio latency: ${avgLatency.toFixed(1)}ms
⚡ Avg System load: ${avgLoad.toFixed(2)}
📈 Current variance: ${latest.variance.toFixed(1)}ms
🎵 Audio device: ${latest.audioDeviceStatus}
💾 Est. FFmpeg delay: ${latest.ffmpegBufferDelay.toFixed(0)}ms

🎯 DIAGNOSIS:
${this.generateDiagnosis(latest, avgLoad)}`
    }

    private generateDiagnosis(latest: SystemDiagnosticResult, avgLoad: number): string {
        const issues: string[] = []
        
        if (latest.pulseAudioLatency > 30) {
            issues.push('🔊 High PulseAudio latency detected')
        }
        
        if (avgLoad > 1.0) {
            issues.push('⚡ High system load causing delays')
        }
        
        if (latest.variance > 10) {
            issues.push('📈 High variance in measurements')
        }
        
        if (latest.audioDeviceStatus !== 'OK') {
            issues.push('🎵 Audio device issues detected')
        }
        
        if (latest.ffmpegBufferDelay > 40) {
            issues.push('💾 High FFmpeg buffering delays')
        }
        
        if (issues.length === 0) {
            return '✅ System appears stable'
        } else {
            return issues.join('\n')
        }
    }

    /**
     * 🎯 DIAGNOSTIC RAPIDE : Mesure instantanée pour debugging
     */
    public async quickDiagnostic(): Promise<string> {
        const result = await this.measureSystemDelays()
        
        return `🔬 QUICK DIAGNOSTIC:
🔊 PulseAudio: ${result.pulseAudioLatency}ms
📊 System load: ${result.systemLoad.toFixed(2)}
🎵 Audio device: ${result.audioDeviceStatus}
💾 FFmpeg delay: ${result.ffmpegBufferDelay}ms
⏱️ Total estimated delay: ${(result.pulseAudioLatency + result.ffmpegBufferDelay).toFixed(0)}ms`
    }
} 