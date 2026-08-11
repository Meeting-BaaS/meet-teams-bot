import { type Browser, type BrowserContext, type Page, chromium } from "@playwright/test"
import { MeetingEndReason } from "../state-machine/types"
import { type StateDetectionConfig, createStateDetector } from "./meeting-state-detector"

/**
 * Regression tests for the Zoom self-kill bug: the meeting-end detector matched
 * denial phrases ("removed from the meeting", "meeting has ended") anywhere on
 * the page — including the bot's OWN entry chat message, which contains
 * "…the bot can be removed from the meeting upon simple request." The bot ended
 * itself with reason botRemoved ~200ms after sending it. Also griefable: any
 * participant typing a denial phrase into chat killed the bot.
 *
 * These tests run against a real Chromium page (real DOM: closest(),
 * getBoundingClientRect, TreeWalker) rather than mocks.
 */

jest.setTimeout(60_000)

// Mirrors the relevant parts of ZOOM_STATE_CONFIG (BotRemoved pattern + chat scoping)
const ZOOM_LIKE_CONFIG: StateDetectionConfig = {
  providerName: "Zoom Web (test)",
  denialPatterns: [
    {
      texts: ["automated bots aren't allowed"],
      reason: MeetingEndReason.ZoomAnonymousJoinNotAllowed,
      errorMessage: "anti-bot wall"
    },
    {
      texts: [
        "This meeting has been ended by host",
        "removed from the meeting",
        "meeting has ended"
      ],
      reason: MeetingEndReason.BotRemoved,
      errorMessage: "Bot removed or Zoom meeting ended"
    }
  ],
  denialIgnoreWithinSelectors: [
    "#chat",
    ".chat-container",
    ".chat-rtf-box__editor-outer",
    '[class*="new-chat"]'
  ],
  inMeetingPattern: {
    selectors: ['button[aria-label="Leave"]'],
    threshold: 1,
    checkVisibility: true
  }
}

// Chat panel markup as rendered by the real Zoom web client (from the crash
// HTML snapshot of bot 02c5dd71-28ce-4902-a96c-6ad10e95d04b)
const chatPanelHtml = (messageText: string) => `
  <div id="chat">
    <div class="chat-container window-content-bottom chat-container--normal chat-container--dark">
      <div class="chat-container__chat-list">
        <div class="new-chat-item__container">
          <div class="new-chat-message__text-box">
            <span class="new-chat-message__content">${messageText}</span>
          </div>
        </div>
      </div>
    </div>
  </div>`

const IN_MEETING_HTML = '<button aria-label="Leave">Leave</button>'

describe("meeting-state-detector isDenied (real Chromium DOM)", () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
  })

  beforeEach(async () => {
    context = await browser.newContext()
    page = await context.newPage()
  })

  afterEach(async () => {
    await context?.close()
  })

  const detector = createStateDetector(ZOOM_LIKE_CONFIG)

  describe("chat content is ignored", () => {
    it("does NOT match the bot's own entry chat message containing 'removed from the meeting'", async () => {
      await page.setContent(`
        ${IN_MEETING_HTML}
        ${chatPanelHtml(
          "Hello! This meeting is being recorded — the bot can be removed from the meeting upon simple request."
        )}`)

      const result = await detector.isDenied(page)
      expect(result.matched).toBe(false)
    })

    it("does NOT match a participant typing 'meeting has ended' into a chat message (griefing vector)", async () => {
      await page.setContent(`
        ${IN_MEETING_HTML}
        ${chatPanelHtml("lol watch this: meeting has ended")}`)

      const result = await detector.isDenied(page)
      expect(result.matched).toBe(false)
    })

    it("does NOT match denial text typed into the chat compose box", async () => {
      await page.setContent(`
        ${IN_MEETING_HTML}
        <div class="chat-rtf-box__editor-outer">
          <div class="chat-rtf-box__editor">You have been removed from the meeting</div>
        </div>`)

      const result = await detector.isDenied(page)
      expect(result.matched).toBe(false)
    })
  })

  describe("genuine denial UI still detected", () => {
    it("matches the same phrase in a visible Zoom modal outside the chat panel", async () => {
      await page.setContent(`
        <div class="zm-modal zm-modal-legacy">
          <div class="zm-modal-body-title">You have been removed from the meeting</div>
        </div>`)

      const result = await detector.isDenied(page)
      expect(result.matched).toBe(true)
      expect(result.matchedText).toBe("removed from the meeting")
      expect(result.pattern?.reason).toBe(MeetingEndReason.BotRemoved)
    })

    it("still detects a genuine removal modal even when chat also contains the phrase", async () => {
      await page.setContent(`
        ${chatPanelHtml("the bot can be removed from the meeting upon simple request.")}
        <div class="zm-modal">
          <div>You have been removed from the meeting</div>
        </div>`)

      const result = await detector.isDenied(page)
      expect(result.matched).toBe(true)
      expect(result.pattern?.reason).toBe(MeetingEndReason.BotRemoved)
    })

    it("matches case-insensitively (Playwright text= semantics preserved)", async () => {
      await page.setContent("<div>THIS MEETING HAS BEEN ENDED BY HOST</div>")

      const result = await detector.isDenied(page)
      expect(result.matched).toBe(true)
      expect(result.matchedText).toBe("This meeting has been ended by host")
    })

    it("respects pattern priority order (first configured pattern wins)", async () => {
      await page.setContent(`
        <div>meeting has ended</div>
        <div>Sorry, automated bots aren't allowed in this meeting</div>`)

      const result = await detector.isDenied(page)
      expect(result.matched).toBe(true)
      expect(result.pattern?.reason).toBe(MeetingEndReason.ZoomAnonymousJoinNotAllowed)
    })
  })

  describe("visibility requirement", () => {
    it("does NOT match denial text in a display:none element (hidden template DOM)", async () => {
      await page.setContent(`
        ${IN_MEETING_HTML}
        <div style="display:none">You have been removed from the meeting</div>`)

      const result = await detector.isDenied(page)
      expect(result.matched).toBe(false)
    })

    it("does NOT match denial text in a visibility:hidden element (non-zero rect)", async () => {
      await page.setContent(`
        ${IN_MEETING_HTML}
        <div style="visibility:hidden">You have been removed from the meeting</div>`)

      const result = await detector.isDenied(page)
      expect(result.matched).toBe(false)
    })
  })

  describe("phrase split across nested elements (Playwright text= parity)", () => {
    it("matches a phrase spanning nested inline elements — no single leaf contains it", async () => {
      await page.setContent(`
        <div class="zm-modal">
          <div class="zm-modal-body-title">You have <span>been removed</span> from the meeting</div>
        </div>`)

      const result = await detector.isDenied(page)
      expect(result.matched).toBe(true)
      expect(result.matchedText).toBe("removed from the meeting")
      expect(result.pattern?.reason).toBe(MeetingEndReason.BotRemoved)
    })

    it("still ignores a split phrase when it sits inside the chat panel", async () => {
      await page.setContent(`
        ${IN_MEETING_HTML}
        <div class="chat-container">
          <div>the bot can be <span>removed from</span> the meeting on request</div>
        </div>`)

      const result = await detector.isDenied(page)
      expect(result.matched).toBe(false)
    })
  })

  describe("open shadow DOM (Playwright text= parity)", () => {
    it("matches denial text inside an open shadow root", async () => {
      await page.setContent('<div id="host"></div>')
      await page.evaluate(() => {
        const host = document.getElementById("host") as HTMLElement
        const shadow = host.attachShadow({ mode: "open" })
        const modal = document.createElement("div")
        modal.className = "zm-modal"
        modal.textContent = "You have been removed from the meeting"
        shadow.appendChild(modal)
      })

      const result = await detector.isDenied(page)
      expect(result.matched).toBe(true)
      expect(result.matchedText).toBe("removed from the meeting")
      expect(result.pattern?.reason).toBe(MeetingEndReason.BotRemoved)
    })

    it("does NOT match shadow content whose host lives inside an ignored container", async () => {
      await page.setContent(`
        ${IN_MEETING_HTML}
        <div class="chat-container"><div id="chat-host"></div></div>`)
      await page.evaluate(() => {
        const host = document.getElementById("chat-host") as HTMLElement
        const shadow = host.attachShadow({ mode: "open" })
        const message = document.createElement("div")
        message.textContent = "the bot can be removed from the meeting upon simple request."
        shadow.appendChild(message)
      })

      const result = await detector.isDenied(page)
      expect(result.matched).toBe(false)
    })
  })

  describe("invalid ignore-selector tolerance", () => {
    const brokenSelectorConfig: StateDetectionConfig = {
      providerName: "Broken selector (test)",
      denialPatterns: [
        {
          texts: ["removed from the meeting"],
          reason: MeetingEndReason.BotRemoved
        }
      ],
      // one malformed selector mixed into valid ones
      denialIgnoreWithinSelectors: [":::bad", ".chat-container"],
      inMeetingPattern: { selectors: [], threshold: 1 }
    }
    const brokenSelectorDetector = createStateDetector(brokenSelectorConfig)

    it("still detects genuine denial UI and does not throw", async () => {
      await page.setContent(`
        <div class="zm-modal">You have been removed from the meeting</div>`)

      const result = await brokenSelectorDetector.isDenied(page)
      expect(result.matched).toBe(true)
      expect(result.pattern?.reason).toBe(MeetingEndReason.BotRemoved)
    })

    it("valid selectors alongside the malformed one still scope out chat", async () => {
      await page.setContent(`
        <div class="chat-container">the bot can be removed from the meeting upon request</div>`)

      const result = await brokenSelectorDetector.isDenied(page)
      expect(result.matched).toBe(false)
    })
  })

  describe("backward compatibility (no denialIgnoreWithinSelectors)", () => {
    const legacyConfig: StateDetectionConfig = {
      providerName: "Legacy (test)",
      denialPatterns: [
        {
          texts: ["You've been removed"],
          reason: MeetingEndReason.BotRemoved
        }
      ],
      inMeetingPattern: { selectors: [], threshold: 1 }
    }
    const legacyDetector = createStateDetector(legacyConfig)

    it("matches visible denial text anywhere on the page", async () => {
      await page.setContent("<main><p>You've been removed by the host</p></main>")

      const result = await legacyDetector.isDenied(page)
      expect(result.matched).toBe(true)
      expect(result.matchedText).toBe("You've been removed")
    })

    it("returns no match on a normal in-meeting page", async () => {
      await page.setContent(`${IN_MEETING_HTML}<div>Recording in progress</div>`)

      const result = await legacyDetector.isDenied(page)
      expect(result.matched).toBe(false)
    })
  })
})

// ── Teams lobby detection (isWaitingRoom) ────────────────────────────────────
// Regression for the diio investigation (2026-08-11): 266 Teams bots sat in the
// lobby for the full 600s. Teams had no waitingRoomPattern, so the bot could not
// tell a genuine lobby wait apart from a broken pre-join page. Real-DOM check
// that the lobby text is detected and the pre-join / denial screens are not.
const TEAMS_LOBBY_CONFIG: StateDetectionConfig = {
  providerName: "Microsoft Teams (test)",
  denialPatterns: [
    {
      texts: ["Sorry, but you were denied access to the meeting."],
      reason: MeetingEndReason.BotNotAccepted,
      errorMessage: "Teams has denied entry",
    },
  ],
  waitingRoomPattern: {
    selectors: [
      "text=let you in when the meeting starts",
      "text=Someone will let you in",
      "text=Waiting for someone to let you in",
    ],
    threshold: 1,
    checkVisibility: true,
  },
  inMeetingPattern: { selectors: ['button:has-text("React")'], threshold: 1, checkVisibility: false },
}

describe("Teams lobby (isWaitingRoom)", () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser?.close()
  })
  beforeEach(async () => {
    context = await browser.newContext()
    page = await context.newPage()
  })
  afterEach(async () => {
    await context?.close()
  })
  const detector = createStateDetector(TEAMS_LOBBY_CONFIG)

  it("detects the Teams lobby (matches the real captured DOM copy)", async () => {
    await page.setContent(`
      <div><h1>Hi, diio. Someone will let you in when the meeting starts.</h1>
      <div>Microsoft Teams meeting</div></div>`)
    expect((await detector.isWaitingRoom(page)).matched).toBe(true)
  })

  it("does NOT flag the pre-join screen (Join now present, no lobby copy) as the lobby", async () => {
    await page.setContent(`
      <div><h1>Choose your video and audio options</h1>
      <button>Join now</button></div>`)
    expect((await detector.isWaitingRoom(page)).matched).toBe(false)
  })

  it("does NOT flag the denial screen as the lobby", async () => {
    await page.setContent(`<div><h1>Sorry, but you were denied access to the meeting.</h1></div>`)
    expect((await detector.isWaitingRoom(page)).matched).toBe(false)
  })
})
