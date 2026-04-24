// Audio track layer for Microsoft Teams
// Uses shared audio capture module

import type { Page } from "@playwright/test"
import { teamsAudioCapture } from "../shared/audio-capture"

/**
 * Enable audio track layer for Teams.
 * Audio streaming is handled by FFmpeg PulseAudio capture.
 */
export async function enableTeamsAudioCapture(page: Page): Promise<void> {
  return teamsAudioCapture.enable(page)
}

/**
 * Stop the audio capture gracefully
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
