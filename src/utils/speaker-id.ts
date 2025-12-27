/**
 * Generate a stable user ID from participant name and optional profile picture.
 * This ID persists across rejoin events since it's based on account-level data.
 * Works in both Node.js and browser contexts without requiring crypto libraries.
 *
 * Uses a simple 32-bit djb2-style hash algorithm. Not cryptographically secure,
 * but sufficient for speaker identification (collision probability is low for
 * typical meeting sizes of <100 participants).
 *
 * @param name - Participant's display name
 * @param profilePicture - Optional profile picture URL (more stable than name)
 * @returns 8-character hex hash (32-bit)
 */
export function generateStableUserId(name: string, profilePicture?: string): string {
    const input = profilePicture || name
    let hash = 0
    // Simple 32-bit djb2-style hash
    for (let i = 0; i < input.length; i++) {
        const char = input.charCodeAt(i)
        hash = ((hash << 5) - hash) + char
        hash = hash & hash // Keep as 32-bit integer
    }
    // Return 8 hex chars (32-bit hash)
    return Math.abs(hash).toString(16).padStart(8, '0')
}

/**
 * Creates sequential ID management functions for browser contexts.
 * Returns utilities to map stable hash IDs to sequential numeric IDs.
 * This ensures speakers keep the same numeric ID across rejoins.
 */
export function createSequentialIdManager() {
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
