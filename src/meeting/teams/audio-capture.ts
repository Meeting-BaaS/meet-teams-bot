// Web Audio mixing for Microsoft Teams
// Uses shared audio capture module

import { Page } from '@playwright/test'
import { teamsAudioCapture } from '../shared/audio-capture'

/**
 * Enable Web Audio mixing for Teams
 * @param enableMixing - Whether to enable audio mixing for streaming (default: false)
 */
export async function enableTeamsAudioCapture(page: Page, enableMixing?: boolean): Promise<void> {
    return teamsAudioCapture.enable(page, enableMixing)
}

/**
 * Stop the audio capture processor gracefully
 */
export async function stopTeamsAudioCapture(page: Page): Promise<void> {
    return teamsAudioCapture.stop(page)
}

/**
 * Verify that Teams audio capture is working
 */
export async function verifyTeamsAudioCapture(page: Page): Promise<boolean> {
    return teamsAudioCapture.verify(page)
}
