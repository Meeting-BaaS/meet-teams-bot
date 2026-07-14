import type { Page } from "@playwright/test"
import type { RecordingMode, SpeakerData } from "../../types"

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
        this.onSpeakersChange(speakers)
      } catch (error) {
        console.error("[Zoom] Error in speakers callback:", error)
      }
    })

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

        // Emit the active-speaker set (0 or 1 name) as SpeakerData[], the shape
        // speaker-manager consumes. id=0 marks UI/DOM-based detection.
        //
        // LIMITATION — isSpeaking is always true when a name is present, and
        // that is not a shortcut: Zoom's web DOM exposes NO per-tile speaking
        // flag in this view (live forensics found no class matching
        // /speak|talk|active|audio|voice/ anywhere in the tile subtree). The
        // only signal available is WHO Zoom puts in the main tile. So this
        // reports "who Zoom currently considers the active speaker", not "who is
        // producing audio right now" — it cannot distinguish speech from
        // silence, and cannot separate overlapping speakers. Silence is handled
        // out-of-band by SoundLevelMonitor (ffmpeg PCM levels), which is why the
        // recording still ends correctly on a silent call.
        function emit(name: string | null): void {
          const speakers: SpeakerData[] = name
            ? [{ name, id: 0, timestamp: Date.now(), isSpeaking: true }]
            : []
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

        tick()
        const timer = setInterval(tick, pollMs)

        window.zoomObserverCleanup = () => {
          clearInterval(timer)
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

  public stopObserving(): void {
    if (!this.isObserving) return
    this.page
      ?.evaluate(() => window.zoomObserverCleanup?.())
      .catch((e) => console.error("[Zoom] Error cleaning up observer:", e))
    this.isObserving = false
    console.log("[Zoom] ✅ Speaker observer stopped")
  }
}
