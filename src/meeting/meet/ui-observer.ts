import type { Page } from "@playwright/test"
import { GLOBAL } from "../../singleton"
import { SpeakerManager } from "../../speaker-manager"
import type { MeetingContext } from "../../state-machine/types"
import type { SpeakerData } from "../../types"
import { formatError } from "../../utils/Logger"
import { findShowEveryOne } from "../meet"
import { SpeakersObserver } from "../speakersObserver"

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

  // If observer is already running, return it instead of creating a new one
  if (context.speakersObserver?.isCurrentlyObserving()) {
    console.log("[UI Observer] Observer already running, reusing existing instance")
    return context.speakersObserver
  }

  // Stop existing observer if any (but not currently observing)
  if (context.speakersObserver) {
    console.warn("[UI Observer] Stopping existing observer before starting new one")
    context.speakersObserver.stopObserving()
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

  // Callback to handle speakers changes. Routed through the bridge arbiter:
  // when this observer runs as the PRIMARY source (network interception failed
  // or was retired) the arbiter passes everything through; when it runs as the
  // early-window bridge alongside a live network path, the arbiter mutes it as
  // soon as the network path reports its first speaker.
  const onSpeakersChange = async (speakers: SpeakerData[]) => {
    try {
      await SpeakerManager.getInstance().handleUiBridgeUpdate(speakers)
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
