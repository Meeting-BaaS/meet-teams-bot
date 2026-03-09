// Audio track layer for Google Meet
// Uses shared audio capture module

import type { Page } from "@playwright/test"
import { meetAudioCapture } from "../shared/audio-capture"

/**
 * Enable audio track layer for Google Meet (for network diarization).
 * Audio streaming is handled by FFmpeg PulseAudio capture.
 */
export async function enableMeetAudioCapture(page: Page): Promise<void> {
  return meetAudioCapture.enable(page)
}

/**
 * Stop the audio capture gracefully
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
