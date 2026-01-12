// Web Audio mixing for Microsoft Teams
// Uses shared audio capture module

import { type Page } from "@playwright/test"
import { teamsAudioCapture } from "../shared/audio-capture"

/**
 * Enable Web Audio mixing for Teams
 * @param enableMixing - If false, only creates __audioTrackLayer (for network diarization)
 *                       If true, also enables audio mixing/streaming
 *                       Note: Teams doesn't use network diarization, so this is always true for teams
 */
export async function enableTeamsAudioCapture(page: Page, enableMixing = true): Promise<void> {
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
