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

      if (context.chatDisabled) {
        return res.status(400).json({ error: "Chat is disabled for this meeting" })
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
        // Teams: open chat panel and type into chat input
        const page = context.playwrightPage
        try {
          // Multiple selectors for the chat input — Teams UI varies across versions
          const inputSelectors = [
            '[aria-label="Type a message"]',
            '[placeholder="Type a message"]',
            'div[data-tid="ckeditor"][role="textbox"]',
          ]

          // Check if any chat input is already visible
          const inputFound = await page.evaluate((selectors) => {
            for (const sel of selectors) {
              if (document.querySelector(sel)) return sel
            }
            return null
          }, inputSelectors)

          console.log(`[Teams Chat Send] Input found: ${inputFound || "none"}`)

          if (!inputFound) {
            // Open chat panel first
            console.log("[Teams Chat Send] Opening chat panel...")
            await page.evaluate(() => {
              const btn = document.querySelector('button#chat-button') as HTMLElement | null
              if (btn) { btn.click(); return true }
              return false
            })
            // Wait for any of the input selectors to appear
            await page.waitForSelector(inputSelectors.join(", "), { timeout: 5000 })
          }

          // Find which selector matches
          const activeSelector = inputFound || await page.evaluate((selectors) => {
            for (const sel of selectors) {
              if (document.querySelector(sel)) return sel
            }
            return null
          }, inputSelectors)

          if (!activeSelector) {
            return res.status(500).json({ error: "Chat input not found" })
          }

          // Use CKEditor 5 internal API to insert text, then click the send button.
          // All Playwright keyboard/focus approaches fail because the chat input
          // is behind a z-index 900000 overlay and outside the viewport.
          const sendResult = await page.evaluate(({ selector, message }) => {
            const el = document.querySelector(selector) as any
            if (!el) return { sent: false, reason: "element not found" }

            const editor = el.ckeditorInstance
            if (!editor) return { sent: false, reason: "no ckeditorInstance on element" }

            // Insert text via CKEditor model API
            editor.model.change((writer: any) => {
              const root = editor.model.document.getRoot()
              writer.remove(writer.createRangeIn(root))
              writer.insertText(message, root, 0)
            })

            // Try clicking the send button (Teams enables it when there's text)
            const sendBtn = document.querySelector(
              'button[data-tid="sendMessageCommands-send"]'
            ) as HTMLButtonElement | null

            if (sendBtn && !sendBtn.disabled) {
              sendBtn.click()
              return { sent: true, method: "send-button" }
            }

            // Fallback: dispatch Ctrl+Enter on the editor element (Teams send shortcut)
            el.dispatchEvent(new KeyboardEvent("keydown", {
              key: "Enter", code: "Enter", keyCode: 13, which: 13,
              ctrlKey: true, bubbles: true, cancelable: true
            }))

            return { sent: true, method: sendBtn ? "ctrl-enter (button disabled)" : "ctrl-enter (no button)" }
          }, { selector: activeSelector, message: data.message })

          console.log("[Teams Chat Send] CKEditor API result:", JSON.stringify(sendResult))

          if (!sendResult.sent) {
            console.error(`[Teams Chat Send] Failed: ${sendResult.reason}`)
            return res.status(500).json({ error: sendResult.reason })
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
