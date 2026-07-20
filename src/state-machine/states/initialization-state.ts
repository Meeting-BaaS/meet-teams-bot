import fs from "node:fs"
import path from "node:path"
import {
  deferBrandingPlayback,
  generateBranding,
  playBranding,
  startBrandingAutoLoop,
  warmUpCamera
} from "../../branding"
import { establishBrowserSession } from "../../browser/browser-session"
import { GLOBAL } from "../../singleton"
import { formatError } from "../../utils/Logger"
import { PathManager } from "../../utils/PathManager"
import { MeetingEndReason, MeetingStateType, type StateExecuteResult } from "../types"
import { BaseState } from "./base-state"

export class InitializationState extends BaseState {
  async execute(): StateExecuteResult {
    try {
      // Validate parameters
      if (!GLOBAL.get().meeting_url) {
        GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
        throw new Error("Invalid meeting URL")
      }

      // Setup path manager first (important for logs)
      await this.setupPathManager()

      // Setup branding if needed - non-bloquant
      if (GLOBAL.get().bot_image) {
        if (GLOBAL.get().bot_image.includes("|")) {
          // Multi-image: warm up camera immediately, defer playback until
          // the bot is in the waiting room (avoids switch gaps during join flow)
          warmUpCamera()
          deferBrandingPlayback()
        }

        this.setupBranding(GLOBAL.get().bot_image).catch((error) => {
          console.warn("Branding setup failed, continuing anyway:", error)
        })
      }

      // Setup browser - étape critique
      try {
        await this.setupBrowser()
      } catch (error) {
        console.error("Critical error: Browser setup failed:", formatError(error))
        // Ajouter des détails à l'erreur pour faciliter le diagnostic
        const enhancedError = new Error(
          `Browser initialization failed: ${error instanceof Error ? error.message : String(error)}`
        )
        enhancedError.stack = error instanceof Error ? error.stack : undefined
        throw enhancedError
      }
      // All initialization successful
      return this.transition(MeetingStateType.WaitingRoom)
    } catch (error) {
      return this.handleError(error as Error)
    }
  }

  private async setupBranding(botImage: string): Promise<void> {
    this.context.brandingProcess = generateBranding(botImage)
    await this.context.brandingProcess.wait
    playBranding()

    const config = GLOBAL.get().bot_image_config
    const loopMode = config?.loop_mode ?? "auto"
    if (loopMode === "auto") {
      startBrandingAutoLoop(config?.image_duration ?? 30)
    }
  }

  private async setupBrowser(): Promise<void> {
    // Proxy start + browser launch (with retries) live in the shared
    // browser-session helper so the in-process fast-retry uses the same path.
    await establishBrowserSession(this.context)
  }

  private async setupPathManager(): Promise<void> {
    try {
      if (!this.context.pathManager) {
        this.context.pathManager = PathManager.getInstance()
      }
    } catch (error) {
      console.error("Path manager setup failed:", formatError(error))
      // Create base directories if possible
      try {
        const baseDir = path.join(process.cwd(), "logs", GLOBAL.get().bot_uuid)
        fs.mkdirSync(baseDir, { recursive: true })
        console.info("Created fallback log directory:", baseDir)
      } catch (fsError) {
        console.error("Failed to create fallback log directory:", formatError(fsError))
      }
      throw error
    }
  }
}
