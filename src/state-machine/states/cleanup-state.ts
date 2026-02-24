import { SoundContext, VideoContext } from "../../media_context"
import { stopNetworkInterception } from "../../meeting/meet/network-interception"
import { ScreenRecorderManager } from "../../recording/ScreenRecorder"
import { HtmlSnapshotService } from "../../services/html-snapshot-service"
import { GLOBAL } from "../../singleton"
import { SpeakerManager } from "../../speaker-manager"
import { formatError } from "../../utils/Logger"
import { SoundLevelMonitor } from "../../utils/sound-level-monitor"
import { MEETING_CONSTANTS } from "../constants"
import { MeetingStateType, type StateExecuteResult } from "../types"
import { BaseState } from "./base-state"

export class CleanupState extends BaseState {
  async execute(): StateExecuteResult {
    try {
      console.info("🧹 Starting cleanup sequence")

      // Use Promise.race to implement the timeout
      const cleanupPromise = this.performCleanup()
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Cleanup timeout")), MEETING_CONSTANTS.CLEANUP_TIMEOUT)
      })

      try {
        console.info("🧹 Running cleanup with timeout protection")
        await Promise.race([cleanupPromise, timeoutPromise])
        console.info("🧹 Cleanup completed successfully")
      } catch (error) {
        console.error("🧹 Cleanup failed or timed out:", formatError(error))
        // Continue to Terminated even if cleanup fails
      }
      console.info("🧹 Transitioning to Terminated state")
      return this.transition(MeetingStateType.Terminated) // État final
    } catch (error) {
      console.error("🧹 Error during cleanup:", formatError(error))
      // Always transition to Terminated to avoid infinite loops
      console.info("🧹 Forcing transition to Terminated despite error")
      return this.transition(MeetingStateType.Terminated)
    }
  }

  private async performCleanup(): Promise<void> {
    try {
      // 1. Stop the dialog observer
      console.info("🧹 Step 1/8: Stopping dialog observer. It would not block the cleanup")
      try {
        this.stopDialogObserver()
      } catch (error) {
        console.warn("🧹 Dialog observer stop failed, continuing cleanup:", error)
      }

      // 2. Finalize diarization BEFORE stopping ScreenRecorder (which uploads files)
      console.info("🧹 Step 2/8: Finalizing diarization tracking")
      await this.finalizeDiarization()

      // 2b. Stop network interception early to silence the 5s broadcast timer.
      // This is a lightweight page.evaluate() that sets a flag — no need to wait
      // for ScreenRecorder upload to finish before silencing it.
      if (GLOBAL.get().meeting_platform === "meet" && this.context.playwrightPage) {
        try {
          console.info("🧹 Stopping network interception (early, before ScreenRecorder)")
          await stopNetworkInterception(this.context.playwrightPage)
        } catch (error) {
          console.warn("🧹 Early network interception stop failed, will retry later:", formatError(error))
        }
      }

      // 🎬 PRIORITY 3: Stop video recording immediately to avoid data loss
      console.info("🧹 Step 3/8: Stopping ScreenRecorder (PRIORITY)")
      await this.stopScreenRecorder()

      // 4. Capture final DOM state before cleanup
      if (this.context.playwrightPage) {
        console.info("🧹 Step 4/8: Capturing final DOM state")
        const htmlSnapshot = HtmlSnapshotService.getInstance()
        await htmlSnapshot.captureSnapshot(this.context.playwrightPage, "cleanup_final_dom_state")
      }

      // 🚀 PARALLEL CLEANUP: Independent steps that can run simultaneously
      console.info(
        "🧹 Steps 5-9: Running parallel cleanup (streaming + sound monitor + speakers + HTML + network interception)"
      )
      await Promise.allSettled([
        // 5. Stop the streaming (waits for debug audio file finalization)
        (async () => {
          console.info("🧹 Step 5/9: Stopping streaming service")
          if (this.context.streamingService) {
            await this.context.streamingService.stop()
          }
        })(),

        // 6. Stop sound level monitor (critical for automatic leave)
        (async () => {
          console.info("🧹 Step 6/9: Stopping sound level monitor")
          // Use stopIfStarted to avoid instantiating if never used
          SoundLevelMonitor.stopIfStarted()
        })(),

        // 7. Stop speakers observer (with 3s timeout)
        (async () => {
          console.info("🧹 Step 7/9: Stopping speakers observer")
          await this.stopSpeakersObserver()
        })(),

        // 8. Stop HTML cleaner (with 3s timeout)
        (async () => {
          console.info("🧹 Step 8/9: Stopping HTML cleaner")
          await this.stopHtmlCleaner()
        })(),

        // 9. Stop network interception (Meet only)
        (async () => {
          console.info("🧹 Step 9/9: Stopping network interception")
          if (GLOBAL.get().meeting_platform === "meet" && this.context.playwrightPage) {
            try {
              await stopNetworkInterception(this.context.playwrightPage)
            } catch (error) {
              console.error("🧹 Failed to stop network interception:", formatError(error))
              // Don't throw - continue cleanup even if this fails
            }
          }
        })()
      ])

      console.info("🧹 Parallel cleanup completed")

      console.info("🧹 Step 10/10: Cleaning up browser resources")
      // 10. Clean up browser resources (must be sequential after others)
      await this.cleanupBrowserResources()

      console.info("🧹 All cleanup steps completed")
    } catch (error) {
      console.error("🧹 Cleanup error:", formatError(error))
      // Continue even if an error occurs
      // Don't re-throw - errors are already handled
      return
    }
  }

  private async stopSpeakersObserver(): Promise<void> {
    try {
      if (this.context.speakersObserver) {
        console.log("Stopping speakers observer from cleanup state...")

        // Add 3-second timeout to prevent hanging
        await Promise.race([
          (async () => {
            this.context.speakersObserver.stopObserving()
            this.context.speakersObserver = null
          })(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Speakers observer stop timeout")), 3000)
          )
        ])

        console.log("Speakers observer stopped successfully")
      } else {
        console.log("Speakers observer not active, nothing to stop")
      }
    } catch (error) {
      if (error instanceof Error && error.message?.includes("timeout")) {
        console.warn("Speakers observer stop timed out after 3s, continuing cleanup")
        // Force cleanup
        this.context.speakersObserver = null
      } else {
        console.error("Error stopping speakers observer:", formatError(error))
      }
      // Don't throw as this is non-critical
    }
  }

  private async stopHtmlCleaner(): Promise<void> {
    try {
      if (this.context.htmlCleaner) {
        console.log("Stopping HTML cleaner from cleanup state...")

        // Add 3-second timeout to prevent hanging
        await Promise.race([
          this.context.htmlCleaner.stop(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("HTML cleaner stop timeout")), 3000)
          )
        ])

        this.context.htmlCleaner = undefined
        console.log("HTML cleaner stopped successfully")
      } else {
        console.log("HTML cleaner not active, nothing to stop")
      }
    } catch (error) {
      if (error instanceof Error && error.message?.includes("timeout")) {
        console.warn("HTML cleaner stop timed out after 3s, continuing cleanup")
        // Force cleanup
        this.context.htmlCleaner = undefined
      } else {
        console.error("Error stopping HTML cleaner:", formatError(error))
      }
      // Don't throw as this is non-critical
    }
  }

  private async finalizeDiarization(): Promise<void> {
    try {
      await SpeakerManager.finalize()
      console.log("Diarization tracking finalized successfully")
    } catch (error) {
      console.error("Failed to finalize diarization:", formatError(error))
      // Don't throw - continue cleanup even if diarization finalization fails
    }
  }

  private async stopScreenRecorder(): Promise<void> {
    try {
      if (ScreenRecorderManager.getInstance().isCurrentlyRecording()) {
        console.log("Stopping ScreenRecorder from cleanup state...")
        await ScreenRecorderManager.getInstance().stopRecording()
        console.log("ScreenRecorder stopped successfully")
      } else {
        console.log("ScreenRecorder not recording, nothing to stop")
      }
    } catch (error) {
      console.error("Error stopping ScreenRecorder:", formatError(error))

      // Don't re-throw - errors are already handled

      // Don't throw error if recording was already stopped
      if (error instanceof Error && error.message && error.message.includes("not recording")) {
        console.log("ScreenRecorder was already stopped, continuing cleanup")
      } else {
        throw error
      }
    }
  }
  private async cleanupBrowserResources(): Promise<void> {
    try {
      // 1. Stop branding
      if (this.context.brandingProcess) {
        this.context.brandingProcess.kill()
      }

      // 2. Stop media contexts
      VideoContext.instance?.stop()
      SoundContext.instance?.stop()

      // 3. Close pages and clean the browser
      await Promise.all([
        this.context.playwrightPage?.close().catch(() => {}),
        this.context.browserContext?.close().catch(() => {})
      ])
    } catch (error) {
      console.error("Failed to cleanup browser resources:", formatError(error))
    }
  }

  private stopDialogObserver() {
    if (this.context.dialogObserver) {
      console.info(`Stopping global dialog observer in state ${this.constructor.name}`)
      this.context.dialogObserver.stopGlobalDialogObserver()
    } else {
      console.warn(`Global dialog observer not available in state ${this.constructor.name}`)
    }
  }
}
