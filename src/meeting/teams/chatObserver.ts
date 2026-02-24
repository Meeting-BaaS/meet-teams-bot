import type { Page } from "@playwright/test"
import { ChatManager } from "../../chat-manager"
import { formatError } from "../../utils/Logger"

const MAX_CHAT_OPEN_RETRIES = 5
const CHAT_RETRY_INTERVAL_MS = 5000
const CHAT_ACTION_TIMEOUT_MS = 3000

declare global {
  interface Window {
    teamsChatObserverCleanup?: () => void
    onTeamsChatMessage?: (msg: { text: string; senderName: string; timestamp: number; messageId: string }) => void
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

    console.log("[TeamsChatObserver] Starting chat observation...")

    // Expose callback to browser
    await this.page.exposeFunction(
      "onTeamsChatMessage",
      async (msg: { text: string; senderName: string; timestamp: number; messageId: string }) => {
        try {
          await ChatManager.getInstance().handleChatMessage({
            messageId: msg.messageId,
            text: msg.text,
            senderName: msg.senderName,
            timestamp: msg.timestamp,
          })
        } catch (error) {
          console.error("[TeamsChatObserver] Error handling chat message:", error)
        }
      }
    )

    // Open the chat panel (hidden behind z-index overlay from htmlCleaner)
    const chatOpened = await this.openChatPanel()
    if (!chatOpened) {
      console.warn("[TeamsChatObserver] Could not open chat panel, observation may be limited")
    }

    // Inject MutationObserver into the page
    await this.page.evaluate(() => {
      console.log("[TeamsChatObserver-Browser] Setting up chat observation...")

      const seenIds = new Set<string>()
      let pollInterval: ReturnType<typeof setInterval> | null = null

      function scrapeMessages() {
        try {
          // Teams chat messages container
          const chatContainer = document.querySelector(
            '[data-tid="chat-pane-list"], [role="log"], [aria-label*="Chat"], [aria-label*="chat"]'
          )
          if (!chatContainer) return

          const messageElements = chatContainer.querySelectorAll(
            '[data-tid="chat-pane-message"], [role="listitem"]'
          )

          for (const el of messageElements) {
            const textEl = el.querySelector(
              '[data-tid="chat-pane-message-body"], .ui-chat__message__content, [class*="message-body"]'
            )
            const text = textEl?.textContent?.trim()
            if (!text) continue

            const senderEl = el.querySelector(
              '[data-tid="chat-pane-message-sender"], .ui-chat__message__author, [class*="message-author"]'
            )
            const senderName = senderEl?.textContent?.trim() || "Unknown"

            const messageId = `teams-${senderName}-${text.substring(0, 50)}-${text.length}`
            if (seenIds.has(messageId)) continue
            seenIds.add(messageId)

            // Trim seenIds
            if (seenIds.size > 1000) {
              const iter = seenIds.values()
              for (let i = 0; i < 500; i++) {
                const result = iter.next()
                if (!result.done) seenIds.delete(result.value)
              }
            }

            if (typeof window.onTeamsChatMessage === "function") {
              window.onTeamsChatMessage({
                text,
                senderName,
                timestamp: Date.now(),
                messageId,
              })
            }
          }
        } catch (e) {
          console.error("[TeamsChatObserver-Browser] Error scraping messages:", e)
        }
      }

      // Initial scrape
      scrapeMessages()

      // MutationObserver for real-time updates
      const observer = new MutationObserver(() => {
        scrapeMessages()
      })

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      })

      // Fallback polling every 5s
      pollInterval = setInterval(scrapeMessages, 5000)

      // Cleanup function
      window.teamsChatObserverCleanup = () => {
        console.log("[TeamsChatObserver-Browser] Cleaning up")
        observer.disconnect()
        if (pollInterval) clearInterval(pollInterval)
      }

      console.log("[TeamsChatObserver-Browser] ✅ Chat observation active")
    })

    this.isObserving = true
    console.log("[TeamsChatObserver] ✅ Chat observation started")
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
          console.warn(`[TeamsChatObserver] ⚠️ Chat is disabled: ${reason}`)
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

        console.log("[TeamsChatObserver] Chat button clicked")

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
            console.warn(`[TeamsChatObserver] ⚠️ Chat is disabled: ${disabled}`)
            this._chatDisabled = true
            return false
          }

          console.log("[TeamsChatObserver] ✅ Chat panel opened successfully")
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

  public stopObserving(): void {
    if (!this.isObserving) return

    // Clean up MutationObserver
    this.page
      ?.evaluate(() => {
        if (window.teamsChatObserverCleanup) {
          window.teamsChatObserverCleanup()
        }
      })
      .catch((e) => console.error("[TeamsChatObserver] Error cleaning up observer:", e))

    // Close chat panel on cleanup
    this.page
      ?.evaluate(() => {
        const closeButton = document.querySelector(
          'button[data-tid="rail-header-close-button"]'
        ) as HTMLElement | null
        if (closeButton) {
          closeButton.click()
          console.log("[TeamsChatObserver-Browser] Chat panel closed")
        }
      })
      .catch((e) => console.error("[TeamsChatObserver] Error closing chat panel:", e))

    this.isObserving = false
    console.log("[TeamsChatObserver] ✅ Chat observation stopped")
  }
}
