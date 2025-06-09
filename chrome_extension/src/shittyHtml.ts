import { RecordingMode } from './api'

import * as MeetProvider from './shittyHtml/meet'
import * as TeamsProvider from './shittyHtml/teams'

declare var MEETING_PROVIDER: string
declare var RECORDING_MODE: RecordingMode

type Provider = {
    removeInitialShityHtml: (arg0: RecordingMode) => Promise<void>
    removeShityHtml: (arg0: RecordingMode) => void
}

let PROVIDER: Provider | null = null

// Debounce pour éviter les appels trop fréquents (OPTIMISATION PERFORMANCE)
let shittyHtmlTimeout: ReturnType<typeof setTimeout> | null = null
const SHITTY_HTML_DEBOUNCE = 1000 // 1 seconde - évite les pics CPU sans perdre l'efficacité

// Initialiser le provider
if (MEETING_PROVIDER === 'Teams') {
    PROVIDER = TeamsProvider
} else if (MEETING_PROVIDER === 'Meet') {
    PROVIDER = MeetProvider
}

// S'assurer que le provider est initialisé avant d'utiliser les fonctions
if (PROVIDER) {
    // Initialisation
    if (RECORDING_MODE !== 'audio_only') {
        PROVIDER.removeInitialShityHtml(RECORDING_MODE).catch((e) =>
            console.warn('Error in initial HTML cleanup:', e),
        )
    }

    // Observer les changements avec debounce pour optimiser les performances
    const observer = new MutationObserver(() => {
        // Debounce : évite d'appeler removeShityHtml trop souvent
        // Les mutations sont toujours détectées, mais traitées max 1 fois/seconde
        if (shittyHtmlTimeout !== null) {
            clearTimeout(shittyHtmlTimeout)
        }

        shittyHtmlTimeout = setTimeout(() => {
            if (PROVIDER && RECORDING_MODE !== 'audio_only') {
                try {
                    PROVIDER.removeShityHtml(RECORDING_MODE)
                    console.log('ShittyHtml cleanup executed (debounced)')
                } catch (e) {
                    console.warn('Error in shittyHtml removal:', e)
                }
            }
            shittyHtmlTimeout = null
        }, SHITTY_HTML_DEBOUNCE)
    })

    // Observer le document entier pour les changements
    if (document.documentElement) {
        // Vérifier que documentElement existe
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
        })
        console.log('ShittyHtml observer started with 1s debounce for CPU optimization')
    } else {
        console.warn('Document root element not found')
    }
} else {
    console.warn('No valid provider found for:', MEETING_PROVIDER)
}
