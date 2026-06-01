import express from "express"
import { switchToPausedBranding, switchToRecordingBranding } from "./branding"
import { ChatManager } from "./chat-manager"
import { envVars } from "./config/env-vars"
import { Events } from "./events"
import { GLOBAL } from "./singleton"
import { MeetingStateMachine } from "./state-machine/machine"
import { MeetingEndReason, MeetingStateType } from "./state-machine/types"
import type { SendChatMessageParams, StopRecordParams } from "./types"
import { formatError } from "./utils/Logger"

const HOST = envVars.HOST

const MAX_MESSAGE_LENGTH = 4096

function graphemeCount(val: string): number {
  let count = 0
  for (const _ of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(val)) {
    count++
  }
  return count
}

const PORT = envVars.PORT

async function getAllowedOrigins(): Promise<string[]> {
  return [envVars.API_SERVER_BASEURL]
}

export async function server() {
  const app = express()
  const allowedOrigins = await getAllowedOrigins()

  app.use(express.urlencoded({ extended: true }))
  app.use(express.raw({ type: "application/octet-stream", limit: "1000mb" }))
  app.use(express.json({ limit: "1000mb" })) // To parse the incoming requests with JSON payloads
  app.use(express.urlencoded({ limit: "1000mb" }))

  app.use((req, res, next) => {
    const origin = req.headers.origin
    if (allowedOrigins.includes(origin)) {
      res.header("Access-Control-Allow-Origin", origin)
    }
    res.header("Access-Control-Allow-Credentials", "true")
    res.header("Access-Control-Allow-Methods", "OPTIONS, GET, PUT, POST, DELETE")
    res.header("Access-Control-Allow-Headers", "Authorization2, Content-Type")

    next()
  })

  app.options("{*path}", (_req, res) => {
    const origin = _req.headers.origin
    if (allowedOrigins.includes(origin)) {
      res.header("Access-Control-Allow-Origin", origin)
    }
    res.header("Access-Control-Allow-Credentials", "true")
    res.header("Access-Control-Allow-Methods", "OPTIONS, GET, PUT, POST, DELETE")
    res.header("Access-Control-Allow-Headers", "Authorization2, Content-Type")
    res.sendStatus(204)
  })

  // Leave bot request from api server
  app.post("/stop_record", async (req, res) => {
    const data: StopRecordParams = req.body
    console.log("end meeting from api server :", data)

    return stop_record(res, MeetingEndReason.ApiRequest)
  })

  async function stop_record(res: express.Response, reason: MeetingEndReason) {
    try {
      const meetingHandle = MeetingStateMachine.instance

      if (!meetingHandle) {
        return res.status(404).json({
          error: "No active meeting found"
        })
      }

      // Appeler la méthode d'arrêt
      await meetingHandle.stopMeeting(reason)

      return res.status(200).json({
        success: true,
        message: "Meeting stopped successfully"
      })
    } catch (error) {
      console.error("Failed to stop meeting:", formatError(error))
      return res.status(500).json({
        error: "Failed to stop meeting",
        details: error instanceof Error ? error.message : "Unknown error"
      })
    }
  }

  // Serialization lock for pause/resume to prevent overlapping commands
  let pauseResumeLock: Promise<void> = Promise.resolve()

  function withPauseResumeLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = pauseResumeLock
    let resolve: () => void
    pauseResumeLock = new Promise<void>((r) => {
      resolve = r
    })
    return prev.then(fn).finally(() => resolve!())
  }

  // Pause recording
  app.post("/pause_record", async (req, res) => {
    return withPauseResumeLock(async () => {
      try {
        const meetingHandle = MeetingStateMachine.instance
        if (!meetingHandle) {
          return res.status(404).json({ error: "No active meeting found" })
        }

        if (meetingHandle.getCurrentState() !== MeetingStateType.Recording) {
          return res.status(409).json({ error: "Bot is not in recording state" })
        }

        const context = meetingHandle.getContext()
        if (context.currentPauseStart !== null) {
          return res.status(409).json({ error: "Recording is already paused" })
        }

        // Record pause start timestamp
        context.currentPauseStart = Date.now()
        console.log(`[Server] Recording paused at ${context.currentPauseStart}`)

        // Send status webhook
        Events.recordingPaused()

        // Switch branding to paused image (index 2) if bot_status mode
        if (GLOBAL.get().bot_image_config?.loop_mode === "bot_status") {
          switchToPausedBranding()
        }

        // Pause streaming if active
        if (context.streamingService) {
          context.streamingService.pause()
        }

        // Send chat message if provided in the request
        const chatMessage: string | undefined = req.body?.chat_message
        if (chatMessage && context.playwrightPage) {
          ChatManager.getInstance()
            .sendBotMessage(
              context.playwrightPage,
              GLOBAL.get().meeting_platform,
              chatMessage,
              context.chatObserver
            )
            .catch((err: unknown) =>
              console.error("[Server] Failed to send pause chat message:", formatError(err as Error))
            )
        }

        return res.status(200).json({ success: true, message: "Recording paused" })
      } catch (error) {
        console.error("Failed to pause recording:", formatError(error))
        return res.status(500).json({
          error: "Failed to pause recording",
          details: error instanceof Error ? error.message : "Unknown error"
        })
      }
    })
  })

  // Resume recording
  app.post("/resume_record", async (req, res) => {
    return withPauseResumeLock(async () => {
      try {
        const meetingHandle = MeetingStateMachine.instance
        if (!meetingHandle) {
          return res.status(404).json({ error: "No active meeting found" })
        }

        if (meetingHandle.getCurrentState() !== MeetingStateType.Recording) {
          return res.status(409).json({ error: "Bot is not in recording state" })
        }

        const context = meetingHandle.getContext()
        if (context.currentPauseStart === null) {
          return res.status(409).json({ error: "Recording is not paused" })
        }

        // Close pause window. Capture the end timestamp once so the value
        // persisted into pauseWindows exactly matches the one in the log line.
        const pauseEnd = Date.now()
        context.pauseWindows.push({
          start: context.currentPauseStart,
          end: pauseEnd
        })
        console.log(
          `[Server] Recording resumed. Pause window: ${context.currentPauseStart} - ${pauseEnd}`
        )
        context.currentPauseStart = null

        // Send status webhook
        Events.recordingResumed()

        // Switch branding back to recording image (index 1) if bot_status mode
        if (GLOBAL.get().bot_image_config?.loop_mode === "bot_status") {
          switchToRecordingBranding()
        }

        // Resume streaming if active
        if (context.streamingService) {
          context.streamingService.resume()
        }

        // Send chat message if provided
        // Send chat message if provided in the request
        const chatMessage: string | undefined = req.body?.chat_message
        if (chatMessage && context.playwrightPage) {
          ChatManager.getInstance()
            .sendBotMessage(
              context.playwrightPage,
              GLOBAL.get().meeting_platform,
              chatMessage,
              context.chatObserver
            )
            .catch((err: unknown) =>
              console.error(
                "[Server] Failed to send resume chat message:",
                formatError(err as Error)
              )
            )
        }

        return res.status(200).json({ success: true, message: "Recording resumed" })
      } catch (error) {
        console.error("Failed to resume recording:", formatError(error))
        return res.status(500).json({
          error: "Failed to resume recording",
          details: error instanceof Error ? error.message : "Unknown error"
        })
      }
    })
  })

  // Send chat message to meeting
  app.post("/send_chat_message", async (req, res) => {
    try {
      const data: SendChatMessageParams = req.body
      console.log("[Server] Incoming /send_chat_message request")

      if (!data.message || data.message.trim() === "") {
        return res.status(400).json({ error: "Missing required field: message" })
      }

      if (graphemeCount(data.message) > MAX_MESSAGE_LENGTH) {
        return res.status(400).json({ error: `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters` })
      }

      const meetingHandle = MeetingStateMachine.instance
      if (!meetingHandle) {
        return res.status(404).json({ error: "No active meeting found" })
      }

      const context = meetingHandle.getContext()
      if (!context.playwrightPage) {
        return res.status(500).json({ error: "Meeting page not available" })
      }

      const result = await ChatManager.getInstance().sendBotMessage(
        context.playwrightPage,
        GLOBAL.get().meeting_platform,
        data.message,
        context.chatObserver,
      )

      console.log("[Server] Chat message result:", JSON.stringify(result))

      if (result.success === false) {
        return res.status(result.status).json({ error: result.error })
      }
      return res.status(200).json({ success: true, message: "Chat message sent" })
    } catch (error) {
      console.error("Failed to send chat message:", formatError(error))
      return res.status(500).json({
        error: "Failed to send chat message",
        details: error instanceof Error ? error.message : "Unknown error"
      })
    }
  })

  // Get Recording Server Build Version Info
  app.get("/version", async (_req, res) => {
    console.log("version requested")
    await import("./buildInfo.json")
      .then((buildInfo) => {
        res.status(200).json(buildInfo)
      })
      .catch((_error) => {
        res.status(404).json({
          error: "None build has been done"
        })
      })
  })

  try {
    app.listen(PORT, HOST)
    console.log(`Running on http://${HOST}:${PORT}`)
  } catch (e) {
    console.error(`Failed to register instance: ${e}`)
  }
}
