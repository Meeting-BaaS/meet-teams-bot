import * as crypto from 'crypto'

/**
 * Generate a stable user ID from participant name and optional profile picture.
 * This ID persists across rejoin events since it's based on account-level data.
 *
 * @param name - Participant's display name
 * @param profilePicture - Optional profile picture URL (more stable than name)
 * @returns 16-character hex hash
 */
export function generateStableUserId(name: string, profilePicture?: string): string {
    // Prefer profile picture URL (tied to account) over name for stability
    const input = profilePicture || name
    return crypto.createHash('sha256').update(input).digest('hex').substring(0, 16)
}
