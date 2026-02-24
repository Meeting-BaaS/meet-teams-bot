import express from "express"
import { envVars } from "./config/env-vars"
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
      if (!data.message || data.message.trim() === "") {
        return res.status(400).json({ error: "Missing required field: message" })
      }

      const meetingHandle = MeetingStateMachine.instance
      if (!meetingHandle) {
        return res.status(404).json({ error: "No active meeting found" })
      }

      const context = meetingHandle.getContext()
      if (!context.playwrightPage) {
        return res.status(500).json({ error: "Meeting page not available" })
      }

      const platform = (await import("./singleton")).GLOBAL.get().meeting_platform

      if (platform === "meet") {
        const { sendChatMessage } = await import("./meeting/meet/network-interception")
        const success = await sendChatMessage(context.playwrightPage, data.message)
        if (success) {
          return res.status(200).json({ success: true, message: "Chat message sent" })
        }
        return res.status(500).json({ error: "Failed to send chat message via network" })
      }

      if (platform === "teams") {
        // Teams: use CKEditor with evaluate() to bypass z-index overlay
        const page = context.playwrightPage
        try {
          const editorSelector = 'div[data-tid="ckeditor"][role="textbox"]'

          // Chat panel should already be open (from TeamsChatObserver).
          // If not, try clicking the chat button first.
          const editorVisible = await page.evaluate((sel) => !!document.querySelector(sel), editorSelector)
          if (!editorVisible) {
            await page.evaluate(() => {
              const chatButton = document.querySelector(
                'button#chat-button[aria-label="Chat"], button[aria-label*="chat" i]'
              ) as HTMLElement | null
              chatButton?.click()
            })
            await page.waitForSelector(editorSelector, { timeout: 3000 })
          }

          // Focus the CKEditor and type (CKEditor ignores programmatic value changes)
          await page.$eval(editorSelector, (el: HTMLElement) => el.focus())
          await page.keyboard.type(data.message)
          await page.waitForTimeout(200)

          // Click send button or fallback to Enter
          const sendClicked = await page.evaluate(() => {
            const sendButton = document.querySelector(
              'button[data-tid="newMessageCommands-send"]'
            ) as HTMLElement | null
            if (sendButton) {
              sendButton.click()
              return true
            }
            return false
          })
          if (!sendClicked) {
            await page.keyboard.press("Enter")
          }

          return res.status(200).json({ success: true, message: "Chat message sent" })
        } catch (error) {
          console.error("Failed to send Teams chat message:", formatError(error))
          return res.status(500).json({ error: "Failed to send chat message via Teams UI" })
        }
      }

      return res.status(400).json({ error: `Unsupported platform: ${platform}` })
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
