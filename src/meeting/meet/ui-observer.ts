import type { Page } from "@playwright/test"
import { findShowEveryOne } from "../meet"
import { SpeakersObserver } from "../speakersObserver"
import { GLOBAL } from "../../singleton"
import { SpeakerManager } from "../../speaker-manager"
import type { SpeakerData } from "../../types"
import type { MeetingContext } from "../../state-machine/types"
import { formatError } from "../../utils/Logger"

/**
 * Start UI-based speaker observation (shared function for use in multiple states).
 * @param page - Playwright page instance
 * @param context - Meeting context to store the observer
 * @returns The started SpeakersObserver instance
 */
export async function startUIBasedObserver(
  page: Page,
  context: MeetingContext
): Promise<SpeakersObserver> {
  if (!page) {
    throw new Error("Playwright page not available for speakers observation")
  }

  // For Meet, open People panel if needed (UI-based detection requires it)
  if (GLOBAL.get().meeting_platform === "meet" && GLOBAL.get().recording_mode !== "gallery_view") {
    try {
      console.log("[Meet] Opening People panel for UI-based speaker detection...")
      // Create a cancelCheck function that checks for global errors
      const cancelCheck = () => GLOBAL.getEndReason() !== null

      await findShowEveryOne(page, true, cancelCheck)
      console.log("[Meet] ✅ People panel opened for UI-based detection")
    } catch (error) {
      console.warn(
        "[Meet] ⚠️ Failed to open People panel, UI-based detection may not work:",
        formatError(error)
      )
      // Continue anyway - the observer might still work
    }
  }

  // Create and start integrated speakers observer
  const speakersObserver = new SpeakersObserver(GLOBAL.get().meeting_platform)

  // Callback to handle speakers changes
  const onSpeakersChange = async (speakers: SpeakerData[]) => {
    try {
      await SpeakerManager.getInstance().handleSpeakerUpdate(speakers)
    } catch (error) {
      console.error("Error handling speaker update:", formatError(error))
    }
  }

  await speakersObserver.startObserving(
    page,
    GLOBAL.get().recording_mode,
    GLOBAL.get().bot_name,
    onSpeakersChange
  )

  // Store the observer in context for cleanup later
  context.speakersObserver = speakersObserver

  console.log("✅ UI-based speakers observer started successfully")
  return speakersObserver
}
