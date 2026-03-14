import express from "express"
import { ChatManager } from "./chat-manager"
import { envVars } from "./config/env-vars"
import { GLOBAL } from "./singleton"
import { MeetingStateMachine } from "./state-machine/machine"
import { MeetingEndReason } from "./state-machine/types"
import type { SendChatMessageParams, StopRecordParams } from "./types"
import { formatError } from "./utils/Logger"

const HOST = envVars.HOST
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

  app.options("*", (_req, res) => {
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

  // Send chat message to meeting
  app.post("/send_chat_message", async (req, res) => {
    try {
      const data: SendChatMessageParams = req.body
      console.log("[Server] Incoming /send_chat_message request:", JSON.stringify({ message: data.message?.substring(0, 100) }))

      if (!data.message || data.message.trim() === "") {
        return res.status(400).json({ error: "Missing required field: message" })
      }

      if (data.message.length > 500) {
        return res.status(400).json({ error: "Message exceeds maximum length of 500 characters" })
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
