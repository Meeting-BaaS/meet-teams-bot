export interface RecordingConfig {
    // Configuration pour l'enregistrement d'écran direct
    screen: {
        width: number
        height: number
        framerate: number
        outputFormat: 'webm' | 'mp4'
        videoCodec: 'libx264' | 'libvpx-vp9' | 'libvpx'
        audioCodec: 'aac' | 'opus' | 'libmp3lame'
        videoBitrate: string
        audioBitrate: string
        audioDevice: string
        chunkDuration: number // en millisecondes
    }
}

export const DEFAULT_RECORDING_CONFIG: RecordingConfig = {
    screen: {
        width: 1280,
        height: 720,
        framerate: 30,
        outputFormat: 'mp4',
        videoCodec: 'libx264',
        audioCodec: 'aac',
        videoBitrate: '800k',
        audioBitrate: '128k',
        audioDevice: 'default',
        chunkDuration: 3000 // 3 secondes
    }
}

export function getRecordingConfig(): RecordingConfig {
    return DEFAULT_RECORDING_CONFIG
} 