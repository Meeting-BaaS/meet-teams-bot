import type { Page } from "@playwright/test"
import type { RecordingMode, SpeakerData } from "../../types"
import { SoundLevelMonitor } from "../../utils/sound-level-monitor"

// Audio level above which we treat the active tile as speaking. Deliberately
// lower than recording-state's SOUND_LEVEL_ACTIVITY_THRESHOLD (5) so quieter
// speech still flips isSpeaking; this only affects the observer's label, not the
// silence/meeting-end logic.
const SOUND_ACTIVITY_THRESHOLD = 2

declare global {
  interface Window {
    zoomObserverCleanup?: () => void
    zoomSpeakersChanged?: (speakers: SpeakerData[]) => void
    zoomSpeakerForensics?: (report: string) => void
  }
}

/**
 * Zoom Web speaker attribution — TEMPORAL, DOM-based. The Zoom Web client exposes
 * only a mixed audio stream, so attribution reads who Zoom currently renders as
 * the active speaker and labels the mixed audio by timestamp (active-speaker
 * containers + avatar footer, 250ms poll, 2-poll debounce, 2s heartbeat). Emits
 * SpeakerData[] over the exposeFunction bridge.
 *
 * Limitation: temporal attribution can't separate overlapping speakers — whoever
 * Zoom lights up wins the turn.
 */
export class ZoomSpeakersObserver {
  private page: Page
  private recordingMode: RecordingMode
  private botName: string
  private onSpeakersChange: (speakers: SpeakerData[]) => void
  private isObserving = false

  // 100ms poll x 2-poll confirm = ~200ms to switch the active speaker (was
  // ~500ms at 250ms). Tighter boundary = the next speaker's first words are no
  // longer bled onto the previous speaker's segment. Audio-gating still filters
  // non-speech, so the faster poll doesn't add spurious turns.
  private readonly POLL_MS = 100
  private readonly CONFIRM_POLLS = 2
  private readonly HEARTBEAT_MS = 2000

  // Fast audio re-gating: the in-page observer only re-emits ~every HEARTBEAT_MS,
  // which made isSpeaking lag speech by up to ~2s. We cache the last roster from
  // the page and re-evaluate isSpeaking against the live audio level on a fast
  // timer, re-emitting only when the speaking state flips (so the log isn't spammed).
  private lastSpeakers: SpeakerData[] = []
  private lastSpeaking = false
  private soundGateTimer: NodeJS.Timeout | null = null
  private readonly SOUND_GATE_MS = 250

  constructor(
    page: Page,
    recordingMode: RecordingMode,
    botName: string,
    onSpeakersChange: (speakers: SpeakerData[]) => void
  ) {
    this.page = page
    this.recordingMode = recordingMode
    this.botName = botName
    this.onSpeakersChange = onSpeakersChange
  }

  public async startObserving(): Promise<void> {
    if (this.isObserving) {
      console.warn("[Zoom] Already observing speakers")
      return
    }
    console.log("[Zoom] Starting speaker observation (temporal DOM)...")

    await this.page.exposeFunction("zoomSpeakersChanged", (speakers: SpeakerData[]) => {
      try {
        this.lastSpeakers = speakers
        this.emitGated(speakers)
      } catch (error) {
        console.error("[Zoom] Error in speakers callback:", error)
      }
    })

    // Fast audio re-gate: the page emits ~every 2s, so without this isSpeaking
    // lagged speech by seconds. Poll the live audio level quickly and re-emit the
    // cached roster the instant speech starts or stops (only on a flip → no spam).
    this.soundGateTimer = setInterval(() => {
      if (this.lastSpeakers.length === 0) return
      const level = SoundLevelMonitor.peekInstance()?.getCurrentSoundLevel() ?? 0
      const speaking = level > SOUND_ACTIVITY_THRESHOLD
      if (speaking !== this.lastSpeaking) {
        this.emitGated(this.lastSpeakers)
      }
    }, this.SOUND_GATE_MS)

    // Forensics come back over the exposeFunction bridge, NOT page console:
    // page-logger only forwards page console when LOG_LEVEL=debug, so an
    // in-page console.log here is dropped in normal runs — which is precisely
    // how the first stale-selector dump went missing.
    await this.page.exposeFunction("zoomSpeakerForensics", (report: string) => {
      console.debug(`[Zoom-Speakers] FORENSICS (active-speaker selectors matched nothing): ${report}`)
    })

    await this.page.evaluate(
      ({ selfName, pollMs, confirmPolls, heartbeatMs }) => {
        const ACTIVE_CONTAINER_SELECTORS = [
          ".speaker-active-container__video-frame",
          ".speaker-bar-container__video-frame--active",
          // Speaker-view main tile — Zoom's active-speaker pick (stays valid during
          // a share; the shared screen is a separate .sharee-container__canvas).
          ".single-main-container__video-frame",
          // "Suspension" container Zoom swaps in for some layouts (e.g. camera off).
          // The selfName check filters the bot's own tile, so this is safe.
          ".single-suspension-container__video-frame",
          ".gallery-video-container__video-frame--active"
        ]
        const NAME_FOOTER_SELECTOR = ".video-avatar__avatar-footer"

        let active: string | null = null
        let candidate: string | null = null
        let candidateCount = 0
        const heartbeatPolls = Math.max(1, Math.round(heartbeatMs / pollMs))
        let sinceEmit = 0

        function nameFromContainer(container: Element | null): string | null {
          if (!container) return null
          const footer = container.querySelector(NAME_FOOTER_SELECTOR)
          if (!footer) return null
          const span = footer.querySelector("span")
          const raw =
            (span?.textContent?.trim() || (footer as HTMLElement).innerText?.trim()) || ""
          const t = raw.replace(/\s+/g, " ").trim()
          return t || null
        }

        // No screen-share special-casing: the main tile still holds the active
        // speaker during a share. Multi-speaker attribution under a degenerate
        // one-tile UI is handled by the downstream provider-diarization fallback.
        let reportedSelector: string | null = null
        function readActiveSpeaker(): string | null {
          for (const sel of ACTIVE_CONTAINER_SELECTORS) {
            const name = nameFromContainer(document.querySelector(sel))
            if (name) {
              // Log which selector won, once (no name — privacy).
              if (reportedSelector !== sel) {
                reportedSelector = sel
                try {
                  window.zoomSpeakerForensics?.(`RESOLVED via "${sel}"`)
                } catch {
                  /* bridge unavailable */
                }
              }
              // Never report the bot itself as the remote speaker.
              if (selfName && name.toLowerCase() === selfName.toLowerCase()) return null
              return name
            }
          }
          return null
        }

        // Full roster from the participants panel. The panel is opened but forced
        // OFF-SCREEN and out of flow by the html cleaner (position:fixed;
        // left:-100000px; opacity:0), so it never appears in the recording and the
        // video keeps the full frame — while its text stays readable here.
        const ROSTER_NAME_SELECTORS = [
          ".participants-item__display-name",
          '[class*="participants-item"] [class*="display-name"]',
          '[class*="participants-li"] [class*="display-name"]',
          '#participants-ul [class*="display-name"]',
          '[class*="participants-item"] [class*="name"]'
        ]
        let rosterReported = false

        function openParticipantsPanel(): void {
          try {
            const btn = document.querySelector(
              'button[aria-label*="open the participants list pane"]'
            ) as HTMLElement | null
            if (btn) btn.click()
          } catch {
            /* ignore */
          }
        }

        function readRoster(): string[] {
          const names: string[] = []
          const seen = new Set<string>()
          for (const sel of ROSTER_NAME_SELECTORS) {
            const els = document.querySelectorAll(sel)
            if (els.length === 0) continue
            els.forEach((el) => {
              const raw = ((el as HTMLElement).innerText || el.textContent || "")
                .replace(/\s+/g, " ")
                .trim()
              const nm = raw.replace(/\s*\((host|guest|me|co-host)[^)]*\)\s*/gi, "").trim()
              if (nm && !seen.has(nm.toLowerCase())) {
                seen.add(nm.toLowerCase())
                names.push(nm)
              }
            })
            if (names.length > 0) {
              if (!rosterReported) {
                rosterReported = true
                try {
                  window.zoomSpeakerForensics?.(`ROSTER via "${sel}" (${names.length} participants)`)
                } catch {
                  /* bridge unavailable */
                }
              }
              break
            }
          }
          return names
        }

        // Emit the speaker set. When the roster is readable, emit EVERY participant
        // (so the log shows Speaker 1, 2, 3), with the one Zoom shows in the main
        // tile flagged isSpeaking (keeps the audio-capture-failure safety net alive,
        // since there is always exactly one active tile). If the roster isn't
        // available, fall back to the single active tile.
        let cachedRoster: string[] = []
        function emit(name: string | null): void {
          let roster = readRoster().filter(
            (n) => !(selfName && n.toLowerCase() === selfName.toLowerCase())
          )
          // Reuse the last good roster when the pane is temporarily unreadable.
          // During a SCREEN SHARE Zoom hides the participants pane, so
          // readRoster() goes empty — without this the emit collapses to a single
          // active-tile speaker and, because the pane stays closed, never recovers
          // (this is the "share makes it one speaker forever" bug). Keeping the
          // cached roster preserves multi-speaker separation through the share.
          if (roster.length > 0) {
            cachedRoster = roster
          } else if (cachedRoster.length > 0) {
            roster = cachedRoster
          }
          // Always include the CURRENT active speaker, even if the (cached) roster
          // predates them — e.g. someone who JOINS mid screen-share while the pane
          // is hidden and starts talking: the active tile knows their name before
          // readRoster() can. Without this they'd be attributed to nobody. Also
          // seeds the cache so they persist once seen.
          if (name && !roster.some((n) => n.toLowerCase() === name.toLowerCase())) {
            roster = [...roster, name]
            cachedRoster = roster
          }
          let speakers: SpeakerData[]
          if (roster.length > 0) {
            speakers = roster.map((n, i) => ({
              name: n,
              id: i,
              timestamp: Date.now(),
              isSpeaking: name ? n.toLowerCase() === name.toLowerCase() : false
            }))
          } else {
            speakers = name ? [{ name, id: 0, timestamp: Date.now(), isSpeaking: true }] : []
          }
          try {
            window.zoomSpeakersChanged?.(speakers)
          } catch {
            /* consumer error */
          }
        }

        // If we never resolve a speaker, dump the tile CLASS structure once so the
        // selectors can be updated. Class names only — no text, so no names leak.
        let probesLeft = 1
        function dumpDomForensics(): void {
          if (probesLeft <= 0) return
          probesLeft--
          const HINT = /speak|talk|active|audio|volume|voice/i
          const probe = ACTIVE_CONTAINER_SELECTORS.map((s) => ({
            selector: s,
            present: !!document.querySelector(s)
          }))
          const footers = document.querySelectorAll(NAME_FOOTER_SELECTOR).length
          const survey: string[] = []
          const sweep = document.querySelectorAll(
            '[class*="name"],[class*="avatar"],[class*="participant"],[class*="video"],[class*="tile"],[class*="speaker"]'
          )
          for (let i = 0; i < sweep.length && survey.length < 20; i++) {
            const cls = String((sweep[i] as HTMLElement).className).slice(0, 70)
            if (cls) survey.push(`${sweep[i].tagName.toLowerCase()}.${cls}${HINT.test(cls) ? " [HINT]" : ""}`)
          }
          try {
            window.zoomSpeakerForensics?.(
              `knownSelectors=${JSON.stringify(probe)} nameFooters=${footers} survey=${JSON.stringify(survey)}`
            )
          } catch {
            /* bridge unavailable */
          }
        }

        let emptyPolls = 0
        function tick(): void {
          let name: string | null = null
          try {
            name = readActiveSpeaker()
          } catch {
            return
          }
          // ~10s of continuous "nobody" while the call is live: either genuinely
          // silent, or our selectors are stale. Dump once so we can tell which.
          if (!name && active === null && ++emptyPolls === Math.round(10_000 / pollMs)) {
            dumpDomForensics()
          }
          if (name) emptyPolls = 0
          if (name !== active) {
            if (name === candidate) candidateCount++
            else {
              candidate = name
              candidateCount = 1
            }
            if (candidateCount >= confirmPolls) {
              active = candidate
              candidateCount = 0
              sinceEmit = 0
              emit(active)
            }
          } else {
            candidate = active
            candidateCount = 0
            if (active && ++sinceEmit >= heartbeatPolls) {
              sinceEmit = 0
              emit(active)
            }
          }
        }

        // Open the participants panel so readRoster() can see everyone. The panel
        // is forced off-screen by the html cleaner, so it never shows. Safe to call
        // repeatedly (once open, the "open …" button is gone). Keep this running for
        // the WHOLE meeting: Zoom closes the pane when a screen share starts, so we
        // must re-open it once the share ends to refresh the roster (the cached
        // roster covers the gap in the meantime). Throttled to re-open only when the
        // roster is currently unreadable.
        openParticipantsPanel()
        const panelOpener = setInterval(() => {
          if (readRoster().length === 0) openParticipantsPanel()
        }, 1500)

        tick()
        const timer = setInterval(tick, pollMs)

        window.zoomObserverCleanup = () => {
          clearInterval(timer)
          clearInterval(panelOpener)
        }
      },
      {
        selfName: this.botName,
        pollMs: this.POLL_MS,
        confirmPolls: this.CONFIRM_POLLS,
        heartbeatMs: this.HEARTBEAT_MS
      }
    )

    this.isObserving = true
    console.log("[Zoom] ✅ Speaker observer started")
  }

  /**
   * Gate isSpeaking on the REAL audio level and forward to the consumer.
   *
   * Zoom's web DOM has no per-tile speaking flag, so the in-page observer marks
   * the main-tile occupant isSpeaking=true unconditionally. Ungated that is both
   * misleading in the log and dangerous — recording-state's checkNoSpeaker treats
   * a recent DOM speaker as "still speaking", so a permanently-true flag keeps the
   * silence timeout from ever firing. Gating on the audio pipeline makes isSpeaking
   * reflect actual speech and lets the silence timeout work. No names are logged
   * here — the speaker-manager table masks them to "Speaker N".
   */
  private emitGated(speakers: SpeakerData[]): void {
    const level = SoundLevelMonitor.peekInstance()?.getCurrentSoundLevel() ?? 0
    const speaking = level > SOUND_ACTIVITY_THRESHOLD
    this.lastSpeaking = speaking
    const gated = speakers.map((s) => ({ ...s, isSpeaking: s.isSpeaking && speaking }))
    this.onSpeakersChange(gated)
  }

  public stopObserving(): void {
    if (!this.isObserving) return
    if (this.soundGateTimer) {
      clearInterval(this.soundGateTimer)
      this.soundGateTimer = null
    }
    this.page
      ?.evaluate(() => window.zoomObserverCleanup?.())
      .catch((e) => console.error("[Zoom] Error cleaning up observer:", e))
    this.isObserving = false
    console.log("[Zoom] ✅ Speaker observer stopped")
  }
}
