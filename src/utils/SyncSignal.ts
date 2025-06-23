/**
 * Utility function to generate audio-visual sync signal for recordings
 * Generates a 1000Hz beep + green flash for synchronization purposes
 */

import { Page } from "playwright"

export interface SyncSignalOptions {
    /** Duration of the sync signal in milliseconds (default: 500) */
    duration?: number
    /** Audio frequency in Hz (default: 1000) */
    frequency?: number
    /** Flash color (default: '#00FF00' - bright green) */
    flashColor?: string
    /** Audio volume (0-1, default: 0.9) */
    volume?: number
}

/**
 * Generate synchronization signal on the given page
 * @param page - Playwright page instance
 * @param options - Optional configuration for the sync signal
 */
export async function generateSyncSignal(
    page: Page, 
    options: SyncSignalOptions = {}
): Promise<void> {
    const {
        duration = 150,
        frequency = 1000,
        flashColor = '#00FF00',
        volume = 0.9
    } = options

    console.log(`🎯 Generating sync signal: ${frequency}Hz beep + flash (${duration}ms)`)

    try {
        // Generate audio beep and visual flash simultaneously
        await Promise.all([
            generateAudioBeep(page, frequency, duration, volume),
            generateVisualFlash(page, flashColor, duration)
        ])

        console.log('✅ Sync signal generated successfully')
    } catch (error) {
        console.error('❌ Failed to generate sync signal:', error)
        throw error
    }
}

/**
 * Generate audio beep in the browser
 */
async function generateAudioBeep(
    page: any, 
    frequency: number, 
    duration: number, 
    volume: number
): Promise<void> {
    await page.evaluate(({ freq, dur, vol }) => {
        if ((window as any).__syncAudioContext) {
            console.log('⚠️ AudioContext already exists, skipping duplicate beep')
            return
        }

        try {
            const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
            
            ;(window as any).__syncAudioContext = audioContext
            
            const oscillator = audioContext.createOscillator()
            const gainNode = audioContext.createGain()
            
            oscillator.connect(gainNode)
            gainNode.connect(audioContext.destination)
            
            oscillator.frequency.setValueAtTime(freq, audioContext.currentTime)
            oscillator.type = 'sine'
            
            const durationSec = dur / 1000
            gainNode.gain.setValueAtTime(0, audioContext.currentTime)
            gainNode.gain.setValueAtTime(vol, audioContext.currentTime + 0.005)
            gainNode.gain.setValueAtTime(vol, audioContext.currentTime + durationSec - 0.005)
            gainNode.gain.setValueAtTime(0, audioContext.currentTime + durationSec)
            
            oscillator.start(audioContext.currentTime)
            oscillator.stop(audioContext.currentTime + durationSec)
            
            setTimeout(() => {
                try {
                    audioContext.close()
                    delete (window as any).__syncAudioContext
                } catch (e) {
                    console.warn('AudioContext cleanup warning:', e)
                }
            }, dur + 100)
            
            console.log(`🔊 Audio beep: ${freq}Hz for ${dur}ms at volume ${vol}`)
        } catch (error) {
            console.error('Audio beep error:', error)
            delete (window as any).__syncAudioContext
        }
    }, { freq: frequency, dur: duration, vol: volume })
}

/**
 * Generate visual flash overlay
 */
async function generateVisualFlash(
    page: any, 
    color: string, 
    duration: number
): Promise<void> {
    await page.evaluate(({ flashColor, dur }) => {
        if (document.querySelector('#sync-flash-overlay')) {
            console.log('⚠️ Flash overlay already exists, skipping duplicate')
            return
        }

        const flashDiv = document.createElement('div')
        flashDiv.id = 'sync-flash-overlay'
        flashDiv.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: ${flashColor};
            z-index: 999999;
            pointer-events: none;
            box-shadow: inset 0 0 30px ${flashColor};
            opacity: 0.9;
        `
        
        document.body.appendChild(flashDiv)
        console.log(`💡 Visual flash: ${flashColor} for ${dur}ms`)
        
        setTimeout(() => {
            flashDiv.remove()
        }, dur)
    }, { flashColor: color, dur: duration })
} 