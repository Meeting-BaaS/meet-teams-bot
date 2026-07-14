import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import type { Page } from "@playwright/test"
import axios from "./api/axios-instance"
import { envVars } from "./config/env-vars"
import type { ChatObserver } from "./meeting/chatObserver"
import { GLOBAL } from "./singleton"
import type { ChatMessageData, MeetingProvider } from "./types"
import { formatError } from "./utils/Logger"
import { PathManager } from "./utils/PathManager"

export type SendBotMessageResult =
  | { success: true }
  | { success: false; error: string; status: number }

// Minimal CKEditor 5 type shapes for Teams chat sending
type CKElement = Record<string, unknown>
interface CKWriter {
  createRangeIn(root: CKElement): unknown
  remove(range: unknown): void
  insertText(text: string, root: CKElement, offset: number): void
}
interface CKEditor {
  model: {
    change(callback: (writer: CKWriter) => void): void
    document: { getRoot(): CKElement }
  }
}

export class ChatManager {
  private static instance: ChatManager | null = null
  private seenMessageIds: Set<string> = new Set()
  /** contentKey (`${sender}|${text}`) -> last-seen epoch ms, for the debounce window below. */
  private recentContentKeys: Map<string, number> = new Map()
  private chatMessages: ChatMessageData[] = []

  /**
   * Debounce window for identical (sender, text) messages. Absorbs near-instant duplicate
   * deliveries (Teams chatServiceBatchEvent re-delivery, Meet messages seen before the
   * sender's userId is assigned) and the bot's own echo, without permanently suppressing a
   * participant who legitimately repeats the same text (e.g. sending "pause" twice).
   */
  private static readonly CONTENT_DEDUP_WINDOW_MS = 2000

  static getInstance(): ChatManager {
    if (!ChatManager.instance) {
      ChatManager.instance = new ChatManager()
    }
    return ChatManager.instance
  }

  static start(): void {
    ChatManager.getInstance()
  }

  /**
   * Add a message ID to the seen set (used to prevent echo of bot-sent messages).
   */
  addSeenMessageId(messageId: string): void {
    this.seenMessageIds.add(messageId)
  }

  addChatMessage(msg: ChatMessageData): void {
    this.chatMessages.push(msg)
    this.writeToDisk()
  }

  getChatMessages(): ChatMessageData[] {
    return this.chatMessages
  }

  getChatMessagesPath(): string {
    try {
      return path.join(PathManager.getInstance().getBasePath(), "chat_messages.json")
    } catch {
      return path.join("/tmp", GLOBAL.get().bot_uuid, "chat_messages.json")
    }
  }

  /**
   * Send a message as the bot into the meeting chat.
   * Handles platform-specific sending, persistence, and dedup.
   */
  async sendBotMessage(
    page: Page,
    platform: MeetingProvider,
    message: string,
    chatObserver?: ChatObserver | null,
  ): Promise<SendBotMessageResult> {
    if (chatObserver?.isChatDisabled()) {
      return { success: false, error: "Chat is disabled for this meeting", status: 400 }
    }

    if (platform === "meet") {
      return this.sendViaMeet(page, message)
    }

    if (platform === "teams") {
      return this.sendViaTeams(page, message)
    }

    if (platform === "zoom") {
      return this.sendViaZoom(page, message)
    }

    return { success: false, error: `Unsupported platform: ${platform}`, status: 400 }
  }

  async handleChatMessage(message: ChatMessageData): Promise<void> {
    // Deduplicate by message_id
    if (this.seenMessageIds.has(message.message_id)) {
      console.log(`[ChatManager] Dedup by message_id: ${message.message_id}`)
      return
    }
    this.seenMessageIds.add(message.message_id)

    // Debounce identical (sender, text) within a short window. message_id already catches
    // exact re-deliveries; this additionally absorbs duplicates that arrive with a *different*
    // id (Teams batch re-delivery, Meet pre-userId-assignment, the bot's own echo) while still
    // letting a participant legitimately repeat the same text later (e.g. "pause" twice).
    const contentKey = `${message.sender_name}|${message.text}`
    const now = Date.now()
    const lastSeen = this.recentContentKeys.get(contentKey)
    if (lastSeen !== undefined && now - lastSeen < ChatManager.CONTENT_DEDUP_WINDOW_MS) {
      console.log(
        `[ChatManager] Debounced duplicate within ${ChatManager.CONTENT_DEDUP_WINDOW_MS}ms (message_id=${message.message_id})`
      )
      return
    }
    this.recentContentKeys.set(contentKey, now)

    // Resolve sender_id via _device_id lookup (Meet only)
    if (message._device_id && message.sender_id === null) {
      const participant = GLOBAL.getParticipants().find(
        (p) => p.participantId === message._device_id
      )
      if (participant?.id != null) {
        message.sender_id = participant.id
      }
    }

    // Persist to disk
    this.addChatMessage(message)

    // Send to API server via dedicated chat-message route (fire-and-forget)
    this.sendChatMessageToApi(message)
  }

  private persistBotSentMessage(text: string): void {
    const messageId = randomUUID()
    const botName = GLOBAL.get().bot_name
    // Look up bot's own participant ID for sender_id
    const botParticipant = GLOBAL.getParticipants().find((p) => p.name === botName)
    this.addChatMessage({
      text,
      sender_name: botName,
      sender_id: botParticipant?.id ?? null,
      timestamp: new Date().toISOString(),
      message_id: messageId,
    })
    // Seed dedup state so if the platform echoes the bot's own message back, we don't
    // re-emit it: the random message_id covers same-id echoes, and the content key (with
    // a fresh timestamp) covers an echo that arrives with a different id within the window.
    this.addSeenMessageId(messageId)
    this.recentContentKeys.set(`${botName}|${text}`, Date.now())
  }

  private async sendViaMeet(page: Page, message: string): Promise<SendBotMessageResult> {
    try {
      const { sendChatMessage } = await import("./meeting/meet/network-interception")
      const success = await sendChatMessage(page, message)
      if (success) {
        this.persistBotSentMessage(message)
        return { success: true }
      }
      return { success: false, error: "Failed to send chat message via network", status: 500 }
    } catch (error) {
      console.error("[ChatManager] Meet send failed:", formatError(error))
      return { success: false, error: "Failed to send chat message via Meet", status: 500 }
    }
  }

  private async sendViaZoom(page: Page, message: string): Promise<SendBotMessageResult> {
    try {
      // Zoom mounts the chat INPUT only while the panel is open (the message
      // LIST can already be in the DOM, which is why "list found but input
      // missing" is the normal closed-panel state — don't read that as chat
      // being disabled).
      // Zoom's chat composer is a TipTap/ProseMirror contenteditable (confirmed
      // live: `div.tiptap.ProseMirror.ProseMirror-focused`), NOT a textarea.
      // The legacy textarea selectors are kept as fallbacks for older builds.
      const inputSelectors = [
        'div.ProseMirror[contenteditable="true"]',
        'div.tiptap[contenteditable="true"]',
        'div.chat-rtf-box__editor[contenteditable="true"]',
        "textarea.chat-box__chat-textarea",
        'textarea[aria-label*="chat" i]',
        'div[contenteditable="true"][aria-label*="chat" i]',
        'textarea[placeholder*="message" i]'
      ]
      // Visibility via getClientRects(), NOT offsetParent: offsetParent is null
      // for position:fixed elements, and Zoom's chat panel is fixed — so an
      // offsetParent check rejects the very editor we're looking for.
      const findInput = async () =>
        page.evaluate((sels) => {
          for (const s of sels) {
            const el = document.querySelector(s) as HTMLElement | null
            if (el && el.getClientRects().length > 0) return s
          }
          return null
        }, inputSelectors)

      let activeSelector = await findInput()
      if (!activeSelector) {
        // Open the panel. Match the EXACT toggle: a substring match on "chat"
        // hits "Chat Settings" first in DOM order and opens the settings menu
        // instead of the panel.
        const opened = await page.evaluate(() => {
          const btn =
            (document.querySelector(
              'button[aria-label="open the chat panel"]'
            ) as HTMLElement | null) ??
            (Array.from(document.querySelectorAll("button")).find((b) => {
              const al = (b.getAttribute("aria-label") || "").toLowerCase()
              return al.includes("chat") && !al.includes("setting")
            }) as HTMLElement | undefined)
          if (!btn) return false
          btn.click()
          return true
        })
        if (!opened) {
          return { success: false, error: "Zoom chat toggle not found", status: 400 }
        }
        await page.waitForSelector(inputSelectors.join(", "), { timeout: 5000 }).catch(() => {})
        activeSelector = await findInput()
      }

      if (!activeSelector) {
        // Forensics: dump every editable element so the next run tells us the
        // real selector instead of failing blind again.
        const probe = await page
          .evaluate(() =>
            Array.from(
              document.querySelectorAll('textarea,[contenteditable="true"],input[type="text"]')
            )
              .slice(0, 15)
              .map((e) => {
                const el = e as HTMLElement
                return `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}[aria=${el.getAttribute("aria-label") || ""}]`
              })
          )
          .catch(() => [])
        console.error("[ChatManager] Zoom chat input not found. Editable elements:", probe)
        return { success: false, error: "Zoom chat input not found", status: 400 }
      }

      // Real keyboard events + Enter — Zoom's chat editor validates like the
      // pre-join name field, so focus+type is the reliable path.
      await page.locator(activeSelector).first().click({ timeout: 3000 })
      await page.keyboard.type(message, { delay: 20 })
      await page.keyboard.press("Enter")

      this.persistBotSentMessage(message)
      return { success: true }
    } catch (error) {
      console.error("[ChatManager] Zoom send failed:", formatError(error))
      return { success: false, error: "Chat is not available in this meeting", status: 400 }
    }
  }

  private async sendViaTeams(page: Page, message: string): Promise<SendBotMessageResult> {
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

      if (!inputFound) {
        // Open chat panel first
        await page.evaluate(() => {
          const btn = document.querySelector('button#chat-button') as HTMLElement | null
          if (btn) { btn.click(); return true }
          return false
        })
        await page.waitForSelector(inputSelectors.join(", "), { timeout: 2000 })
      }

      // Find which selector matches
      const activeSelector = inputFound || await page.evaluate((selectors) => {
        for (const sel of selectors) {
          if (document.querySelector(sel)) return sel
        }
        return null
      }, inputSelectors)

      if (!activeSelector) {
        return { success: false, error: "Chat input not found", status: 400 }
      }

      // Use CKEditor 5 internal API to insert text, then click the send button.
      // All Playwright keyboard/focus approaches fail because the chat input
      // is behind a z-index 900000 overlay and outside the viewport.
      const sendResult = await page.evaluate(({ selector, msg }) => {
        const el = document.querySelector(selector) as (Element & { ckeditorInstance?: CKEditor }) | null
        if (!el) return { sent: false, reason: "element not found" }

        const editor = el.ckeditorInstance
        if (!editor) return { sent: false, reason: "no ckeditorInstance on element" }

        // Insert text via CKEditor model API
        editor.model.change((writer) => {
          const root = editor.model.document.getRoot()
          writer.remove(writer.createRangeIn(root))
          writer.insertText(msg, root, 0)
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
      }, { selector: activeSelector, msg: message })

      console.log("[ChatManager] Teams CKEditor result:", JSON.stringify(sendResult))

      if (!sendResult.sent) {
        return { success: false, error: sendResult.reason ?? "Unknown Teams send error", status: 400 }
      }

      this.persistBotSentMessage(message)
      return { success: true }
    } catch (error) {
      console.error("[ChatManager] Teams send failed:", formatError(error))
      return { success: false, error: "Chat is not available in this meeting", status: 400 }
    }
  }

  private writeToDisk(): void {
    try {
      const filePath = this.getChatMessagesPath()
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      // Filter out internal _device_id field before writing artifact
      const artifact = this.chatMessages.map(({ _device_id, ...rest }) => rest)
      fs.writeFileSync(filePath, JSON.stringify(artifact, null, 2))
    } catch (error) {
      console.error("[ChatManager] Failed to write chat_messages.json:", error)
    }
  }

  private sendChatMessageToApi(message: ChatMessageData): void {
    if (envVars.SERVERLESS) return

    const params = GLOBAL.get()
    axios({
      method: "POST",
      url: "/bot-process/chat-message",
      data: {
        bot_id: params.bot_id,
        bot_uuid: params.bot_uuid,
        message_id: message.message_id,
        sender_name: message.sender_name,
        sender_id: message.sender_id,
        text: message.text,
        timestamp: message.timestamp
      }
    }).catch((error) => {
      if (error instanceof Error) {
        console.warn(
          "[ChatManager] Failed to send chat message to API (continuing):",
          error.message
        )
      }
    })
  }
}
