import * as fs from "node:fs"
import { Api } from "../../api/methods"
import { ChatManager } from "../../chat-manager"
import { envVars } from "../../config/env-vars"
import { SoundContext, VideoContext } from "../../media_context"
import { stopToggleProxy } from "../../proxy/toggle-proxy"
import { ScreenRecorderManager } from "../../recording/ScreenRecorder"
import { HtmlSnapshotService } from "../../services/html-snapshot-service"
import { GLOBAL } from "../../singleton"
import { SpeakerManager } from "../../speaker-manager"
import { formatError } from "../../utils/Logger"
import { PathManager } from "../../utils/PathManager"
import { S3Uploader } from "../../utils/S3Uploader"
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
        // Timeout or cleanup failure — mirror whatever the pipeline built
        // locally to EFS so a later reconciliation job can push it to S3.
        // Without this, hung uploads that outlast the outer timeout take
        // output.mp4 / output.flac down with the pod's scratch disk.
        await this.mirrorRecordingsToEFS()
        // Continue to Terminated even if cleanup fails
      }
      this.reportMetrics()

      console.info("🧹 Transitioning to Terminated state")
      return this.transition(MeetingStateType.Terminated)
    } catch (error) {
      console.error("🧹 Error during cleanup:", formatError(error))
      // Always transition to Terminated to avoid infinite loops
      console.info("🧹 Forcing transition to Terminated despite error")
      return this.transition(MeetingStateType.Terminated)
    }
  }

  private async performCleanup(): Promise<void> {
    try {
      // Close any open pause window (meeting ended while paused)
      if (this.context.currentPauseStart !== null) {
        this.context.pauseWindows.push({
          start: this.context.currentPauseStart,
          end: null
        })
        console.log(
          `[Cleanup] Closing open-ended pause window from ${this.context.currentPauseStart} (meeting ended while paused)`
        )
        this.context.currentPauseStart = null
      }

      // Step 0a: Stop toggle proxy (no longer needed after meeting)
      try {
        await stopToggleProxy()
      } catch (error) {
        console.warn("🧹 Toggle proxy stop failed, continuing cleanup:", error)
      }

      // Step 0b: Stop dialog observer (runs in Node, not in the page)
      console.info("🧹 Step 0: Stopping dialog observer")
      try {
        this.stopDialogObserver()
      } catch (error) {
        console.warn("🧹 Dialog observer stop failed, continuing cleanup:", error)
      }

      // Step 1: Finalize diarization BEFORE stopping ScreenRecorder (which uploads files)
      console.info("🧹 Step 1/6: Finalizing diarization tracking")
      await this.finalizeDiarization()

      // Step 2: Capture final DOM state while page is still alive
      if (this.context.playwrightPage) {
        console.info("🧹 Step 2/6: Capturing final DOM state")
        const htmlSnapshot = HtmlSnapshotService.getInstance()
        await htmlSnapshot.captureSnapshot(this.context.playwrightPage, "cleanup_final_dom_state")
      }

      // Step 3: Close meeting page — bot leaves the meeting instantly.
      // All injected JS (speakers observer, HTML cleaner, chat observer, network interception)
      // dies with the page. No need to stop them separately with timeout wrappers.
      // FFmpeg keeps recording the now-blank Xvfb display until we stop it.
      console.info("🧹 Step 3/6: Closing meeting page (bot leaves meeting)")
      try {
        await this.context.playwrightPage?.close().catch(() => {})
        this.context.playwrightPage = null
      } catch (error) {
        console.warn("🧹 Failed to close meeting page:", formatError(error))
        this.context.playwrightPage = null
      }

      // Step 4: Stop Node-side services (streaming + sound monitor) + upload chat messages
      console.info("🧹 Step 4/6: Stopping Node services and uploading chat messages")
      await Promise.allSettled([
        (async () => {
          if (this.context.streamingService) {
            await this.context.streamingService.stop()
          }
        })(),
        (async () => {
          SoundLevelMonitor.stopIfStarted()
        })(),
        (async () => {
          await this.uploadChatMessagesArtifact()
        })()
      ])

      // Step 5: Stop ScreenRecorder (SIGINT FFmpeg → grace period → file processing)
      console.info("🧹 Step 5/6: Stopping ScreenRecorder")
      await this.stopScreenRecorder()

      // Step 6: Close browser context and remaining resources
      console.info("🧹 Step 6/6: Cleaning up browser resources")
      await this.cleanupBrowserResources()

      console.info("🧹 All cleanup steps completed")
    } catch (error) {
      console.error("🧹 Cleanup error:", formatError(error))
      // Continue even if an error occurs
      return
    }
  }

  private async mirrorRecordingsToEFS(): Promise<void> {
    try {
      const uploader = S3Uploader.getInstance()
      if (!uploader) return // serverless or not configured
      const basePath = PathManager.getInstance().getBasePath()
      await uploader.copyDirToEFS(basePath)
    } catch (error) {
      // copyDirToEFS already swallows its own errors, but guard anyway
      console.error("🧹 EFS mirror after cleanup timeout failed:", formatError(error))
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

  private async uploadChatMessagesArtifact(): Promise<void> {
    try {
      const chatManager = ChatManager.getInstance()
      const chatMessages = chatManager.getChatMessages()
      if (chatMessages.length === 0) {
        console.log("No chat messages to upload")
        return
      }

      const filePath = chatManager.getChatMessagesPath()
      if (!fs.existsSync(filePath)) {
        console.warn("Chat messages file not found at:", filePath)
        return
      }

      const botUuid = GLOBAL.get().bot_uuid
      const s3Key = `${botUuid}/chat_messages.json`
      const bucket = envVars.AWS_S3_ARTIFACTS_BUCKET

      console.log(`Uploading ${chatMessages.length} chat messages to S3: ${s3Key}`)

      const uploader = S3Uploader.getInstance()
      if (uploader) {
        await uploader.uploadFile(filePath, bucket, s3Key)
        GLOBAL.addArtifactKey({
          s3Key,
          filePath,
          extension: "json",
          uploaded: true,
          uploadedAt: new Date().toISOString(),
          type: "chat_messages",
          errorCode: null,
          errorMessage: null
        })
        console.log("Chat messages artifact uploaded successfully")
      }
    } catch (error) {
      console.error("Failed to upload chat messages artifact:", formatError(error))
      // Don't throw — continue cleanup
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

      // Don't throw error if recording was already stopped
      if (error instanceof Error && error.message && error.message.includes("not recording")) {
        console.log("ScreenRecorder was already stopped, continuing cleanup")
      } else {
        throw error
      }
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

  private reportMetrics(): void {
    try {
      const collector = GLOBAL.getMetricsCollector()
      if (!collector.isRunning()) return

      collector.stop()
      const payload = collector.getPayload()
      if (Api.instance) {
        Api.instance.reportMetrics(payload)
      }
    } catch (error) {
      console.warn("Failed to report bot metrics (continuing):", error)
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

      // 3. Close browser context (page already closed in step 4)
      await this.context.browserContext?.close().catch(() => {})
    } catch (error) {
      console.error("Failed to cleanup browser resources:", formatError(error))
    }
  }
}
