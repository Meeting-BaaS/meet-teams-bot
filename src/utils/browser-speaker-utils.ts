/**
 * Browser-compatible speaker ID utilities.
 * This file is compiled to JavaScript and injected into browser contexts via page.addScriptTag().
 *
 * IMPORTANT: Keep this in sync with speaker-id.ts!
 */

// Generate stable user ID from participant name
function generateStableUserId(name: string, profilePicture?: string): string {
    const input = profilePicture || name
    let hash = 0
    for (let i = 0; i < input.length; i++) {
        const char = input.charCodeAt(i)
        hash = ((hash << 5) - hash) + char
        hash = hash & hash
    }
    return Math.abs(hash).toString(16).padStart(16, '0')
}

// Create sequential ID manager
function createSequentialIdManager() {
    const stableIdToSequentialId = new Map<string, number>()
    let nextSequentialId = 1
    return {
        getSequentialId(stableId: string): number {
            if (!stableIdToSequentialId.has(stableId)) {
                stableIdToSequentialId.set(stableId, nextSequentialId)
                nextSequentialId++
            }
            return stableIdToSequentialId.get(stableId)!
        }
    }
}

// Compare two Maps for equality
function areMapsEqual<K, V>(map1: Map<K, V>, map2: Map<K, V>): boolean {
    if (map1.size !== map2.size) {
        return false
    }
    for (let [key, value] of map1) {
        if (!map2.has(key) || map2.get(key) !== value) {
            return false
        }
    }
    return true
}

// Make utilities available globally in browser context
;(window as any).__speakerUtils = {
    generateStableUserId,
    createSequentialIdManager,
    areMapsEqual
}
