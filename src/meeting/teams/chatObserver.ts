import type { Page } from "@playwright/test"
import { ChatManager } from "../../chat-manager"
import { GLOBAL } from "../../singleton"
import { formatError } from "../../utils/Logger"

const MAX_CHAT_OPEN_RETRIES = 5
const CHAT_RETRY_INTERVAL_MS = 5000
const CHAT_ACTION_TIMEOUT_MS = 3000

declare global {
  interface Window {
    onTeamsChatMessage?: (msg: { text: string; senderName: string; timestamp: string; messageId: string }) => void
  }
}

export class TeamsChatObserver {
  private page: Page
  private isObserving = false
  private _chatDisabled = false

  constructor(page: Page) {
    this.page = page
  }

  public get chatDisabled(): boolean {
    return this._chatDisabled
  }

  public async startObserving(): Promise<void> {
    if (this.isObserving) {
      console.warn("[TeamsChatObserver] Already observing")
      return
    }

    // Expose callback to browser
    await this.page.exposeFunction(
      "onTeamsChatMessage",
      async (msg: { text: string; senderName: string; timestamp: string; messageId: string }) => {
        try {
          // Filter out Teams system/metadata messages (e.g. callEnded with internal URLs)
          if (this.isSystemMessage(msg.text)) {
            console.log("[TeamsChatObserver] Filtered system message:", msg.text.substring(0, 80))
            return
          }

          // Resolve raw Teams IDs (e.g. "8:orgid:..." or "8:teamsvisitor:...") to display names
          let senderName = msg.senderName
          if (senderName.startsWith("8:")) {
            const resolved = this.resolveTeamsIdToName(senderName)
            if (resolved) {
              console.log(`[TeamsChatObserver] Resolved sender "${senderName}" -> "${resolved}"`)
              senderName = resolved
            } else {
              console.warn(`[TeamsChatObserver] Could not resolve Teams ID: ${senderName}`)
            }
          }

          await ChatManager.getInstance().handleChatMessage({
            messageId: msg.messageId,
            text: msg.text,
            senderName,
            senderId: null, // Teams has no deviceId for participant lookup
            timestamp: msg.timestamp,
          })
        } catch (error) {
          console.error("[TeamsChatObserver] Error handling chat message:", error)
        }
      }
    )

    // The primary chat interception (Function.prototype.bind monkey-patch) is
    // installed in teams.ts via addInitScript BEFORE page.goto(), so it runs
    // before Teams' JS and catches onMessageReceived.bind(). The exposeFunction
    // above makes window.onTeamsChatMessage available for the hook to call.

    // Open the chat panel (needed for sending)
    const chatOpened = await this.openChatPanel()
    if (!chatOpened) {
      console.warn("[TeamsChatObserver] Could not open chat panel, observation may be limited")
    }

    this.isObserving = true
    console.log("[TeamsChatObserver] Chat observation started")
  }

  /**
   * Open the Teams chat panel using evaluate() to bypass z-index overlay.
   * The chat panel stays open but is hidden behind the video area (z-index: 900000).
   */
  private async openChatPanel(): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_CHAT_OPEN_RETRIES; attempt++) {
      try {
        // Check if chat is disabled by the meeting organizer
        const chatStatus = await this.page.evaluate(() => {
          // Chat panel with input ready
          if (
            document.querySelector('[aria-label="Type a message"]') ||
            document.querySelector('[placeholder="Type a message"]') ||
            document.querySelector('div[data-tid="ckeditor"][role="textbox"]')
          ) {
            return "ready"
          }
          // Chat panel open but disabled
          const disabledEl = document.querySelector('[data-tid="compose-disabled-placeholder-text"]')
          if (disabledEl) {
            return `disabled:${disabledEl.textContent?.trim() || "Chat is disabled"}`
          }
          // Chat pane list exists (panel open, input may not be loaded yet)
          if (document.querySelector('[data-tid="chat-pane-list"]')) {
            return "panel-open"
          }
          return "closed"
        })

        if (chatStatus === "ready") {
          console.log("[TeamsChatObserver] Chat panel already open with input ready")
          return true
        }

        if (chatStatus.startsWith("disabled:")) {
          const reason = chatStatus.slice("disabled:".length)
          console.warn(`[TeamsChatObserver] Chat is disabled: ${reason}`)
          this._chatDisabled = true
          return false
        }

        if (chatStatus === "panel-open") {
          // Panel is open but no input — likely disabled without the placeholder text,
          // or still loading. Wait briefly and re-check.
          if (attempt < MAX_CHAT_OPEN_RETRIES) {
            await this.page.waitForTimeout(CHAT_RETRY_INTERVAL_MS)
          }
          continue
        }

        // Chat panel is closed — click the chat button to open it
        const chatButtonClicked = await this.page.evaluate(() => {
          const selectors = [
            'button#chat-button',
            'button[aria-label*="chat" i]',
            'button[title*="chat" i]',
            '[data-tid="chat-button"]',
            '[role="button"][aria-label*="chat" i]',
          ]
          for (const sel of selectors) {
            const el = document.querySelector(sel) as HTMLElement | null
            if (el) {
              el.click()
              return true
            }
          }
          return false
        })

        if (!chatButtonClicked) {
          console.log(`[TeamsChatObserver] Chat button not found, attempt ${attempt}/${MAX_CHAT_OPEN_RETRIES}`)
          if (attempt < MAX_CHAT_OPEN_RETRIES) {
            await this.page.waitForTimeout(CHAT_RETRY_INTERVAL_MS)
          }
          continue
        }

        // Wait for chat panel to appear
        try {
          await this.page.waitForSelector(
            '[data-tid="chat-pane-list"], [aria-label="Type a message"], [placeholder="Type a message"]',
            { timeout: CHAT_ACTION_TIMEOUT_MS }
          )

          // Check if it opened but is disabled
          const disabled = await this.page.evaluate(() => {
            const el = document.querySelector('[data-tid="compose-disabled-placeholder-text"]')
            return el?.textContent?.trim() || null
          })
          if (disabled) {
            console.warn(`[TeamsChatObserver] Chat is disabled: ${disabled}`)
            this._chatDisabled = true
            return false
          }

          console.log("[TeamsChatObserver] Chat panel opened successfully")
          return true
        } catch {
          console.warn(`[TeamsChatObserver] Chat container not found after click, attempt ${attempt}/${MAX_CHAT_OPEN_RETRIES}`)
          if (attempt < MAX_CHAT_OPEN_RETRIES) {
            await this.page.waitForTimeout(CHAT_RETRY_INTERVAL_MS)
          }
        }
      } catch (error) {
        console.warn(`[TeamsChatObserver] Error opening chat panel, attempt ${attempt}/${MAX_CHAT_OPEN_RETRIES}:`, formatError(error))
        if (attempt < MAX_CHAT_OPEN_RETRIES) {
          await this.page.waitForTimeout(CHAT_RETRY_INTERVAL_MS)
        }
      }
    }

    console.warn("[TeamsChatObserver] Failed to open chat panel after all attempts")
    return false
  }

  /**
   * Check if a message is a Teams system/metadata message that should be filtered out.
   * Examples: callEnded events, internal API URLs.
   */
  private isSystemMessage(text: string): boolean {
    // System messages with callEnded and internal URLs spanning multiple lines
    if (text.includes("\n") && (text.includes("callEnded") || text.includes("api.flightproxy"))) {
      return true
    }
    return false
  }

  /**
   * Try to resolve a raw Teams ID (e.g. "8:orgid:xxx") to a display name
   * by looking up participants from the GLOBAL participants roster.
   */
  private resolveTeamsIdToName(teamsId: string): string | null {
    const participants = GLOBAL.getParticipants()
    for (const p of participants) {
      // Match against participantId or odaId
      if (p.participantId === teamsId || p.odaId === teamsId) {
        return p.name
      }
    }
    return null
  }

  public async stopObserving(): Promise<void> {
    if (!this.isObserving) return

    // Close chat panel on cleanup
    try {
      await this.page?.evaluate(() => {
        const closeButton = document.querySelector(
          'button[data-tid="rail-header-close-button"]'
        ) as HTMLElement | null
        if (closeButton) {
          closeButton.click()
        }
      })
    } catch (e) {
      console.error("[TeamsChatObserver] Error closing chat panel:", e)
    }

    this.isObserving = false
    console.log("[TeamsChatObserver] Chat observation stopped")
  }
}
