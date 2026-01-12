// Web Audio mixing for Google Meet
// Uses shared audio capture module

import { type Page } from "@playwright/test"
import { meetAudioCapture } from "../shared/audio-capture"

/**
 * Enable Web Audio mixing for Google Meet
 * @param enableMixing - If false, only creates __audioTrackLayer (for network diarization)
 *                       If true, also enables audio mixing/streaming
 */
export async function enableMeetAudioCapture(page: Page, enableMixing = true): Promise<void> {
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
