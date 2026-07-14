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
 * Zoom Web speaker attribution — TEMPORAL, DOM-based.
 *
 * Unlike Meet (per-participant <audio> → per-track vote/lock) and unlike our
 * Meet/Teams network-interception path, the Zoom Web client exposes only a
 * mixed audio stream (captured out-of-band by PulseAudio → ffmpeg, same as
 * every platform here). So attribution is temporal: read who Zoom is CURRENTLY
 * rendering as the active speaker from the DOM and label the mixed audio with
 * that name by timestamp.
 *
 * Logic + selectors ported verbatim from vexa `zoom-capture/zoom-speakers.ts`
 * (active-speaker containers + avatar footer, 250ms poll, 2-poll flicker
 * debounce, 2s heartbeat). Emits SpeakerData[] over the exposeFunction bridge
 * exactly like MeetSpeakersObserver, so the downstream speaker-manager /
 * diarization-tracker is unchanged.
 *
 * KNOWN LIMITATION (documented, not a bug): temporal attribution cannot
 * separate overlapping speakers — whoever Zoom lights up wins the turn. Quality
 * is below Meet's per-participant network diarization. The in-page getState()
 * probe is exposed for live selector-forensics when Zoom shifts its DOM.
 */
export class ZoomSpeakersObserver {
  private page: Page
  private recordingMode: RecordingMode
  private botName: string
  private onSpeakersChange: (speakers: SpeakerData[]) => void
  private isObserving = false

  private readonly POLL_MS = 250
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
      console.error(`[Zoom-Speakers] FORENSICS (active-speaker selectors matched nothing): ${report}`)
    })

    await this.page.evaluate(
      ({ selfName, pollMs, confirmPolls, heartbeatMs }) => {
        // Active-speaker containers, most-specific first.
        //
        // The first two are vexa's; live forensics against Zoom (2026-07) show
        // BOTH match zero elements — vexa's Zoom speaker module was never wired
        // into their own bot, so its selectors were never exercised. Kept only
        // as fallbacks for older/other Zoom builds.
        //
        // `.single-main-container__video-frame` is what Zoom actually renders
        // today: the speaker-view main tile. Zoom itself decides who occupies
        // it, so the name in its footer IS Zoom's active-speaker pick — which is
        // precisely the temporal attribution we want.
        //
        // Note: the same forensics found NO class matching
        // /speak|talk|active|audio|voice/ anywhere in the tile DOM, so Zoom
        // exposes no per-tile "is speaking" flag here. Occupancy of the main
        // tile is the only speaking signal available to a DOM observer.
        const ACTIVE_CONTAINER_SELECTORS = [
          ".speaker-active-container__video-frame",
          ".speaker-bar-container__video-frame--active",
          ".single-main-container__video-frame",
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

        let reportedSelector: string | null = null
        function readActiveSpeaker(): string | null {
          for (const sel of ACTIVE_CONTAINER_SELECTORS) {
            const name = nameFromContainer(document.querySelector(sel))
            if (name) {
              // Report which selector actually won, once — Zoom shifts this DOM
              // across builds and a silent fallback would hide the drift.
              if (reportedSelector !== sel) {
                reportedSelector = sel
                try {
                  window.zoomSpeakerForensics?.(`RESOLVED via "${sel}" -> "${name}"`)
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
                  window.zoomSpeakerForensics?.(`ROSTER via "${sel}" -> ${JSON.stringify(names)}`)
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
        function emit(name: string | null): void {
          const roster = readRoster().filter(
            (n) => !(selfName && n.toLowerCase() === selfName.toLowerCase())
          )
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

        // Selector forensics. The active-speaker selectors above came from vexa,
        // whose own Zoom speaker module was never wired into their bot — so they
        // carry no production hours and Zoom shifts this DOM across builds. If we
        // never resolve a speaker, dump the real participant-tile structure ONCE
        // so the next run tells us the current selectors instead of silently
        // producing an unattributed transcript.
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
          // Sweep name-ish / avatar-ish / video-adjacent nodes carrying short text.
          const survey: string[] = []
          const sweep = document.querySelectorAll(
            '[class*="name"],[class*="avatar"],[class*="participant"],[class*="video"],[class*="tile"],[class*="speaker"]'
          )
          for (let i = 0; i < sweep.length && survey.length < 20; i++) {
            const el = sweep[i] as HTMLElement
            const cls = String(el.className).slice(0, 70)
            let own = ""
            for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) own += n.textContent || ""
            own = own.trim().slice(0, 30)
            const hint = HINT.test(cls) ? " [SPEAKING-HINT]" : ""
            if (cls) survey.push(`${el.tagName.toLowerCase()}.${cls}${own ? ` »${own}` : ""}${hint}`)
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
        // is forced off-screen by the html cleaner, so it never shows. Retry a few
        // seconds; safe to call repeatedly (once open, the "open …" button is gone).
        openParticipantsPanel()
        let panelAttempts = 0
        const panelOpener = setInterval(() => {
          panelAttempts++
          if (readRoster().length > 0 || panelAttempts >= 20) {
            clearInterval(panelOpener)
            return
          }
          openParticipantsPanel()
        }, 500)

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
