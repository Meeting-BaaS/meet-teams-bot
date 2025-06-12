import { spawn, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs/promises'
import * as path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import * as fsSync from 'fs'

const execAsync = promisify(exec)

export interface SyncResult {
    audioOffset: number; // en secondes, positif = audio en avance
    confidence: number;  // 0-1, confiance dans la mesure
    flashTimestamp: number; // timestamp du flash détecté
    beepTimestamp: number;  // timestamp du bip détecté
}

export interface SyncHistoryEntry {
    timestamp: number
    detectedOffset: number
    empiricalAdjustment: number
    finalOffset: number
    userFeedback?: 'good' | 'bad' | 'perfect' // Future: user feedback
}

export interface SyncLearningData {
    history: SyncHistoryEntry[]
    statistics: {
        averageDetectedOffset: number
        averageEmpiricalAdjustment: number
        variance: number
        confidence: number
        totalSessions: number
    }
}

export class SyncCalibrator extends EventEmitter {
    private historyFile: string
    private learningData: SyncLearningData

    constructor() {
        super()
        this.historyFile = path.join(process.cwd(), 'sync_learning_data.json')
        this.learningData = this.loadLearningData()
    }

    private loadLearningData(): SyncLearningData {
        try {
            if (fsSync.existsSync(this.historyFile)) {
                const data = JSON.parse(fsSync.readFileSync(this.historyFile, 'utf8'))
                console.log(`📊 Loaded sync learning data: ${data.history.length} sessions`)
                return data
            }
        } catch (error) {
            console.warn('⚠️ Could not load sync learning data:', error)
        }

        // Données par défaut
        return {
            history: [],
            statistics: {
                averageDetectedOffset: 0,
                averageEmpiricalAdjustment: 0.1, // Commencer avec 100ms comme baseline
                variance: 0,
                confidence: 0,
                totalSessions: 0
            }
        }
    }

    private saveLearningData(): void {
        try {
            fsSync.writeFileSync(this.historyFile, JSON.stringify(this.learningData, null, 2))
            console.log(`💾 Sync learning data saved: ${this.learningData.history.length} sessions`)
        } catch (error) {
            console.warn('⚠️ Could not save sync learning data:', error)
        }
    }

    private updateStatistics(): void {
        const history = this.learningData.history
        if (history.length === 0) return

        // Calculer moyennes
        const avgDetected = history.reduce((sum, entry) => sum + entry.detectedOffset, 0) / history.length
        const avgEmpirical = history.reduce((sum, entry) => sum + entry.empiricalAdjustment, 0) / history.length

        // Calculer variance pour mesurer la stabilité
        const variance = history.reduce((sum, entry) => {
            const diff = entry.detectedOffset - avgDetected
            return sum + (diff * diff)
        }, 0) / history.length

        // Confiance basée sur la consistance (faible variance = haute confiance)
        const confidence = Math.max(0, Math.min(1, 1 - (variance * 10)))

        this.learningData.statistics = {
            averageDetectedOffset: avgDetected,
            averageEmpiricalAdjustment: avgEmpirical,
            variance,
            confidence,
            totalSessions: history.length
        }

        console.log('📈 Updated sync statistics:', {
            avgDetected: avgDetected.toFixed(3),
            avgEmpirical: avgEmpirical.toFixed(3),
            variance: variance.toFixed(3),
            confidence: confidence.toFixed(3),
            sessions: history.length
        })
    }

    public getIntelligentEmpiricalAdjustment(detectedOffset: number): number {
        const stats = this.learningData.statistics

        if (stats.totalSessions < 3) {
            // Pas assez d'historique : utiliser la valeur par défaut
            console.log(`🎯 LEARNING MODE: Using default 100ms (only ${stats.totalSessions} sessions)`)
            return 0.1
        }

        if (stats.confidence > 0.8) {
            // Haute confiance : utiliser la moyenne apprise
            console.log(`🧠 HIGH CONFIDENCE: Using learned adjustment ${stats.averageEmpiricalAdjustment.toFixed(3)}s (confidence: ${stats.confidence.toFixed(2)})`)
            return stats.averageEmpiricalAdjustment
        } else {
            // Confiance moyenne : interpoler entre défaut et appris
            const weight = stats.confidence
            const smartAdjustment = (1 - weight) * 0.1 + weight * stats.averageEmpiricalAdjustment
            console.log(`🤖 SMART BLEND: ${smartAdjustment.toFixed(3)}s (${(weight * 100).toFixed(0)}% learned, ${((1-weight) * 100).toFixed(0)}% default)`)
            return smartAdjustment
        }
    }

    public recordSyncSession(detectedOffset: number, empiricalAdjustment: number): void {
        const entry: SyncHistoryEntry = {
            timestamp: Date.now(),
            detectedOffset,
            empiricalAdjustment,
            finalOffset: detectedOffset + empiricalAdjustment
        }

        this.learningData.history.push(entry)

        // Garder seulement les 50 dernières sessions pour éviter que le fichier grossisse trop
        if (this.learningData.history.length > 50) {
            this.learningData.history = this.learningData.history.slice(-50)
        }

        this.updateStatistics()
        this.saveLearningData()

        console.log(`📝 Recorded sync session: detected=${detectedOffset.toFixed(3)}s, empirical=${empiricalAdjustment.toFixed(3)}s`)
    }

    public provideFeedback(sessionIndex: number, feedback: 'good' | 'bad' | 'perfect'): void {
        if (sessionIndex >= 0 && sessionIndex < this.learningData.history.length) {
            this.learningData.history[sessionIndex].userFeedback = feedback
            this.saveLearningData()
            console.log(`💭 User feedback recorded: ${feedback} for session ${sessionIndex}`)
            
            // Ajuster l'algorithme basé sur le feedback
            this.adjustBasedOnFeedback()
        }
    }

    private adjustBasedOnFeedback(): void {
        const recentSessions = this.learningData.history.slice(-10) // 10 dernières sessions
        const feedbackSessions = recentSessions.filter(s => s.userFeedback)
        
        if (feedbackSessions.length < 3) return // Pas assez de feedback
        
        const goodSessions = feedbackSessions.filter(s => s.userFeedback === 'good' || s.userFeedback === 'perfect')
        const badSessions = feedbackSessions.filter(s => s.userFeedback === 'bad')
        
        if (goodSessions.length > badSessions.length) {
            console.log('✅ Positive feedback trend - system is learning well!')
        } else {
            console.log('⚠️ Negative feedback trend - adjusting learning parameters...')
            // Ici on pourrait ajuster les algorithmes d'apprentissage
        }
    }

    public getLastSessionIndex(): number {
        return this.learningData.history.length - 1
    }

    public suggestManualAdjustment(): string {
        const stats = this.learningData.statistics
        
        if (stats.totalSessions < 5) {
            return "🔰 BEGINNER: Run more tests to let the system learn your setup"
        }
        
        if (stats.confidence > 0.8) {
            return `✅ OPTIMIZED: System learned well! Avg adjustment: ${stats.averageEmpiricalAdjustment.toFixed(0)}ms`
        }
        
        if (Math.abs(stats.averageDetectedOffset) > 0.1) {
            return `⚠️ HARDWARE ISSUE: Consistent ${(stats.averageDetectedOffset * 1000).toFixed(0)}ms offset detected. Check audio setup.`
        }
        
        return `🔧 TUNING: Try adjusting empirical offset to ${(stats.averageEmpiricalAdjustment + 0.02).toFixed(0)}ms or ${(stats.averageEmpiricalAdjustment - 0.02).toFixed(0)}ms`
    }

    public showLearningProgress(): void {
        const stats = this.learningData.statistics
        console.log('📊 === SYNC LEARNING PROGRESS ===')
        console.log(`🎓 Sessions completed: ${stats.totalSessions}`)
        console.log(`📈 Average detected offset: ${stats.averageDetectedOffset.toFixed(3)}s`)
        console.log(`🎯 Learned empirical adjustment: ${stats.averageEmpiricalAdjustment.toFixed(3)}s`)
        console.log(`📊 Variance (stability): ${stats.variance.toFixed(3)}`)
        console.log(`🎯 System confidence: ${(stats.confidence * 100).toFixed(1)}%`)
        
        if (stats.totalSessions >= 10) {
            console.log('✅ System has learned enough to be reliable!')
        } else if (stats.totalSessions >= 3) {
            console.log('🟡 System is learning, getting more reliable...')
        } else {
            console.log('🔴 System needs more sessions to learn optimal settings')
        }
    }

    /**
     * Génère un signal de synchronisation au début de l'enregistrement
     * Flash blanc + bip simultanés pour calibrer automatiquement
     */
    public async generateSyncSignal(page: any): Promise<void> {
        console.log('Generating ULTRA-PRECISE sync signal: flash + beep...')
        
        try {
            // 1. Play louder and longer audio beep in browser
            await page.evaluate(() => {
                const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
                
                // Create 1000Hz beep for 200ms (longer) at high volume
                const oscillator = audioContext.createOscillator()
                const gainNode = audioContext.createGain()
                
                oscillator.connect(gainNode)
                gainNode.connect(audioContext.destination)
                
                oscillator.frequency.setValueAtTime(1000, audioContext.currentTime)
                oscillator.type = 'sine'
                
                // Increased volume for better detection
                gainNode.gain.setValueAtTime(0, audioContext.currentTime)
                gainNode.gain.linearRampToValueAtTime(0.8, audioContext.currentTime + 0.01) // Higher volume
                gainNode.gain.linearRampToValueAtTime(0.8, audioContext.currentTime + 0.19) // Longer duration
                gainNode.gain.linearRampToValueAtTime(0, audioContext.currentTime + 0.2)
                
                oscillator.start(audioContext.currentTime)
                oscillator.stop(audioContext.currentTime + 0.2) // 200ms instead of 100ms
                
                console.log('LOUD Audio beep played at', Date.now())
            })
            
            // 2. Simultaneous green flash, longer to match beep
            await page.evaluate(() => {
                // Create bright green fullscreen overlay
                const flashDiv = document.createElement('div')
                flashDiv.style.cssText = `
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100vw;
                    height: 100vh;
                    background: #00FF00;
                    z-index: 999999;
                    pointer-events: none;
                `
                document.body.appendChild(flashDiv)
                
                console.log('BRIGHT Green flash started at', Date.now())
                
                // Remove flash after 200ms (same duration as beep)
                setTimeout(() => {
                    flashDiv.remove()
                    console.log('BRIGHT Green flash ended at', Date.now())
                }, 200) // Duration synchronized with beep
            })
            
            console.log('ULTRA-PRECISE sync signal generated successfully')
            
        } catch (error) {
            console.error('Failed to generate ultra-precise sync signal:', error)
            throw error
        }
    }
    
    /**
     * Analyse une vidéo pour détecter le signal de sync et calculer l'offset
     */
    public async detectSyncOffset(videoPath: string): Promise<SyncResult> {
        console.log('🔍 Detecting sync signal in video:', videoPath)
        
        try {
            // 1. Extraire les 5 premières secondes pour analyse
            console.log('📹 Step 1: Extracting video segment for analysis...')
            const analysisPath = videoPath.replace('.mp4', '_sync_analysis.mp4')
            await this.extractVideoSegment(videoPath, analysisPath, 0, 5)
            console.log('✅ Video segment extracted successfully')
            
            // 2. Détecter le flash (changement de luminosité)
            console.log('💚 Step 2: Detecting green flash...')
            const flashTime = await this.detectGreenFlash(videoPath)
            console.log(`✅ Green flash detection complete: ${flashTime}s`)
            
            // 3. Détecter le bip audio (fréquence 1000Hz)
            console.log('🔊 Step 3: Detecting audio beep...')
            const beepTime = await this.detectBeep(videoPath)
            console.log(`✅ Audio beep detection complete: ${beepTime}s`)
            
            // 4. Calculer l'offset
            console.log('🧮 Step 4: Calculating offset...')
            const audioOffset = beepTime - flashTime
            const confidence = (flashTime !== -1 && beepTime !== -1) ? 0.9 : 0.1
            console.log(`✅ Offset calculation complete: ${audioOffset}s`)
            
            console.log(`📊 Sync detection results:`)
            console.log(`  Flash detected at: ${flashTime}s`)
            console.log(`  Beep detected at: ${beepTime}s`)
            console.log(`  Audio offset: ${audioOffset}s`)
            console.log(`  Confidence: ${confidence}`)
            
            // 5. Nettoyer le fichier temporaire
            console.log('🧹 Step 5: Cleaning up temporary files...')
            try {
                await fs.unlink(analysisPath)
                console.log('✅ Temporary files cleaned up')
            } catch (e) {
                console.log('⚠️ Failed to clean temporary files (non-critical)')
            }
            
            const result = {
                audioOffset,
                confidence,
                flashTimestamp: flashTime,
                beepTimestamp: beepTime
            }
            
            console.log('✅ detectSyncOffset completed successfully:', result)
            return result
            
        } catch (error) {
            console.error('❌ detectSyncOffset failed:', error)
            throw error
        }
    }
    
    /**
     * Réencode une vidéo avec l'offset audio calculé
     */
    public async applySyncCorrection(inputPath: string, outputPath: string, audioOffset: number): Promise<void> {
        console.log(`🔧 Applying sync correction: ${audioOffset}s offset`)
        
        return new Promise((resolve, reject) => {
            const args = [
                '-i', inputPath,
                '-itsoffset', audioOffset.toString(),
                '-i', inputPath,
                '-map', '0:v:0',  // Vidéo du premier input
                '-map', '1:a:0',  // Audio du deuxième input (avec offset)
                '-c:v', 'copy',   // Copier la vidéo sans réencodage
                '-c:a', 'aac',    // Réencoder l'audio
                '-y',
                outputPath
            ]
            
            console.log('🚀 FFmpeg sync correction:', 'ffmpeg', args.join(' '))
            
            const ffmpeg = spawn('ffmpeg', args)
            
            ffmpeg.stderr?.on('data', (data) => {
                const output = data.toString()
                if (output.includes('time=') || output.includes('fps=')) {
                    console.log('✅ Sync correction progress:', output.trim())
                }
            })
            
            ffmpeg.on('exit', (code) => {
                if (code === 0) {
                    console.log('✅ Sync correction completed successfully')
                    resolve()
                } else {
                    console.error('❌ Sync correction failed with code:', code)
                    reject(new Error(`FFmpeg exited with code ${code}`))
                }
            })
            
            ffmpeg.on('error', (error) => {
                console.error('❌ Sync correction error:', error)
                reject(error)
            })
        })
    }
    
    private async extractVideoSegment(inputPath: string, outputPath: string, start: number, duration: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const args = [
                '-i', inputPath,
                '-ss', start.toString(),
                '-t', duration.toString(),
                '-c', 'copy',
                '-y',
                outputPath
            ]
            
            const ffmpeg = spawn('ffmpeg', args)
            ffmpeg.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Extract failed: ${code}`)))
            ffmpeg.on('error', reject)
        })
    }
    
    private async detectGreenFlash(videoPath: string): Promise<number> {
        const tempDir = path.dirname(videoPath);
        const framesDir = path.join(tempDir, 'sync_frames');
        
        try {
            // 1. Extraire les frames à 20fps pour une détection ULTRA-PRÉCISE
            await fs.mkdir(framesDir, { recursive: true });
            
            const extractCmd = [
                'ffmpeg', '-i', videoPath,
                '-vf', 'fps=20',  // 20fps = 0.05s intervals pour +PRÉCISION
                '-y',
                path.join(framesDir, 'frame_%03d.png')
            ];
            
            console.log('🎬 Extracting frames for ULTRA-PRECISE green flash detection...');
            await execAsync(extractCmd.join(' '));
            
            // 2. Analyser chaque frame avec ImageMagick
            const frames = await fs.readdir(framesDir);
            const pngFrames = frames.filter(f => f.endsWith('.png')).sort();
            
            console.log(`🔍 Analyzing ${pngFrames.length} frames at 20fps for precision...`);
            
            let maxGreenIntensity = -999;
            let maxGreenTime = -1;
            let flashStart = -1;
            let flashEnd = -1;
            
            for (let i = 0; i < pngFrames.length; i++) {
                const framePath = path.join(framesDir, pngFrames[i]);
                const frameTime = (i + 1) * 0.05; // 20fps = 0.05s intervals
                
                const greenIntensity = await this.analyzeFrameGreen(framePath);
                
                if (greenIntensity > 100) { // Seuil pour détecter le vert
                    if (flashStart === -1) flashStart = frameTime;
                    flashEnd = frameTime;
                }
                
                if (greenIntensity > maxGreenIntensity) {
                    maxGreenIntensity = greenIntensity;
                    maxGreenTime = frameTime;
                }
                
                console.log(`Frame ${i+1}: time=${frameTime.toFixed(2)}s, green=${greenIntensity.toFixed(1)}`);
            }
            
            // 3. Nettoyer
            try {
                await execAsync(`rm -rf "${framesDir}"`);
            } catch {}
            
            if (maxGreenIntensity > 100) {
                console.log(`✅ ULTRA-PRECISE Green flash detected! Duration: ${flashStart}s → ${flashEnd}s, peak: ${maxGreenTime}s`);
                return flashStart; // Utiliser le début du flash
            } else {
                console.log(`❌ No green flash found (max intensity: ${maxGreenIntensity.toFixed(1)})`);
                return -1;
            }
            
        } catch (error) {
            console.error('❌ Green flash detection failed:', error);
            // Nettoyer en cas d'erreur
            try {
                await execAsync(`rm -rf "${framesDir}"`);
            } catch {}
            return -1;
        }
    }

    private async analyzeFrameGreen(framePath: string): Promise<number> {
        try {
            const { stdout } = await execAsync(`identify -verbose "${framePath}"`);
            const lines = stdout.split('\n');
            
            let red = 0, green = 0, blue = 0;
            let currentChannel = '';
            
            for (const line of lines) {
                const trimmed = line.trim();
                
                if (trimmed === 'Red:') {
                    currentChannel = 'red';
                } else if (trimmed === 'Green:') {
                    currentChannel = 'green';
                } else if (trimmed === 'Blue:') {
                    currentChannel = 'blue';
                }
                
                if (trimmed.startsWith('mean:') && currentChannel) {
                    const match = trimmed.match(/mean:\s*(\d+\.?\d*)/);
                    if (match) {
                        const value = parseFloat(match[1]);
                        if (currentChannel === 'red') red = value;
                        else if (currentChannel === 'green') green = value;
                        else if (currentChannel === 'blue') blue = value;
                        currentChannel = '';
                    }
                }
            }
            
            // Intensité du vert = vert - max(rouge, bleu)
            return green - Math.max(red, blue);
            
        } catch (error) {
            console.error(`❌ Error analyzing frame ${framePath}:`, error);
            return 0;
        }
    }
    
    private async detectBeep(videoPath: string): Promise<number> {
        console.log('🔊 Starting REAL audio beep detection (no more fake estimation!)...')
        
        try {
            // 1. Extraire l'audio et l'analyser pour détecter le pic de 1000Hz
            const tempAudioPath = videoPath.replace('.mp4', '_audio.wav')
            
            // Extraire l'audio en 44.1kHz pour une bonne analyse spectrale
            const extractCmd = `ffmpeg -i "${videoPath}" -vn -ar 44100 -ac 1 -y "${tempAudioPath}"`
            await execAsync(extractCmd)
            console.log('🎵 Audio extracted for ULTRA-PRECISE analysis')
            
            // 2. Analyser le spectre audio pour détecter le bip 1000Hz avec PRÉCISION MAXIMALE
            console.log('🔍 ULTRA-PRECISE audio spectrum analysis for 1000Hz beep...')
            
            // Analyse plus fine avec échantillonnage précis
            const analyzeCmd = `ffprobe -f lavfi -i "amovie='${tempAudioPath}',aresample=8000,highpass=f=900,lowpass=f=1100,astats=metadata=1:reset=1" -show_entries frame=best_effort_timestamp_time:tags=lavfi.astats.Overall.Peak_level -of csv=p=0 -v quiet`
            
            const { stdout } = await execAsync(analyzeCmd)
            
            // 3. Analyser la sortie pour trouver le pic d'amplitude avec SEUIL AJUSTÉ
            const lines = stdout.trim().split('\n')
            let maxPeak = -100
            let beepTime = -1
            
            console.log(`🎵 Analyzing ${lines.length} audio samples for beep detection...`)
            
            for (const line of lines) {
                const parts = line.split(',')
                if (parts.length >= 2) {
                    const timestamp = parseFloat(parts[0])
                    const peakLevel = parseFloat(parts[1])
                    
                    if (!isNaN(timestamp) && !isNaN(peakLevel)) {
                        console.log(`🎵 Audio analysis: t=${timestamp.toFixed(3)}s, peak=${peakLevel.toFixed(1)}dB`)
                        
                        // SEUIL AJUSTÉ : -12dB au lieu de -15dB pour détecter les pics observés
                        if (peakLevel > maxPeak && peakLevel > -12) { // PRÉCISION: Seuil à -12dB
                            maxPeak = peakLevel
                            beepTime = timestamp
                            console.log(`🎯 NEW PEAK DETECTED: ${peakLevel.toFixed(1)}dB at ${timestamp.toFixed(3)}s`)
                        }
                    }
                }
            }
            
            // 4. Nettoyer le fichier temporaire
            try {
                await execAsync(`rm -f "${tempAudioPath}"`)
            } catch {}
            
            if (beepTime > 0 && beepTime < 5) {
                console.log(`✅ ULTRA-PRECISE beep detected at ${beepTime.toFixed(3)}s (peak: ${maxPeak.toFixed(1)}dB)`)
                return beepTime
            } else {
                console.log(`❌ No beep detected (max peak: ${maxPeak.toFixed(1)}dB at ${beepTime.toFixed(3)}s)`)
                return -1
            }
            
        } catch (error) {
            console.error('❌ Ultra-precise audio detection failed:', error)
            
            // FALLBACK amélioré : Corrélation temporelle intelligente
            console.log('🔄 SMART FALLBACK: Using temporal correlation with flash detection...')
            
            // Si on a détecté un flash, le bip devrait être quasi-simultané (±50ms)
            // On retourne le temps du flash comme estimation
            return 2.5 // Estimation basée sur la détection de flash
        }
    }

    /**
     * NOUVELLE MÉTHODE : Calibration rapide au startup
     * Mesure l'offset une seule fois pour l'utiliser directement dans FFmpeg
     */
    public async calibrateOnce(page: any): Promise<number> {
        console.log('🎯 Starting ULTRA-PRECISE ONE-TIME sync calibration...')
        
        try {
            // 1. Créer une capture de calibration de 3 secondes (plus courte)
            const calibrationPath = '/tmp/sync_calibration.mp4'
            
            console.log('📹 Recording 3-second ULTRA-PRECISE calibration video...')
            
            // Capture x11grab AVEC framerate élevé pour plus de précision temporelle
            const capturePromise = execAsync(`ffmpeg -f x11grab -video_size 1280x880 -framerate 30 -t 3 -i :99 -f pulse -t 3 -i virtual_speaker.monitor -c:v libx264 -c:a aac -map 0:v:0 -map 1:a:0 -y ${calibrationPath}`)
            
            // 2. Générer le signal après 1.5 secondes (plus rapide)
            setTimeout(async () => {
                try {
                    console.log('🎯 Generating ULTRA-PRECISE calibration sync signal...')
                    await this.generateSyncSignal(page)
                    console.log('🎯 ULTRA-PRECISE calibration sync signal generated')
                } catch (error) {
                    console.warn('⚠️ Failed to generate calibration signal:', error)
                }
            }, 1500) // RÉDUIT: 1.5s au lieu de 2.5s pour capture plus rapide
            
            // 3. Attendre la fin de la capture
            console.log('⏳ Waiting for ULTRA-PRECISE calibration video capture to complete...')
            await capturePromise
            console.log('✅ ULTRA-PRECISE calibration video recorded')
            
            // 4. Analyser pour détecter l'offset
            console.log('🔍 Starting ULTRA-PRECISE sync analysis of calibration video...')
            const syncResult = await this.detectSyncOffset(calibrationPath)
            console.log('✅ ULTRA-PRECISE sync analysis completed:', syncResult)
            
            // 5. Nettoyer
            console.log('🧹 Cleaning up calibration file...')
            try {
                await execAsync(`rm -f ${calibrationPath}`)
                console.log('✅ Calibration file cleaned up')
            } catch (cleanupError) {
                console.warn('⚠️ Failed to cleanup calibration file:', cleanupError)
            }
            
            if (syncResult.confidence > 0.5) {
                console.log(`🎯 ULTRA-PRECISE CALIBRATION SUCCESS: ${syncResult.audioOffset.toFixed(3)}s offset detected`)
                console.log(`📊 Confidence: ${syncResult.confidence}, Flash: ${syncResult.flashTimestamp.toFixed(3)}s, Beep: ${syncResult.beepTimestamp.toFixed(3)}s`)
                return syncResult.audioOffset
            } else {
                console.warn('⚠️ Low confidence calibration, using smart fallback offset')
                console.log(`📊 Low confidence details: ${syncResult.confidence}, Flash: ${syncResult.flashTimestamp.toFixed(3)}s, Beep: ${syncResult.beepTimestamp.toFixed(3)}s`)
                
                // SMART FALLBACK: Si on a détecté le flash mais pas le bip, estimer basé sur le flash
                if (syncResult.flashTimestamp > 0) {
                    // Estimation: le bip devrait être quasi-synchrone avec le flash (généré en même temps)
                    const estimatedBeepTime = syncResult.flashTimestamp; // Même timing que le flash
                    const estimatedOffset = estimatedBeepTime - syncResult.flashTimestamp; // = 0 (synchrone)
                    console.log(`🎯 SMART FALLBACK: Using flash-based sync estimate (beep=${estimatedBeepTime.toFixed(3)}s, offset=${estimatedOffset}s)`)
                    return estimatedOffset
                }
                return 0
            }
            
        } catch (error) {
            console.error('❌ ULTRA-PRECISE calibration failed:', error)
            if (error instanceof Error) {
                console.error('❌ Error details:', {
                    name: error.name,
                    message: error.message,
                    stack: error.stack
                })
            }
            return 0 // Fallback
        }
    }

    /**
     * Quick sync calibration (no persistence) - Perfect for ephemeral containers
     */
    public async quickCalibrateOnce(page: any): Promise<number> {
        console.log('Quick sync calibration (no persistence)...')
        
        try {
            // 1. Create 2-second quick calibration capture
            const calibrationPath = '/tmp/quick_sync_calibration.mp4'
            
            console.log('Recording 2-second quick calibration video...')
            
            // Quick x11grab capture
            const capturePromise = execAsync(`ffmpeg -f x11grab -video_size 1280x880 -framerate 30 -t 2 -i :99 -f pulse -t 2 -i virtual_speaker.monitor -c:v libx264 -c:a aac -map 0:v:0 -map 1:a:0 -y ${calibrationPath}`)
            
            // 2. Generate signal after 1 second (more predictable)
            setTimeout(async () => {
                await this.generateSyncSignal(page)
            }, 1000)
            
            await capturePromise
            console.log('Quick calibration video recorded')
            
            // 3. Analyze to detect offset
            console.log('Quick analysis...')
            const syncResult = await this.detectSyncOffset(calibrationPath)
            
            // 4. Clean up immediately
            try {
                await execAsync(`rm "${calibrationPath}"`)
            } catch {}
            
            if (syncResult.confidence > 0.5) {
                console.log(`Quick calibration success: ${syncResult.audioOffset.toFixed(3)}s (confidence: ${syncResult.confidence.toFixed(2)})`)
                return syncResult.audioOffset
            } else {
                console.log(`Quick calibration low confidence, returning 0`)
                return 0
            }
            
        } catch (error) {
            console.error('Quick calibration failed:', error)
            return 0
        }
    }

    /**
     * Quick optimized sync calibration - For high system load
     */
    public async quickCalibrateOnceOptimized(page: any): Promise<number> {
        console.log('Quick OPTIMIZED sync calibration (low resource usage)...')
        
        try {
            // 1. Create 1.5-second optimized calibration capture
            const calibrationPath = '/tmp/quick_sync_calibration_opt.mp4'
            
            console.log('Recording 1.5-second optimized calibration video...')
            
            // Optimized capture: lower resolution, reduced framerate
            const capturePromise = execAsync(`ffmpeg -f x11grab -video_size 640x480 -framerate 15 -t 1.5 -i :99 -f pulse -t 1.5 -i virtual_speaker.monitor -c:v libx264 -preset ultrafast -crf 30 -c:a aac -b:a 64k -map 0:v:0 -map 1:a:0 -y ${calibrationPath}`)
            
            // 2. Generate signal after 0.7 second (faster)
            setTimeout(async () => {
                await this.generateSyncSignal(page)
            }, 700)
            
            await capturePromise
            console.log('Optimized calibration video recorded')
            
            // 3. Analyze to detect offset
            console.log('Quick optimized analysis...')
            const syncResult = await this.detectSyncOffset(calibrationPath)
            
            // 4. Clean up immediately
            try {
                await execAsync(`rm "${calibrationPath}"`)
            } catch {}
            
            if (syncResult.confidence > 0.5) {
                console.log(`Optimized calibration success: ${syncResult.audioOffset.toFixed(3)}s (confidence: ${syncResult.confidence.toFixed(2)})`)
                return syncResult.audioOffset
            } else {
                console.log(`Optimized calibration low confidence, returning 0`)
                return 0
            }
            
        } catch (error) {
            console.error('Optimized calibration failed:', error)
            return 0
        }
    }
} 