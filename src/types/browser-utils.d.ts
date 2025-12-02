/**
 * Type definitions for browser-side utilities injected via browser-speaker-utils.js
 */

interface SpeakerUtils {
    generateStableUserId: (name: string, profilePicture?: string) => string
    createSequentialIdManager: () => {
        getSequentialId: (stableId: string) => number
    }
    areMapsEqual: <K, V>(map1: Map<K, V>, map2: Map<K, V>) => boolean
}

declare global {
    interface Window {
        __speakerUtils: SpeakerUtils
    }
}

export {}
