import type { BrowserContext, Page } from "@playwright/test"
import { brandingReady } from "../branding"
import { listenPage } from "../browser/page-logger"
import { SimpleDialogObserver } from "../services/dialog-observer/simple-dialog-observer"
import { HtmlSnapshotService } from "../services/html-snapshot-service"
import { GLOBAL } from "../singleton"
import { MeetingEndReason } from "../state-machine/types"
import type { MeetingProviderInterface } from "../types"
import { parseMeetingUrlFromJoinInfos } from "../urlParser/meetUrlParser"
import { formatError } from "../utils/Logger"
import {
  createStateDetector,
  type DenialPattern,
  type SelectorPattern
} from "../utils/meeting-state-detector"
import { sleep } from "../utils/sleep"
import { enableMeetAudioCapture } from "./meet/audio-capture"
import { closeMeeting } from "./meet/closeMeeting"
import { MEET_STATE_CONFIG } from "./meet-state-config"

// Create a singleton detector instance for Google Meet
const meetStateDetector = createStateDetector(MEET_STATE_CONFIG)
const ENTRY_MESSAGE_TIMEOUT = 2000
const GRACE_PERIOD_MS = 1000 // Grace period after leaving waiting room before checking if in meeting

/**
 * Checks that the page is still on meet.google.com.
 * If the page navigated away (e.g. Google redirected to workspace.google.com
 * after showing "You can't join this video call"), sets a retryable error and throws.
 */
function assertOnMeetPage(page: Page): void {
  const url = page.url()
  if (url && !url.includes("meet.google.com")) {
    console.log(`Page is not on Google Meet: ${url}`)
    GLOBAL.setShouldRetry(true)
    GLOBAL.setError(
      MeetingEndReason.BotNotAccepted,
      `Google Meet denied entry - page redirected to: ${url}`
    )
    throw new Error("Page navigated away from Google Meet")
  }
}

export class MeetProvider implements MeetingProviderInterface {
  async parseMeetingUrl(meeting_url: string) {
    return parseMeetingUrlFromJoinInfos(meeting_url)
  }

  getMeetingLink(meeting_id: string, _password: string, _role: number, _bot_name: string) {
    return meeting_id
  }

  async openMeetingPage(
    browserContext: BrowserContext,
    link: string,
    streaming_input: string | undefined,
    attempts = 0
  ): Promise<Page> {
    try {
      console.log("Creating new page in existing context...")
      const page = await browserContext.newPage()

      // Set up page logger IMMEDIATELY so we can see logs from injected scripts
      listenPage(page)
      console.log("[Meet] Page logger set up")

      // Set permissions based on streaming_input
      if (streaming_input) {
        await browserContext.grantPermissions(["microphone", "camera"])
      } else {
        await browserContext.grantPermissions(["camera"])
      }

      // Audio track layer for network diarization
      // Audio streaming is handled by FFmpeg PulseAudio capture
      await enableMeetAudioCapture(page)
      console.log("[Meet] Audio track layer enabled (streaming via FFmpeg)")

      // Setup network interception scripts BEFORE navigation
      // addInitScript must be called before page.goto() to work properly
      try {
        const { setupNetworkInterceptionScripts } = await import("./meet/network-interception")
        const success = await setupNetworkInterceptionScripts(page)
        if (success) {
          console.log("[Meet] ✅ Network interception scripts set up")
        } else {
          console.warn(
            "[Meet] ⚠️ Network interception scripts setup returned false, will fallback to UI-based detection"
          )
          GLOBAL.setNetworkInterceptionSetupFailed()
        }
      } catch (error) {
        console.warn(
          "[Meet] ⚠️ Failed to setup network interception scripts, will fallback to UI-based detection:",
          formatError(error)
        )
        // Mark as failed so we don't retry in in-call-state
        GLOBAL.setNetworkInterceptionSetupFailed()
      }

      console.log(`Navigating to ${link}...`)
      await page.goto(link, {
        waitUntil: "networkidle",
        timeout: 30000
      })
      console.log("Navigation completed")

      // Check for page freeze after goto (same as Teams)
      let pageFrozen = false
      try {
        await Promise.race([
          page.evaluate(() => document.readyState),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Page freeze timeout after goto")),
              10000 // 10 seconds timeout to detect freeze
            )
          )
        ])
      } catch (_e) {
        pageFrozen = true
        console.warn(`⚠️ Page appears to be frozen after goto (attempt ${attempts + 1}/3)`)
      }

      // Retry if frozen and we haven't exceeded max attempts
      if (pageFrozen && attempts < 3) {
        await page.close()
        console.log(`🔄 Page freeze detected, retrying... (${attempts + 1}/3)`)
        await sleep(1000) // Wait before retry
        return await this.openMeetingPage(browserContext, link, streaming_input, attempts + 1)
      }
      if (pageFrozen && attempts >= 3) {
        console.warn("⚠️ Page freeze persists after 3 retries, continuing anyway...")
        // Continue - page might recover later
      }

      return page
    } catch (error) {
      console.error("openMeetingPage error:", formatError(error))
      // Mark as retryable - bot hasn't joined yet, so retrying is safe
      console.log("🔄 Error occurred before joining - marking as retryable")
      GLOBAL.setShouldRetry(true)
      throw error
    }
  }

  async joinMeeting(
    page: Page,
    cancelCheck: () => boolean,
    onJoinSuccess: () => void,
    dialogObserver?: SimpleDialogObserver
  ): Promise<void> {
    try {
      // Capture DOM state before starting join process
      const htmlSnapshot = HtmlSnapshotService.getInstance()
      await htmlSnapshot.captureSnapshot(page, "meet_join_meeting_start")

      // Bail out early if page already navigated away (e.g. denial during timing wait)
      assertOnMeetPage(page)

      await clickDismiss(page)
      await sleep(300)

      console.log(
        "useWithoutAccountClicked:",
        await clickWithInnerText(page, "span", ["Use without an account"], 2)
      )

      // Hybrid retry strategy: fast path for first 5 attempts, exponential backoff for last 5
      for (let attempt = 1; attempt <= 10; attempt++) {
        if (await typeBotName(page, GLOBAL.get().bot_name)) {
          console.log("Bot name typed at attempt", attempt)
          break
        }

        if (attempt < 10) {
          // Don't wait after last attempt
          await clickOutsideModal(page)

          if (attempt < 5) {
            // Fast path: 500ms fixed delay for attempts 1-4
            await page.waitForTimeout(500)
          } else {
            // Slow path: exponential backoff for attempts 5-9 (handles dialog cases, page temporarily frozen)
            // Attempt 5: 500ms, attempts 6-9: 1s, 2s, 4s, 8s
            const exponentialDelay = 1000 * 2 ** (attempt - 6)
            console.log(
              `Bot name typing failed at attempt ${attempt}, waiting ${exponentialDelay}ms before retry (exponential backoff)`
            )
            await page.waitForTimeout(exponentialDelay)
          }
        }
      }

      // Control microphone based on streaming_input
      if (GLOBAL.get().streaming_input) {
        await activateMicrophone(page)
      } else {
        await deactivateMicrophone(page)
      }

      // Control camera based on whether branding was actually generated successfully
      if (brandingReady) {
        console.log("Camera will be used for branding, keeping it on")
      } else {
        await deactivateCamera(page)
      }

      // Final stop check before the irreversible join button click
      if (cancelCheck()) {
        console.log("Stop request detected before clicking Join — aborting")
        GLOBAL.setError(MeetingEndReason.ExitingMeetingBeforeRecord)
        throw new Error("Bot stopped before joining meeting")
      }

      // Try to click join button - will retry continuously while waiting
      let lastJoinClickAt = 0
      const joinRetryCooldownMs = 2000
      let joinRetryCount = 0

      // Initial attempt to click join button
      const initialClick = await clickJoinCtaIfPresent(page)
      if (initialClick) {
        console.log("Successfully clicked join button on initial attempt")
        lastJoinClickAt = Date.now()
      } else {
        console.log("Join button not found on initial attempt, will retry in loop")
      }

      // Wait to be in the meeting with regular cancelCheck verification
      console.log("Waiting to confirm meeting join...")
      let inWaitingRoom = false
      let leftWaitingRoomAt: number | null = null
      while (true) {
        if (cancelCheck()) {
          // Only set error if not already set by stopMeeting()
          if (!GLOBAL.getEndReason()) {
            GLOBAL.setError(MeetingEndReason.ApiRequest)
          }
          throw new Error("API request to stop recording")
        }

        // Check if we're in the waiting room
        const nowInWaitingRoom = await isInWaitingRoom(page)
        if (nowInWaitingRoom && !inWaitingRoom) {
          console.log("📋 Bot is in waiting room, waiting for host to admit...")
          inWaitingRoom = true
        }

        // Detect when we leave the waiting room
        if (inWaitingRoom && !nowInWaitingRoom && !leftWaitingRoomAt) {
          leftWaitingRoomAt = Date.now()
          console.log("✅ Left waiting room, giving UI 2 seconds to fully render...")
        }

        // Only retry clicking join button if NOT in waiting room
        if (!inWaitingRoom && Date.now() - lastJoinClickAt >= joinRetryCooldownMs) {
          const retried = await clickJoinCtaIfPresent(page)
          if (retried) {
            lastJoinClickAt = Date.now()
            joinRetryCount += 1
            console.log(`Clicked join button (attempt #${joinRetryCount})`)
          }
        }

        // After leaving waiting room, give UI time to render before checking
        const gracePeriodExpired =
          !leftWaitingRoomAt || Date.now() - leftWaitingRoomAt >= GRACE_PERIOD_MS

        if (gracePeriodExpired) {
          const inMeeting = await isInMeeting(page)
          if (inMeeting) {
            console.log(
              `✅ Successfully confirmed we are in the meeting (grace period: ${!leftWaitingRoomAt ? "not in waiting room" : `expired after ${Date.now() - leftWaitingRoomAt}ms`})`
            )
            // Signal join success immediately so the waiting room timeout is cleared.
            // performCriticalSetupActions can take minutes if dialogs block it.
            onJoinSuccess()
            // Critical setup actions BEFORE state transition (People panel, layout, snapshot)
            await performCriticalSetupActions(page, dialogObserver)
            break
          }
        }

        // Check page URL before text-based denial detection — catches redirects
        assertOnMeetPage(page)

        if (await notAcceptedInMeeting(page)) {
          throw new Error("Bot not accepted into meeting")
        }

        await sleep(1000)
      }

      // Post-join: critical setup in performCriticalSetupActions; non-critical in InCallState

      // People panel + layout + snapshot in performCriticalSetupActions; entry msg + audio in InCallState
    } catch (error) {
      console.error("Error in joinMeeting:", formatError(error))
      throw error
    }
  }

  async findEndMeeting(page: Page): Promise<boolean> {
    try {
      try {
        await Promise.race([
          page.evaluate(() => document.readyState),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Page freeze timeout")), 20000)
          )
        ])
      } catch (_e) {
        console.log("Page appears to be frozen for 30 seconds")
        return true
      }

      if (!page.isClosed()) {
        const content = await page.content()
        const endMessages = [
          "You've been removed",
          "we encountered a problem joining",
          "The call ended",
          "Return to home",
          "No one else"
        ]

        const foundMessage = endMessages.find((msg) => content.includes(msg))

        if (foundMessage) {
          console.log("End meeting detected through page content:", foundMessage)
          return true
        }
      }
      return false
    } catch (error) {
      console.error("Error in findEndMeeting:", error)
      return false
    }
  }

  async closeMeeting(page: Page): Promise<void> {
    await closeMeeting(page)
  }
}

/**
 * Opens People panel using keyboard shortcut (Ctrl+Alt+P).
 * Falls back to button click if shortcut fails.
 */
async function openPeoplePanelWithShortcut(page: Page): Promise<boolean> {
  try {
    console.log("Opening People panel with keyboard shortcut (Ctrl+Alt+P)...")
    await page.keyboard.press("Control+Alt+KeyP")
    console.log("People panel opened with keyboard shortcut")
    return true
  } catch (error) {
    console.error("Failed to open People panel with shortcut:", formatError(error))
    console.log("Falling back to button click method...")
    try {
      await findShowEveryOne(page, true, () => false)
    } catch (fallbackError) {
      console.error("Fallback method also failed:", formatError(fallbackError))
    }
    return false
  }
}

/**
 * Performs critical setup before state transition: People panel, layout, snapshot.
 */
async function performCriticalSetupActions(
  page: Page,
  dialogObserver?: SimpleDialogObserver
): Promise<void> {
  // Re-enforce camera/mic state — Google Meet resets devices during waiting room → in-call transition
  if (brandingReady) {
    await ensureCameraOn(page)
  } else {
    await ensureCameraOff(page)
  }
  if (GLOBAL.get().streaming_input) {
    await ensureMicrophoneOn(page)
  } else {
    await ensureMicrophoneOff(page)
  }

  const htmlSnapshot = HtmlSnapshotService.getInstance()

  if (GLOBAL.get().recording_mode !== "gallery_view") {
    await openPeoplePanelWithShortcut(page)
  }

  if (GLOBAL.get().recording_mode !== "audio_only") {
    // Pause the dialog observer while we interact with the layout dialog.
    // The observer would detect the Change Layout dialog as generic_dismiss
    // and race with our Playwright interactions, causing timeouts.
    SimpleDialogObserver.pause()
    try {
      const maxAttempts = 3
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Manually dismiss any visible dialogs before attempting layout change.
        // The observer is paused so it can't do this automatically — but dialogs
        // like "Other people may see your video differently" block the More Options
        // button with a scrim overlay.
        if (dialogObserver) {
          await dialogObserver.dismissVisibleDialogs()
        }
        if (await changeLayout(page, attempt, maxAttempts)) {
          console.log(`Layout change successful on attempt ${attempt}`)
          break
        }
        if (attempt < maxAttempts) {
          await page.waitForTimeout(300)
        }
      }
    } finally {
      SimpleDialogObserver.resume()
    }
  }

  void htmlSnapshot.captureSnapshot(page, "meet_join_meeting_success")
}

export async function findShowEveryOne(page: Page, click: boolean, cancelCheck: () => boolean) {
  let showEveryOneFound = false
  let inMeetingConfirmed = false

  while (!showEveryOneFound) {
    try {
      // Check if there's already a global error (bot removed, etc.)
      if (GLOBAL.getEndReason()) {
        console.log("Global error detected, stopping findShowEveryOne")
        return
      }

      // Check if we are actually in the meeting
      inMeetingConfirmed = await isInMeeting(page)
      if (inMeetingConfirmed) {
        console.log("Successfully confirmed we are in the meeting")
      }

      // Search for People button with multiple selectors (OLD + NEW Meet UI)
      const selectors = [
        // OLD UI selectors (pre-Dec 2025)
        'nav button[aria-label="People"][role="button"]',
        'nav button[aria-label="Show everyone"][role="button"]',
        'nav button[data-panel-id="1"][role="button"]',
        // NEW UI selectors (Dec 2025+) - Badge/hover tray style People button
        'div[role="button"][aria-haspopup="dialog"]:has(span:text("People"))'
      ]

      // Check each selector individually to log which ones match
      const matchedSelectors: string[] = []
      let totalCount = 0
      for (const selector of selectors) {
        const count = await page.locator(selector).count()
        if (count > 0) {
          matchedSelectors.push(selector)
          totalCount += count
          console.log(`  - Selector "${selector}" found ${count} element(s)`)
        }
      }

      const buttons = page.locator(selectors.join(", "))
      const count = await buttons.count()
      showEveryOneFound = totalCount > 0

      if (matchedSelectors.length > 0) {
        console.log(
          `[People Button] Found ${count} button(s) using ${matchedSelectors.length} selector(s): ${matchedSelectors.join(", ")}`
        )
      } else {
        console.log(`[People Button] No selectors matched (checked ${selectors.length} selectors)`)
      }

      if (showEveryOneFound && click) {
        try {
          const button = buttons.first()

          // Button may have opacity: 0 from HTML cleaner, but it's still clickable
          // Wait for button to be attached to DOM and clickable
          console.log("[People Button] Attempting to click button...")
          // Use evaluate to click the button because it may be invisible (explicitly set to opacity:0 in htmlCleaner) and hence button.click() won't work
          await button.evaluate((el: HTMLElement) => el.click())
          console.log("Successfully clicked People button")

          // Dismiss the hover dialog (new UI Dec 2025+)
          // The new badge-style People button shows a hover dialog that needs to be dismissed
          // Click on the page body to move focus away from the button
          await page.waitForTimeout(100) // Wait for dialog to appear
          await page.click("body", { position: { x: 10, y: 10 }, force: true })
          console.log("Clicked body to dismiss People hover dialog")
        } catch (e) {
          console.log("Failed to click People button:", formatError(e))
          showEveryOneFound = false
        }
      }

      // If we did not find the button but we are in the meeting,
      // on considère que c'est un succès (certaines réunions n'ont pas ce bouton)
      if (!showEveryOneFound && inMeetingConfirmed) {
        console.log("Meeting confirmed but People button not found - continuing anyway")
        return
      }

      if (cancelCheck()) {
        if (!GLOBAL.getEndReason()) {
          GLOBAL.setError(MeetingEndReason.TimeoutWaitingToStart)
        }
        throw new Error("Timeout waiting to start")
      }

      if (await notAcceptedInMeeting(page)) {
        console.log("Bot not accepted, exiting meeting")
        throw new Error("Bot not accepted into meeting")
      }

      if (!showEveryOneFound && !inMeetingConfirmed) {
        await sleep(1000)
      }
    } catch (error) {
      console.error("Error in findShowEveryOne:", error)
      await sleep(1000)
    }
  }
}

// New function to check if we are actually in the meeting
async function isInMeeting(page: Page): Promise<boolean> {
  try {
    // First check if we have been removed from the meeting (highest priority)
    if (await notAcceptedInMeeting(page)) {
      console.log("Bot has been removed from the meeting")
      return false
    }

    // Check for meeting presence indicators FIRST
    const result = await meetStateDetector.isInMeeting(page)
    const selectorCount = MEET_STATE_CONFIG.inMeetingPattern.selectors.length
    const threshold = MEET_STATE_CONFIG.inMeetingPattern.threshold
    console.log(
      `Meeting presence indicators: ${result.count}/${selectorCount} visible (threshold: ${threshold}, matched: ${result.matched})`
    )

    // If we have strong meeting indicators (threshold met), we're definitely in the meeting
    // This overrides any stale waiting room DOM elements that might still be present
    if (result.matched) {
      console.log(`✓ Threshold reached: ${result.count} >= ${threshold} - Confirming in meeting`)
      return true
    }

    // Only if meeting indicators are weak/absent, check if we're in waiting room
    // This prevents false positives from stale waiting room elements after joining
    if (await isInWaitingRoom(page)) {
      console.log("✗ Threshold not met but in waiting room - Not in meeting yet")
      return false
    }

    // Not enough meeting indicators and not in waiting room
    return false
  } catch (error) {
    console.error("Error checking if in meeting:", error)
    return false
  }
}

const CHAT_TEXTAREA_SELECTOR =
  'textarea[placeholder="Send a message"], textarea[aria-label="Send a message to everyone"]'

export async function sendEntryMessage(page: Page, enterMessage: string): Promise<boolean> {
  console.log("Attempting to send entry message...")
  const inMeeting = await isInMeeting(page)
  if (!inMeeting) {
    const waitingRoom = await isInWaitingRoom(page)
    const denied = await notAcceptedInMeeting(page)
    console.log(
      `Bot is no longer in the meeting, cannot send entry message. Diagnostics: waitingRoom=${waitingRoom}, denied=${denied}`
    )
    return false
  }

  const truncatedEnterMessage = enterMessage.substring(0, 500)
  try {
    console.log("Opening chat window with keyboard shortcut (Ctrl+Alt+c)...")
    await page.keyboard.press("Control+Alt+KeyC")
    await page.waitForTimeout(200)

    let chatOpened = false
    try {
      await page.waitForSelector(CHAT_TEXTAREA_SELECTOR, { state: "visible", timeout: 2000 })
      chatOpened = true
    } catch {
      console.log("Chat did not open with shortcut, trying button fallback...")
      const chatButton = page.locator(
        [
          'button[aria-label*="Chat"]',
          'button[aria-label*="chat"]',
          'button[title*="Chat"]',
          'button[title*="chat"]',
          'nav button[aria-label="Chat"][role="button"]',
          'div[role="button"][aria-label*="Chat"]'
        ].join(", ")
      )
      if ((await chatButton.count()) > 0) {
        await chatButton.first().evaluate((el: HTMLElement) => el.click())
        await page.waitForSelector(CHAT_TEXTAREA_SELECTOR, { state: "visible", timeout: 2000 })
        chatOpened = true
      }
    }

    if (!chatOpened || !(await isInMeeting(page))) {
      console.log("Bot is no longer in the meeting after opening chat")
      return false
    }

    const textarea = page.locator(CHAT_TEXTAREA_SELECTOR)
    await textarea.fill(truncatedEnterMessage, { timeout: ENTRY_MESSAGE_TIMEOUT })

    const sendButton = page.locator('button:has(i:text("send"))')
    if ((await sendButton.count()) > 0) {
      await sendButton.click({ timeout: ENTRY_MESSAGE_TIMEOUT })
      console.log("Clicked on send button")
      // Close the chat panel - use evaluate click since the button may be invisible (opacity:0 from HTML cleaner)
      try {
        const chatToggle = page.locator('button[aria-label="Chat with everyone"]')
        if ((await chatToggle.count()) > 0) {
          await chatToggle.first().evaluate((el: HTMLElement) => el.click())
          console.log("Closed chat panel")
        }
      } catch (e) {
        console.log("Failed to close chat panel (message was still sent):", formatError(e))
      }
      return true
    }
    console.log("Send button not found")
    return false
  } catch (error) {
    console.error("Failed to send entry message:", formatError(error))
    return false
  }
}

async function notAcceptedInMeeting(page: Page): Promise<boolean> {
  try {
    const result = await meetStateDetector.isDenied(page)
    if (result.matched && result.matchedText && result.pattern) {
      // Pattern is a DenialPattern
      const denialPattern = result.pattern as DenialPattern | SelectorPattern
      console.log(`${denialPattern.logPrefix} - Found text: "${result.matchedText}"`)
      GLOBAL.setError(
        denialPattern.reason,
        `${denialPattern.errorMessage} - Found text: "${result.matchedText}"`
      )

      // NEW: Set retry flag for specific Google Meet anti-bot error
      if (result.matchedText === "You can't join this video call") {
        GLOBAL.setShouldRetry(true)
        console.log("🔄 Google Meet anti-bot detection - marking for retry")
      }

      return true
    }

    return false
  } catch (error) {
    console.error("Error checking if denied entry:", error)
    return false
  }
}

async function clickDismiss(page: Page): Promise<boolean> {
  try {
    // Handle various transient modals/prompts that appear in the
    // waiting room, including the new "Sign in with your Google account"
    // modal whose primary action button text is "Got it".
    //
    // Note: SimpleDialogObserver also handles these, but this serves as a fallback
    // during the initial join flow before the observer is fully active.
    const dismissTexts = ["Dismiss", "Got it"]

    for (const text of dismissTexts) {
      const button = page
        .locator("button, div[role=button], span[role=button]")
        .filter({ hasText: text })
        .first()

      if ((await button.count()) === 0) {
        continue
      }

      const isVisible = await button.isVisible().catch(() => false)
      const isEnabled = await button.isEnabled().catch(() => false)

      if (isVisible && isEnabled) {
        await button.click()
        return true
      }
    }
    return false
  } catch (e) {
    console.error("[joinMeeting] meet find dismiss", e)
    return false
  }
}

async function clickWithInnerText(
  page: Page,
  selector: string,
  texts: string[],
  maxAttempts: number,
  shouldClick = true
): Promise<boolean> {
  console.log(`Attempting to find ${selector} with texts: ${texts.join(", ")}`)

  // First, take a screenshot to see what the page looks like
  for (let i = 0; i < maxAttempts; i++) {
    try {
      if (i === 0) {
        // Log visible buttons for debugging
        const visibleButtons = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('button, span[role="button"]'))
            .filter((el) => {
              const style = window.getComputedStyle(el)
              return (
                style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0"
              )
            })
            .map((el) => ({
              text: el.textContent?.trim(),
              role: el.getAttribute("role"),
              ariaLabel: el.getAttribute("aria-label")
            }))
        })
        console.log("Visible buttons:", JSON.stringify(visibleButtons, null, 2))
      }

      for (const text of texts) {
        console.log(`Attempt ${i + 1}/${maxAttempts} - Looking for "${text}" in ${selector}`)

        // Try multiple selector strategies
        const selectors = [
          `${selector}:has-text("${text}")`,
          `${selector}:text-is("${text}")`,
          `${selector}[aria-label*="${text}"]`,
          `button:has(${selector}:has-text("${text}"))`
        ]

        for (const sel of selectors) {
          const element = page.locator(sel)
          const count = await element.count()
          console.log(`  - Selector "${sel}" found ${count} elements`)

          if (count > 0) {
            console.log(`  - Found element with text "${text}" using selector "${sel}"`)
            if (shouldClick) {
              await element.click()
              console.log(`  - Clicked on element with text "${text}"`)
            }
            return true
          }
        }
      }
    } catch (e) {
      console.error(`Error in clickWithInnerText (attempt ${i + 1}/${maxAttempts}):`, e)
    }
    await page.waitForTimeout(100 + i * 100)
  }

  // Log all visible text on the page as a last resort
  console.log(
    "All visible text on page:",
    await page.evaluate(() => {
      return `${document.body.innerText.slice(0, 1000)}...`
    })
  )

  return false
}

/**
 * Checks if the bot is in the waiting room (waiting to be admitted)
 */
async function isInWaitingRoom(page: Page): Promise<boolean> {
  try {
    const result = await meetStateDetector.isWaitingRoom(page)
    if (result.matched) {
      console.log(`Waiting room detected: ${result.count} indicators found`)
      return true
    }
    return false
  } catch (_error) {
    return false
  }
}

async function clickJoinCtaIfPresent(page: Page): Promise<boolean> {
  // Try multiple selector strategies to find join button
  const joinSelectors = [
    // Text-based selectors
    'button:has-text("Ask to join")',
    'span:has-text("Ask to join")',
    'button:has-text("Join now")',
    'span:has-text("Join now")',
    'button:has-text("Join meeting")',
    'span:has-text("Join meeting")',
    'button:has-text("Join")',
    'span:has-text("Join")',
    'button:has-text("Enter meeting")',
    'span:has-text("Enter meeting")',
    // Aria-label based selectors (more stable)
    'button[aria-label*="Join"]',
    'button[aria-label*="join now"]',
    'button[aria-label*="Ask to join"]'
  ]

  try {
    // Press Escape first to close any modal that might be blocking
    await page.keyboard.press("Escape")
    await page.waitForTimeout(100)

    for (const selector of joinSelectors) {
      try {
        const locator = page.locator(selector).first()
        const count = await locator.count()
        if (count === 0) {
          continue
        }

        const isVisible = await locator.isVisible().catch(() => false)
        const isEnabled = await locator.isEnabled().catch(() => false)

        if (isVisible && isEnabled) {
          await locator.click({ timeout: 2000 })
          console.log(`Successfully clicked join button using selector: ${selector}`)
          return true
        }
      } catch (_e) {}
    }
  } catch (error) {
    console.error("Failed to click join CTA:", error)
  }
  return false
}

// Single-attempt layout change. Retry is owned by performCriticalSetupActions
// so that dialog dismissal runs between each attempt (see GH #131). The
// `attempt` parameter is passed in for logging only.
async function changeLayout(page: Page, attempt: number, maxAttempts: number): Promise<boolean> {
  console.log(`Starting layout change process (attempt ${attempt}/${maxAttempts})...`)

  try {
    const inMeeting = await isInMeeting(page)
    if (!inMeeting) {
      console.log("Bot is no longer in the meeting, stopping layout change")
      GLOBAL.setError(MeetingEndReason.BotRemoved, "Bot removed during layout change")
      return false
    }

    console.log("Looking for More options button in call controls...")
    const moreOptionsButton = page.locator(
      'div[role="region"][aria-label="Call controls"] button[aria-label="More options"]'
    )
    // Explicit click timeouts: the Playwright default is 30s, which is absurd
    // for a static call-controls button. If an overlay/scrim intercepts the
    // click, fail fast so the outer loop can recover in a useful amount of time.
    const CLICK_TIMEOUT_MS = 3000

    await moreOptionsButton.waitFor({ state: "visible", timeout: 3000 })
    await moreOptionsButton.click({ timeout: CLICK_TIMEOUT_MS })
    await page.waitForSelector('[role="menu"]', { state: "visible", timeout: 1000 })

    console.log("Looking for Change layout/Adjust view menu item...")
    const changeLayoutItem = page.locator(
      '[role="menu"] [role="menuitem"]:has(span:has-text("Change layout"), span:has-text("Adjust view"))'
    )
    await changeLayoutItem.waitFor({ state: "visible", timeout: 3000 })
    await changeLayoutItem.click({ timeout: CLICK_TIMEOUT_MS })
    await page.waitForSelector('label:has-text("Spotlight")', { state: "visible", timeout: 1000 })

    console.log("Looking for Spotlight option...")
    const spotlightOption = page
      .locator(
        [
          'label:has-text("Spotlight"):has(input[type="radio"])',
          'label:has(input[name="preferences"]):has-text("Spotlight")',
          'label:has(span:text-is("Spotlight"))'
        ].join(",")
      )
      .first()
    await spotlightOption.waitFor({ state: "visible", timeout: 3000 })
    await spotlightOption.click({ timeout: CLICK_TIMEOUT_MS })
    await page.waitForTimeout(300)

    await clickOutsideModal(page)
    return true
  } catch (error) {
    console.error(`Error in changeLayout attempt ${attempt}:`, formatError(error))

    // Close the Adjust view dialog if we managed to open it. Leaving it up blocks
    // the More options button on subsequent attempts (its scrim intercepts pointer
    // events — causing click timeouts) and the dialog observer can't dismiss it
    // afterwards because its Close button is icon-only.
    await closeAdjustViewDialogIfOpen(page)

    return false
  }
}

async function closeAdjustViewDialogIfOpen(page: Page): Promise<void> {
  try {
    // Meet's Adjust view dialog: aria-modal with an icon-only Close button.
    const closeBtn = page
      .locator('div[role="dialog"][aria-modal="true"] button[aria-label="Close" i]')
      .first()
    if ((await closeBtn.count()) > 0 && (await closeBtn.isVisible({ timeout: 200 }))) {
      console.log("Closing leftover Adjust view dialog via its Close button")
      await closeBtn.evaluate((el: HTMLElement) => el.click(), { timeout: 1000 })
      return
    }
  } catch (error) {
    // Fall through to mouse-click fallback
    console.warn("Close-button path failed, falling back to clickOutsideModal:", formatError(error))
  }
  try {
    await clickOutsideModal(page)
  } catch (error) {
    console.warn("clickOutsideModal fallback also failed:", formatError(error))
  }
}

async function clickOutsideModal(page: Page) {
  await sleep(500)
  await page.mouse.click(10, 10)
  await sleep(10)
  await page.mouse.click(10, 10)
  await sleep(10)
  await page.mouse.click(10, 10)
}

async function typeBotName(page: Page, botName: string): Promise<boolean> {
  const INPUT = "input[type=text]"
  const BotNameTyped = botName || "Bot"

  try {
    await page.waitForSelector(INPUT, { timeout: 1000 })

    // Effacer le champ de texte existant
    await page.fill(INPUT, "")

    // Taper le nouveau nom
    await page.fill(INPUT, BotNameTyped)

    // Check that the text has been properly entered
    const inputValue = await page.inputValue(INPUT)
    return inputValue.includes(BotNameTyped)
  } catch (e) {
    console.error("error in typeBotName", formatError(e))
    return false
  }
}

// --- Camera/Mic state detection and control ---
// Google Meet uses `data-is-muted="true"` on the toggle buttons and changes
// the aria-label between "Turn on …" / "Turn off …".  We use both attributes
// for reliable detection and keyboard shortcuts (Ctrl+E / Ctrl+D) as the
// primary toggle mechanism with a DOM-click fallback.

async function isCameraOff(page: Page): Promise<boolean> {
  const btn = page.locator('button[aria-label="Turn on camera"][data-is-muted="true"]')
  return (await btn.count()) > 0
}

async function isMicrophoneOff(page: Page): Promise<boolean> {
  const btn = page.locator('button[aria-label="Turn on microphone"][data-is-muted="true"]')
  return (await btn.count()) > 0
}

async function toggleCameraWithShortcut(page: Page): Promise<void> {
  await page.keyboard.press("Control+KeyE")
}

async function toggleMicrophoneWithShortcut(page: Page): Promise<void> {
  await page.keyboard.press("Control+KeyD")
}

async function ensureCameraOn(page: Page): Promise<void> {
  try {
    if (!(await isCameraOff(page))) return // already on
    console.log("[Meet] Camera is off, enabling via keyboard shortcut (Ctrl+E)...")
    await toggleCameraWithShortcut(page)
    console.log("[Meet] Camera enable shortcut sent")
  } catch (error) {
    console.error("[Meet] Failed to enable camera via shortcut, trying DOM click:", error)
    const btn = page.locator('button[aria-label="Turn on camera"]')
    if ((await btn.count()) > 0) await btn.click()
  }
}

async function ensureCameraOff(page: Page): Promise<void> {
  try {
    if (await isCameraOff(page)) return // already off
    console.log("[Meet] Camera is on, disabling via keyboard shortcut (Ctrl+E)...")
    await toggleCameraWithShortcut(page)
    console.log("[Meet] Camera disable shortcut sent")
  } catch (error) {
    console.error("[Meet] Failed to disable camera via shortcut, trying DOM click:", error)
    const btn = page.locator('button[aria-label="Turn off camera"]')
    if ((await btn.count()) > 0) await btn.click()
  }
}

async function ensureMicrophoneOn(page: Page): Promise<void> {
  try {
    if (!(await isMicrophoneOff(page))) return // already on
    console.log("[Meet] Microphone is off, enabling via keyboard shortcut (Ctrl+D)...")
    await toggleMicrophoneWithShortcut(page)
    console.log("[Meet] Microphone enable shortcut sent")
  } catch (error) {
    console.error("[Meet] Failed to enable mic via shortcut, trying DOM click:", error)
    const btn = page.locator('button[aria-label="Turn on microphone"]')
    if ((await btn.count()) > 0) await btn.click()
  }
}

async function ensureMicrophoneOff(page: Page): Promise<void> {
  try {
    if (await isMicrophoneOff(page)) return // already off
    console.log("[Meet] Microphone is on, disabling via keyboard shortcut (Ctrl+D)...")
    await toggleMicrophoneWithShortcut(page)
    console.log("[Meet] Microphone disable shortcut sent")
  } catch (error) {
    console.error("[Meet] Failed to disable mic via shortcut, trying DOM click:", error)
    const btn = page.locator('button[aria-label="Turn off microphone"]')
    if ((await btn.count()) > 0) await btn.click()
  }
}

// --- Pre-join lobby helpers (DOM click on div elements) ---
// The pre-join/lobby page uses div[aria-label="..."] elements, not button[data-is-muted].
// These are kept separate from the in-meeting ensure* functions above.

async function activateMicrophone(page: Page): Promise<boolean> {
  console.log("Activating microphone...")
  try {
    const microphoneButton = page.locator('div[aria-label="Turn on microphone"]')
    if ((await microphoneButton.count()) > 0) {
      await microphoneButton.click()
      console.log("Microphone activated successfully")
      return true
    }
    console.log("Microphone is already active or button not found")
    return false
  } catch (error) {
    console.error("Error activating microphone:", error)
    return false
  }
}

async function deactivateMicrophone(page: Page): Promise<boolean> {
  console.log("Deactivating microphone...")
  try {
    const microphoneButton = page.locator('div[aria-label="Turn off microphone"]')
    if ((await microphoneButton.count()) > 0) {
      await microphoneButton.click()
      console.log("Microphone deactivated successfully")
      return true
    }
    console.log("Microphone is already deactivated or button not found")
    return false
  } catch (error) {
    console.error("Error deactivating microphone:", error)
    return false
  }
}

async function deactivateCamera(page: Page): Promise<boolean> {
  console.log("Deactivating camera...")
  try {
    const cameraButton = page.locator('div[aria-label="Turn off camera"]')
    if ((await cameraButton.count()) > 0) {
      await cameraButton.click()
      console.log("Camera deactivated successfully")
      return true
    }
    console.log("Camera is already deactivated or button not found")
    return false
  } catch (error) {
    console.error("Error deactivating camera:", error)
    return false
  }
}

// async function MuteMicrophone(page: Page) {
//     try {
//         await page.evaluate(() => {
//             const tryClickMicrophone = () => {
//                 const microphoneButtons = Array.from(
//                     document.querySelectorAll('div'),
//                 ).filter(
//                     (el) =>
//                         el.getAttribute('aria-label') &&
//                         el
//                             .getAttribute('aria-label')
//                             .includes('Turn off microphone'),
//                 )

//                 if (microphoneButtons.length > 0) {
//                     microphoneButtons.forEach((button) => button.click())
//                     console.log(
//                         `${microphoneButtons.length} microphone button(s) turned off.`,
//                     )
//                 } else {
//                     console.log('No microphone button found. Retrying...')
//                     setTimeout(tryClickMicrophone, 1000)
//                 }
//             }

//             tryClickMicrophone()
//         })
//     } catch (e) {
//         console.error('Error when trying to turn off the microphone:', e)
//     }
// }
