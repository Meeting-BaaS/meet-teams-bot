export const MEETING_CONSTANTS = {
    // Durées
    CHUNKS_PER_TRANSCRIPTION: 18,
    CHUNK_DURATION: 10_000, // 10 secondes pour chaque chunk
    // TRANSCRIBE_DURATION: 10_000 * MEETING_CONSTANTS.CHUNKS_PER_TRANSCRIPTION, // 3 minutes pour chaque transcription

    // Timeouts
    SETUP_TIMEOUT: 30_000, // 30 secondes
    RECORDING_TIMEOUT: 3600 * 4 * 1000, // 4 heures
    INITIAL_WAIT_TIME: 1000 * 60 * 7, // 7 minutes
    SILENCE_TIMEOUT: 1000 * 60 * 15, // 15 minutes
    CLEANUP_TIMEOUT: 1000 * 60 * 60, // 1 heure
    RESUMING_TIMEOUT: 1000 * 60 * 60, // 1 heure

    // Autres constantes
    FIND_END_MEETING_SLEEP: 250,
    MAX_RETRIES: 3,
} as const

export const OCR_CONSTANTS = {
    // Continuous OCR settings
    ENABLE_CONTINUOUS_OCR: true, // Set to true for continuous OCR throughout meeting

    // Screenshot processing windows (reduced now that we know it works)
    DEFAULT_SCREENSHOT_MAX_AGE_MS: 30_000, // 30 seconds (reduced from 5 minutes)
    RETRY_SCREENSHOT_MAX_AGE_MS: 20_000, // 20 seconds (reduced from 4 minutes)

    // OCR and detection settings
    DEFAULT_CONFIDENCE_THRESHOLD: 0.6,
    DEFAULT_MAX_ATTEMPTS: 3,
    DEFAULT_TIMEOUT_MS: 30_000, // 30 seconds
    DEFAULT_RETRY_DELAY_MS: 2_000, // 2 seconds

    // Image preprocessing settings
    DEFAULT_SCALE_FACTOR: 2.0,
    DEFAULT_CONTRAST: 1.3,
    DEFAULT_BRIGHTNESS: 1.0,

    // Alternative preprocessing configs
    ALTERNATIVE_CONFIGS: [
        {
            scale: 4.0,
            contrast: 2.0,
            brightness: 1.2,
            noiseReduction: false,
            binarization: true,
            deskew: false,
            sharpen: true,
        },
        {
            scale: 2.5,
            contrast: 1.5,
            brightness: 0.9,
            noiseReduction: true,
            binarization: false,
            deskew: true,
            sharpen: false,
        },
    ],

    // Supported languages
    SUPPORTED_LANGUAGES: ['en', 'fr', 'es', 'de'],

    // CAPTCHA keywords for detection (subset of continuous OCR)
    CAPTCHA_KEYWORDS: {
        en: ['verify', 'robot', 'captcha', 'human', 'person', 'prove'],
        fr: ['vérifiez', 'robot', 'captcha', 'humain', 'personne', 'prouver'],
        es: ['verificar', 'robot', 'captcha', 'humano', 'persona', 'probar'],
        de: [
            'überprüfen',
            'roboter',
            'captcha',
            'mensch',
            'person',
            'beweisen',
        ],
    },
} as const

// Keep the old name for backward compatibility
export const CAPTCHA_CONSTANTS = OCR_CONSTANTS
