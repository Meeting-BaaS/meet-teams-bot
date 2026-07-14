import type { BrowserContext, Page } from "@playwright/test"
import { envVars } from "../config/env-vars"
import { listenPage } from "../browser/page-logger"
import { HtmlSnapshotService } from "../services/html-snapshot-service"
import { GLOBAL } from "../singleton"
import { MeetingEndReason } from "../state-machine/types"
import type { MeetingProviderInterface } from "../types"
import { buildZoomWebClientUrl, parseZoomMeetingUrl } from "../urlParser/zoomUrlParser"
import { formatError } from "../utils/Logger"
import { createStateDetector } from "../utils/meeting-state-detector"
import { sleep } from "../utils/sleep"
import { ZOOM_STATE_CONFIG } from "./zoom-state-config"

// Zoom Web Client selectors (ported from vexa join/zoom/selectors.ts — verified
// against the live DOM). Two client variants co-exist and Zoom picks per-meeting:
//   React client  (app.zoom.us/wc/<id>/join):  #input-for-name, .preview-join-button
//   Classic client(app.zoom.us/wc/join/<id>):  #inputname,       #joinBtn
const NAME_INPUT = '#input-for-name, #inputname, input[placeholder="Your Name" i]'
const JOIN_BUTTON = "button.preview-join-button, #joinBtn"
const PREVIEW_MUTE = "#preview-audio-control-button"
const PREVIEW_VIDEO = "#preview-video-control-button"
const LEAVE_BUTTON = 'button[aria-label="Leave"]'
const LEAVE_CONFIRM = "button.leave-meeting-options__btn--danger"
const PERMISSION_DISMISS = 'button:has-text("Continue without microphone and camera")'
const PASSCODE_INPUT =
  'input[placeholder*="passcode" i], input[placeholder*="password" i], input[type="password"]'

// Post-Join anti-bot wall phrases — scanned case-insensitively against body text.
//
// Deliberately does NOT include "sign in to join". That phrase appears both on
// the anti-bot wall AND on an ordinary auth-required meeting, and matching it
// here would report every login-gated meeting as ZoomRequiresRtms. That metric
// is exactly what decides whether browser Zoom is viable at all, so polluting it
// would corrupt the decision. Auth-required is already classified correctly as
// LoginRequired by ZOOM_STATE_CONFIG.denialPatterns.
const BOT_BLOCK_TEXTS = [
  "automated bots aren't allowed",
  "automated bots aren’t allowed",
  "must use zoom rtms",
  "detected you may be a bot"
]

const HOST_NOT_STARTED_RETRY_MS = 15_000
const HOST_NOT_STARTED_MAX_WAIT_MS = 10 * 60 * 1000

// Removal debounce. Zoom auto-hides the footer that holds the Leave button, and
// recording-state ends the meeting on a single findEndMeeting()===true, so a
// bare "Leave button missing" check would eject the bot from a live meeting on
// any transient repaint.
const LEAVE_MISS_THRESHOLD = 3
const LEAVE_GRACE_MS = 20_000

const zoomStateDetector = createStateDetector(ZOOM_STATE_CONFIG)

export class ZoomProvider implements MeetingProviderInterface {
  // Cached from getMeetingLink so joinMeeting can fill a passcode field if one
  // renders despite the ?pwd= in the URL.
  private passcode = ""
  // Removal debounce state (see findEndMeeting).
  private leaveButtonMisses = 0
  private inMeetingSince: number | null = null

  async parseMeetingUrl(meeting_url: string) {
    return parseZoomMeetingUrl(meeting_url)
  }

  getMeetingLink(
    meeting_id: string,
    password: string,
    _role: number,
    _bot_name: string,
    _enter_message?: string
  ): string {
    this.passcode = password || ""
    // meeting_id here is what parseMeetingUrl returned: a numeric id for
    // canonical hosts, or the raw URL for white-label portals.
    const seed = /^\d+$/.test(meeting_id)
      ? `https://zoom.us/j/${meeting_id}${password ? `?pwd=${password}` : ""}`
      : meeting_id
    return buildZoomWebClientUrl(seed, password)
  }

  async openMeetingPage(
    browserContext: BrowserContext,
    link: string,
    _streaming_input: string | undefined
  ): Promise<Page> {
    const page = await browserContext.newPage()
    page.setDefaultTimeout(30_000)
    page.setDefaultNavigationTimeout(60_000)

    // Pin the viewport to the exact ffmpeg capture size. The page provably
    // renders full-width (single-main-container__video-frame = 1280x720, right
    // rail collapsed to 0px), so the black band on the right is the *viewport*
    // being narrower than the fixed 1280-wide x11grab capture — CloakBrowser's
    // humanize mode can randomize the viewport for anti-fingerprinting. Re-assert
    // the intended size so Zoom's video fills the whole recorded frame.
    try {
      const width = envVars.RESOLUTION === "1080" ? 1920 : 1280
      const height = envVars.RESOLUTION === "1080" ? 1080 : 720
      await page.setViewportSize({ width, height })
      console.log(`[Zoom] Viewport pinned to ${width}x${height} to match capture`)
    } catch (e) {
      console.warn("[Zoom] Failed to pin viewport size:", formatError(e))
    }

    // Forward in-page console output to the bot log. Without this every
    // console.log inside page.evaluate() — including the speaker observer's
    // selector forensics — is silently discarded, which is exactly how the
    // stale-diarization dump went missing on the first live run.
    listenPage(page)

    try {
      await browserContext.grantPermissions(["microphone", "camera"], {
        origin: new URL(link).origin
      })
    } catch (e) {
      console.warn("[Zoom] grantPermissions failed (continuing):", formatError(e))
    }

    // Host-not-started retry loop: before the host starts, Zoom serves
    // title="Error - Zoom" + "This meeting link is invalid (3,001)". Poll until
    // the pre-join page renders (or the auth wall / anti-bot wall appears).
    const startTime = Date.now()
    while (true) {
      try {
        await page.goto(link, { waitUntil: "domcontentloaded", timeout: 60_000 })
        // Clear the retry flag once navigation succeeds. Leaving it set is a
        // real bug: shouldAttemptRetry() only looks at the flag + count, not at
        // WHICH failure set it — so one flaky goto followed by a deliberately
        // NON-retryable terminal failure (the RTMS wall, BotRemoved) would
        // requeue the job, send a second bot into the same wall, and double-count
        // the wall in our metrics.
        GLOBAL.setShouldRetry(false)
      } catch (e) {
        console.warn("[Zoom] goto failed, will retry:", formatError(e))
        GLOBAL.setShouldRetry(true)
      }
      await sleep(2000)

      // Auth-required fail-fast: the sign-in page never renders #input-for-name,
      // so without this the bot waits the full name-input timeout for a field
      // that never appears. isDenied maps the matched text to the end reason.
      const denied = await zoomStateDetector.isDenied(page)
      if (denied.matched) {
        const reason =
          (denied.pattern && "reason" in denied.pattern ? denied.pattern.reason : undefined) ??
          MeetingEndReason.BotNotAccepted
        console.log(`[Zoom] Denial on pre-join: "${denied.matchedText}" -> ${reason}`)
        GLOBAL.setError(reason)
        // ZoomRequiresRtms / LoginRequired are NOT retryable on the same meeting.
        throw new Error(`Zoom pre-join denial: ${reason}`)
      }

      const title = await page.title().catch(() => "")
      const isHostNotStarted = title === "Error - Zoom" || title === "error - Zoom"
      if (!isHostNotStarted) break

      if (Date.now() - startTime >= HOST_NOT_STARTED_MAX_WAIT_MS) {
        GLOBAL.setError(MeetingEndReason.TimeoutWaitingToStart)
        throw new Error("[Zoom] Host did not start the meeting within the wait timeout")
      }
      console.log(
        `[Zoom] Host not started (title="${title}"). Retrying in ${HOST_NOT_STARTED_RETRY_MS / 1000}s`
      )
      await sleep(HOST_NOT_STARTED_RETRY_MS)
    }

    return page
  }

  async joinMeeting(
    page: Page,
    cancelCheck: () => boolean,
    onJoinSuccess: () => void
  ): Promise<void> {
    const htmlSnapshot = HtmlSnapshotService.getInstance()
    await htmlSnapshot.captureSnapshot(page, "zoom_join_meeting_start")

    // Dismiss OneTrust cookie banner. On the CLASSIC client it overlays the
    // pre-join card and intercepts pointer events, so the name input can't be
    // focused and Join never enables. No-op on the React client.
    for (const otSel of ["#onetrust-accept-btn-handler", "#onetrust-reject-all-handler"]) {
      try {
        const btn = page.locator(otSel).first()
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click()
          console.log(`[Zoom] Dismissed cookie banner (${otSel})`)
          await sleep(400)
          break
        }
      } catch {
        /* no banner */
      }
    }

    // Media-permission dialog(s): Zoom shows "Allow" up to twice (camera+mic,
    // then mic-only). The bot MUST click Allow to join the audio channel — else
    // Zoom never creates <audio> elements for participants and PulseAudio
    // capture gets silence. The bot mutes its own mic in preview below.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const allowBtn = page.locator('button:has-text("Allow")').first()
        if (await allowBtn.isVisible({ timeout: 4000 })) {
          await allowBtn.click()
          console.log(`[Zoom] Granted media permission (attempt ${attempt + 1})`)
          await sleep(600)
          continue
        }
        const dismissBtn = page.locator(PERMISSION_DISMISS).first()
        if (await dismissBtn.isVisible({ timeout: 1000 })) {
          console.warn("[Zoom] No Allow button — dismissing; audio capture may fail")
          await dismissBtn.click()
          await sleep(600)
        } else {
          break
        }
      } catch {
        break
      }
    }

    if (cancelCheck()) {
      GLOBAL.setError(MeetingEndReason.ExitingMeetingBeforeRecord)
      throw new Error("Bot stopped before joining Zoom meeting")
    }

    // Wait for the pre-join name input.
    try {
      await page.waitForSelector(NAME_INPUT, { timeout: 30_000 })
    } catch {
      // The wall can render here instead of a name field — check before failing.
      const wall = await this.detectBotWall(page)
      if (wall) {
        GLOBAL.setError(MeetingEndReason.ZoomRequiresRtms)
        throw new Error(`[Zoom] zoom_requires_rtms: ${wall}`)
      }
      GLOBAL.setError(MeetingEndReason.CannotJoinMeeting)
      throw new Error("[Zoom] Pre-join name input never appeared")
    }

    // Passcode: usually auto-applied from ?pwd= in the URL. If a passcode field
    // is still visible, fill from the cached value, else fail fast (Join would
    // stay disabled forever).
    const passField = page.locator(PASSCODE_INPUT).first()
    if (await passField.isVisible({ timeout: 1000 }).catch(() => false)) {
      if (this.passcode) {
        await passField.fill(this.passcode)
        console.log("[Zoom] Filled passcode field")
      } else {
        GLOBAL.setError(MeetingEndReason.ZoomPasscodeRequired)
        throw new Error("[Zoom] zoom_passcode_required: passcode field present, none supplied")
      }
    }

    // Name entry via REAL keyboard events. A synthetic setter/input event does
    // NOT satisfy Zoom's React form validation — the Join button stays disabled
    // (class "...preview-join-button disabled...") and a Playwright click times
    // out on `.preview-meeting-info intercepts pointer events`. focus+type
    // drives Zoom's full validation pipeline and enables Join.
    const botName = GLOBAL.get().bot_name
    await page.locator(NAME_INPUT).first().click({ timeout: 5000 }).catch(() => {})
    await page.locator(NAME_INPUT).first().fill("")
    await page.keyboard.type(botName, { delay: 30 })
    console.log(`[Zoom] Name typed: "${botName}"`)

    // Before waiting on Join, detect the human-gated walls (reCAPTCHA on the
    // classic client, or the sign-in / anti-bot wall). These cannot be cleared
    // by automation — fail fast rather than holding the browser.
    const wall = await this.detectBotWall(page)
    if (wall) {
      GLOBAL.setError(MeetingEndReason.ZoomRequiresRtms)
      throw new Error(`[Zoom] zoom_requires_rtms: ${wall}`)
    }

    // Wait for Join to enable (React enables within ~1-2s of valid name).
    await page
      .waitForFunction(
        (sel: string) => {
          const btn = document.querySelector(sel) as HTMLButtonElement | null
          return !!btn && !btn.classList.contains("disabled") && !btn.disabled
        },
        JOIN_BUTTON,
        { timeout: 8000 }
      )
      .catch(() => console.warn("[Zoom] Join still disabled after wait; attempting click anyway"))

    // Mic: a recorder bot only RECEIVES audio, so mute it. But a bot with
    // streaming_input speaks INTO the meeting (its audio is pumped to the
    // virtual mic) — muting that bot means nobody ever hears it, which is how
    // Meet/Teams gate this too. Only mute when we have no input stream.
    const hasStreamingInput = !!GLOBAL.get().streaming_input
    try {
      const muteBtn = page.locator(PREVIEW_MUTE)
      const label = await muteBtn.getAttribute("aria-label")
      if (!hasStreamingInput && label === "Mute") {
        await muteBtn.click()
        console.log("[Zoom] Muted mic in preview (receive-only recorder bot)")
      } else if (hasStreamingInput && label === "Unmute") {
        await muteBtn.click()
        console.log("[Zoom] Unmuted mic in preview (streaming_input — bot speaks)")
      }
    } catch {
      /* not present */
    }
    // Stop video in preview.
    try {
      const videoBtn = page.locator(PREVIEW_VIDEO)
      if ((await videoBtn.getAttribute("aria-label")) === "Stop Video") {
        await videoBtn.click()
        console.log("[Zoom] Stopped video in preview")
      }
    } catch {
      /* already off / not present */
    }

    if (cancelCheck()) {
      GLOBAL.setError(MeetingEndReason.ExitingMeetingBeforeRecord)
      throw new Error("Bot stopped before clicking Join")
    }

    // Click Join through Playwright, NOT via a DOM .click().
    //
    // This is the most bot-scrutinised action in the whole flow, and an in-page
    // `element.click()` is a free tell: the MouseEvent it produces has
    // isTrusted === false, which any anti-bot layer can read in one line.
    // Playwright dispatches through CDP, so the event is genuinely trusted
    // (isTrusted === true) AND it routes through CloakBrowser's humanize patches
    // (real mouse movement, human timing) — the same reason teams.ts prefers a
    // humanized click and treats a raw DOM click as making "the join look
    // robotic".
    //
    // `force: true` is what lets us keep the trusted path: it skips Playwright's
    // actionability/hit-test checks — which is why we reached for a DOM click in
    // the first place, since `.preview-meeting-info` overlays the button and
    // intercepts pointer events — while still sending real input.
    //
    // The DOM click stays ONLY as a last-resort fallback, matching Teams.
    console.log("[Zoom] Clicking Join (Playwright, trusted + humanized)...")
    let clicked = false
    try {
      await page.locator(JOIN_BUTTON).first().click({ force: true, timeout: 10_000 })
      clicked = true
    } catch (e) {
      console.warn("[Zoom] Humanized Join click failed, falling back to DOM click:", formatError(e))
    }
    if (!clicked) {
      await page
        .evaluate((sel: string) => {
          const btn = document.querySelector(sel) as HTMLButtonElement | null
          if (!btn || btn.classList.contains("disabled") || btn.disabled) return false
          btn.click()
          return true
        }, JOIN_BUTTON)
        .catch(() => false)
    }
    console.log("[Zoom] Join clicked — waiting for admission...")
    await sleep(3000)

    await this.waitForAdmission(page, cancelCheck)

    onJoinSuccess()
    console.log("[Zoom] ✅ onJoinSuccess called")
    await htmlSnapshot.captureSnapshot(page, "zoom_join_meeting_success")
  }

  /**
   * Poll until the bot is admitted (Leave button visible) or a terminal state
   * appears. The waiting-room text check runs BEFORE the in-meeting check
   * because Zoom renders the waiting room inside `.meeting-app` and the bot's
   * own mic-preview audio stays live across the transition — either would
   * false-positive as "admitted" (observed vexa meeting_id=36).
   */
  private async waitForAdmission(page: Page, cancelCheck: () => boolean): Promise<void> {
    const timeoutMs = (GLOBAL.get().waiting_room_timeout ?? 600) * 1000
    const start = Date.now()

    while (Date.now() - start < timeoutMs) {
      if (cancelCheck()) {
        if (!GLOBAL.getEndReason()) GLOBAL.setError(MeetingEndReason.ApiRequest)
        throw new Error("API request to stop Zoom recording")
      }

      // Terminal anti-bot wall — can stream in a beat after Join. Non-retryable.
      const wall = await this.detectBotWall(page)
      if (wall) {
        GLOBAL.setError(MeetingEndReason.ZoomRequiresRtms)
        throw new Error(`[Zoom] zoom_requires_rtms: ${wall}`)
      }

      // Rejected / meeting ended.
      const denied = await zoomStateDetector.isDenied(page)
      if (denied.matched) {
        const reason =
          (denied.pattern && "reason" in denied.pattern ? denied.pattern.reason : undefined) ??
          MeetingEndReason.BotNotAccepted
        GLOBAL.setError(reason)
        throw new Error(`[Zoom] Rejected during admission: ${reason}`)
      }

      // Waiting room first (see method doc).
      const waiting = await zoomStateDetector.isWaitingRoom(page)
      if (!waiting.matched) {
        const inMeeting = await zoomStateDetector.isInMeeting(page)
        if (inMeeting.matched) {
          console.log("[Zoom] Admitted — Leave button visible")
          return
        }
      }

      console.log(`[Zoom] Waiting for admission... ${Math.round((Date.now() - start) / 1000)}s`)
      await sleep(2000)
    }

    GLOBAL.setError(MeetingEndReason.TimeoutWaitingToStart)
    throw new Error(`[Zoom] Not admitted within ${timeoutMs}ms`)
  }

  private async detectBotWall(page: Page): Promise<string | null> {
    try {
      return await page.evaluate((phrases: string[]) => {
        const body = (document.body?.innerText || "").toLowerCase()
        for (const p of phrases) if (body.includes(p)) return p
        return null
      }, BOT_BLOCK_TEXTS)
    } catch {
      return null
    }
  }

  async findEndMeeting(page: Page, _opts?: { ignoreAloneSignals?: boolean }): Promise<boolean> {
    // Page freeze → meeting almost certainly ended (mirrors Meet/Teams).
    try {
      await Promise.race([
        page.evaluate(() => document.readyState),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("freeze")), 20_000)
        )
      ])
    } catch {
      console.log("[Zoom] Page frozen 20s — meeting likely ended")
      return true
    }

    // URL left the meeting (sign-in / non-meeting /wc/ / off-domain).
    const url = page.url()
    const offZoom =
      !!url &&
      !url.startsWith("about:") &&
      !/zoom\.(us|com|eu|com\.cn|com\.br|com\.au|de|fr|jp|ca|co\.uk)\b/.test(url)
    if (offZoom || url.includes("/signin") || url.includes("/login")) {
      console.log(`[Zoom] Navigated away from meeting: ${url}`)
      return true
    }

    // Removal / meeting-ended modal text.
    const denied = await zoomStateDetector.isDenied(page)
    if (denied.matched) {
      console.log(`[Zoom] End detected: "${denied.matchedText}"`)
      return true
    }

    // Leave button gone → probably removed. But recording-state ends the meeting
    // on a SINGLE true (`if (botRemovedResult) return getBotRemovedReason()`),
    // and Zoom AUTO-HIDES its footer toolbar — so one transient repaint would
    // make the bot declare itself removed and abandon a live meeting.
    // Require N consecutive misses, and ignore misses during the post-join
    // window while Zoom's audio-init redirects settle. (vexa's removal monitor
    // carried the same two guards; they were lost when its polling loop was
    // collapsed into this one-shot check.)
    const leaveVisible = await page
      .locator(LEAVE_BUTTON)
      .first()
      .isVisible({ timeout: 300 })
      .catch(() => false)

    if (leaveVisible) {
      this.leaveButtonMisses = 0
      if (this.inMeetingSince === null) this.inMeetingSince = Date.now()
      return false
    }

    // Never trust a miss before we've confirmed the footer once, or during the
    // grace window right after it appeared.
    if (
      this.inMeetingSince === null ||
      Date.now() - this.inMeetingSince < LEAVE_GRACE_MS
    ) {
      return false
    }

    this.leaveButtonMisses++
    if (this.leaveButtonMisses < LEAVE_MISS_THRESHOLD) {
      console.log(
        `[Zoom] Leave button miss ${this.leaveButtonMisses}/${LEAVE_MISS_THRESHOLD} — not treating as removal yet`
      )
      return false
    }
    console.log(`[Zoom] Leave button gone ${this.leaveButtonMisses}x — treating as removal`)
    return true
  }

  async closeMeeting(page: Page): Promise<void> {
    console.log("[Zoom] Leaving meeting")
    // Click via the DOM, not Playwright: HtmlCleaner sets the footer to
    // opacity:0, and Playwright's actionability check refuses to click an
    // element it considers invisible — so locator.click() would stall until
    // timeout on every normal exit. A DOM .click() fires the React handler
    // regardless. Meet does the same thing for the same reason.
    const domClick = (sel: string) =>
      page.evaluate((s: string) => {
        const btn = document.querySelector(s) as HTMLElement | null
        if (!btn) return false
        btn.click()
        return true
      }, sel)

    // Whole sequence is bounded: cleanup must not hang if Zoom's UI wedges.
    await Promise.race([
      (async () => {
        try {
          if (await domClick(LEAVE_BUTTON)) {
            // Confirm dialog: "Leave Meeting" danger button (aria-label is
            // empty, so it can only be matched on its class).
            await sleep(500)
            await domClick(LEAVE_CONFIRM)
            console.log("[Zoom] Left meeting")
            return
          }
          console.log("[Zoom] Leave button not found — navigating to about:blank")
          await page.goto("about:blank").catch(() => {})
        } catch (error) {
          console.error("[Zoom] Error leaving meeting:", formatError(error))
        }
      })(),
      sleep(5000)
    ])
  }
}
