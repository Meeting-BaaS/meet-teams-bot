import type { Page } from "@playwright/test"
import { ChatManager } from "../../chat-manager"
import { GLOBAL } from "../../singleton"
import type { ChatMessageData } from "../../types"

declare global {
  interface Window {
    zoomChatCleanup?: () => void
    zoomChatMessage?: (msg: { sender: string; text: string }) => void
  }
}

/**
 * Zoom Web chat reader — DOM observation (no network). Ported from vexa
 * `zoom-capture/zoom-chat.ts`: defensive multi-candidate selectors because
 * Zoom's chat DOM shifts across builds, plus a heuristic fallback (short text =
 * sender, long text = body). The chat panel must be OPEN for messages to exist
 * in the DOM — Zoom mounts/unmounts it on toggle, so the in-page code polls for
 * the container and re-attaches.
 *
 * Messages cross back to Node via exposeFunction and flow into ChatManager,
 * matching MeetChatObserver. sender_id stays null (no participant-id mapping
 * from Zoom's DOM); message_id is synthesised from sender+text.
 */
export class ZoomChatObserver {
  private page: Page
  private isObserving = false
  private counter = 0

  constructor(page: Page) {
    this.page = page
  }

  public async startObserving(): Promise<void> {
    if (this.isObserving) return

    const botName = GLOBAL.get().bot_name

    // Open the chat panel. Zoom mounts the message list ONLY while the panel is
    // open, so without this the observer polls forever for a container that
    // never appears and any bot with no entry_message silently produces an empty
    // chat_messages.json. (Previously the panel only ever opened as a
    // side-effect of sendViaZoom, i.e. only when an entry_message was set.)
    // Teams does the same thing explicitly. Match the EXACT toggle — a substring
    // match on "chat" hits "Chat Settings" first and opens the settings menu.
    // HtmlCleaner keeps the panel out of the recording visually (opacity), so it
    // can stay open without polluting the video.
    try {
      await this.page.evaluate(() => {
        const alreadyOpen = document.querySelector(
          '[aria-label="Chat Message List"], .chat-virtuoso-wrapper'
        )
        if (alreadyOpen) return
        const btn =
          (document.querySelector(
            'button[aria-label="open the chat panel"]'
          ) as HTMLElement | null) ??
          (Array.from(document.querySelectorAll("button")).find((b) => {
            const al = (b.getAttribute("aria-label") || "").toLowerCase()
            return al.includes("chat") && !al.includes("setting")
          }) as HTMLElement | undefined)
        btn?.click()
      })
    } catch (error) {
      console.warn("[ZoomChatObserver] Could not open chat panel:", error)
    }

    await this.page.exposeFunction(
      "zoomChatMessage",
      async (msg: { sender: string; text: string }) => {
        try {
          // Zoom renders the bot's OWN messages with sender "You". Drop them:
          // ChatManager.persistBotSentMessage already records anything the bot
          // sends, and it writes via addChatMessage() directly — bypassing the
          // dedup in handleChatMessage — so an echo captured here is stored as a
          // SECOND copy no matter what sender we give it (observed live: the
          // entry message appeared twice in chat_messages.json). Skipping self
          // is the only place the duplicate can be cut.
          if (msg.sender === "You" || msg.sender === botName) return
          const data: ChatMessageData = {
            text: msg.text,
            sender_name: msg.sender || "Unknown",
            sender_id: null,
            timestamp: new Date().toISOString(),
            message_id: `zoom-${Date.now()}-${this.counter++}`
          }
          await ChatManager.getInstance().handleChatMessage(data)
        } catch (error) {
          console.error("[ZoomChatObserver] Error handling message:", error)
        }
      }
    )

    await this.page.evaluate(() => {
      const CONTAINER_SELECTORS = [
        '[aria-label="Chat Message List"]',
        ".chat-virtuoso-wrapper",
        "#chat-list-content",
        ".chat-list-content",
        ".chat-container__chat-list",
        '[class*="chat-list"]',
        '[class*="chat-message-list"]'
      ]
      const MESSAGE_SELECTORS = [
        '[id^="chat-message-"]',
        ".new-chat-message__container",
        '[class*="chat-message-item"]',
        '[class*="chatMessage"]',
        "div[data-index]"
      ]
      const SENDER_SELECTORS = [
        ".chat-message-text__user-name",
        '[class*="user-name"]',
        '[class*="userName"]',
        '[class*="sender"]',
        '[class*="display-name"]'
      ]
      const TEXT_SELECTORS = [
        '[class*="chat-message-text"]',
        '[class*="message-text"]',
        '[class*="messageText"]',
        ".text-wrapper",
        '[class*="text-content"]'
      ]

      const seenNodes = new WeakSet<Element>()
      const seenHashes = new Map<string, number>()
      const HASH_TTL_MS = 5000
      let matchedContainer: Element | null = null

      const firstText = (root: Element, selectors: string[]): string => {
        for (const s of selectors) {
          const t = root.querySelector(s)?.textContent?.trim()
          if (t) return t
        }
        return ""
      }

      const senderFromAria = (node: Element): string => {
        let cur: Element | null = node
        for (let i = 0; i < 4 && cur; i++, cur = cur.parentElement) {
          const al = cur.getAttribute?.("aria-label") || ""
          const m = al.match(/^(.+?)\s+(?:said|to\s+Everyone|to\s+[A-Z])/i)
          if (m && m[1].trim()) return m[1].trim()
        }
        return ""
      }

      const extract = (node: Element): { sender: string; text: string } | null => {
        let text = firstText(node, TEXT_SELECTORS)
        let sender = firstText(node, SENDER_SELECTORS)
        if (!sender) {
          let cur: Element | null = node.parentElement
          for (let i = 0; i < 4 && cur && !sender; i++, cur = cur.parentElement)
            sender = firstText(cur, SENDER_SELECTORS)
        }
        if (!sender) sender = senderFromAria(node)
        if (!text) {
          const frags = Array.from(node.querySelectorAll("*"))
            .map((e) => (e.childElementCount === 0 ? (e.textContent || "").trim() : ""))
            .filter((t) => t.length > 0)
          if (!frags.length) return null
          const longest = frags.reduce((a, b) => (b.length > a.length ? b : a), "")
          text = longest
          if (!sender) {
            const shortName = frags.find(
              (f) => f !== longest && f.length <= 40 && !/^\d{1,2}:\d{2}/.test(f)
            )
            if (shortName) sender = shortName
          }
        }
        sender = sender.replace(/\s*\d{1,2}:\d{2}\s*(AM|PM)?\s*$/i, "").trim() || "Unknown"
        if (!text) return null
        return { sender, text }
      }

      // Zoom injects system notices into the same message list as human chat
      // (the group-chat banner, join/leave events). They carry no sender, so
      // they'd land in the artifact as sender_name "Unknown" — observed live:
      // "Messages addressed to \"Meeting Group Chat\" will also appear…" and
      // "Recording Bot left". Drop them: a chat artifact must contain only what
      // participants actually typed.
      const SYSTEM_TEXT_PATTERNS = [
        /^messages addressed to/i,
        /will also appear in the meeting group chat/i,
        /^\s*.+\s+(joined|left)\s*$/i,
        /^this meeting is being recorded/i,
        /^recording (started|stopped)/i,
        /^who can see your messages\?/i
      ]
      const isSystemMessage = (m: { sender: string; text: string }): boolean =>
        m.sender === "Unknown" && SYSTEM_TEXT_PATTERNS.some((re) => re.test(m.text.trim()))

      const emit = (node: Element) => {
        if (seenNodes.has(node)) return
        seenNodes.add(node)
        const msg = extract(node)
        if (!msg) return
        if (isSystemMessage(msg)) return
        const hash = `${msg.sender} ${msg.text}`
        const now = Date.now()
        const last = seenHashes.get(hash)
        if (last !== undefined && now - last < HASH_TTL_MS) return
        seenHashes.set(hash, now)
        try {
          window.zoomChatMessage?.(msg)
        } catch {
          /* never break capture */
        }
      }

      const scanMessages = (root: ParentNode) => {
        for (const sel of MESSAGE_SELECTORS) {
          const nodes = root.querySelectorAll(sel)
          if (nodes.length) {
            nodes.forEach((n) => emit(n))
            return
          }
        }
      }

      const findContainer = (): Element | null => {
        for (const sel of CONTAINER_SELECTORS) {
          const el = document.querySelector(sel)
          if (el) return el
        }
        return null
      }

      const observer = new MutationObserver(() => {
        if (matchedContainer) scanMessages(matchedContainer)
      })
      const attach = () => {
        const found = findContainer()
        if (found && found !== matchedContainer) {
          matchedContainer = found
          observer.disconnect()
          observer.observe(matchedContainer, { childList: true, subtree: true })
          scanMessages(matchedContainer)
        } else if (found) {
          scanMessages(matchedContainer!)
        }
      }
      attach()
      const poll = window.setInterval(attach, 2000)
      window.zoomChatCleanup = () => {
        window.clearInterval(poll)
        observer.disconnect()
      }
    })

    this.isObserving = true
    console.log("[ZoomChatObserver] Chat observation started")
  }

  public stopObserving(): void {
    if (!this.isObserving) return
    this.page
      ?.evaluate(() => window.zoomChatCleanup?.())
      .catch((e) => console.error("[ZoomChatObserver] Error stopping:", e))
    this.isObserving = false
    console.log("[ZoomChatObserver] Chat observation stopped")
  }
}
