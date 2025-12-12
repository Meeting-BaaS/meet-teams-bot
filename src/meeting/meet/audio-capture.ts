// Web Audio mixing for Google Meet
// Uses shared audio capture module

import { Page } from '@playwright/test'
import { meetAudioCapture } from '../shared/audio-capture'

/**
 * Enable centralized audio track layer for Google Meet
 * @param enableMixing - Whether to enable audio mixing for streaming (default: false)
 */
export async function enableMeetAudioCapture(page: Page, enableMixing?: boolean): Promise<void> {
    return meetAudioCapture.enable(page, enableMixing)
}

/**
 * Stop the audio capture processor gracefully
 */
export async function stopMeetAudioCapture(page: Page): Promise<void> {
    return meetAudioCapture.stop(page)
}

/**
 * Verify that audio capture is working
 */
export async function verifyMeetAudioCapture(page: Page): Promise<boolean> {
    return meetAudioCapture.verify(page)
}
