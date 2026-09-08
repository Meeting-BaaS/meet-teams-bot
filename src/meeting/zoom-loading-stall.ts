import type { Page } from "@playwright/test"

/**
 * Zoom's web client can take a very long time to come up — and sometimes never
 * comes up at all. Those two look identical for the first half-minute, which is
 * why a flat "wait 30s for the pre-join card, then fail" both abandons joins
 * that would have worked and reports the ones that never would as an opaque
 * CannotJoinMeeting.
 *
 * The stall has two faces. Sometimes Zoom sits on a spinner forever; sometimes
 * the navigation commits and the tab is simply white, with nothing mounted and
 * nothing to show. The white page is the more clear-cut of the two — there is no
 * partial render to be patient with — so it gets a shorter budget of its own.
 *
 * The question this module asks is not "how long has it been?" but "is anything
 * still happening?". A client that is slowly booting keeps changing — it
 * redirects, readyState advances, text appears. A wedged one is frozen on the
 * same frame indefinitely. So the clock only runs while the page is observably
 * unchanged, which lets a genuinely slow load take as long as it needs while a
 * frozen one is caught in ~25s.
 *
 * Deliberately separate from the anti-bot wall. That wall is IP-reputation-keyed
 * and wants a different exit IP (browser relaunch, then a fresh pod); a stall is
 * a transport or renderer problem inside this page, and the cheapest thing that
 * clears it is a reload in the very same browser. Do not merge the two paths.
 *
 * This file owns no end reasons on purpose — it reports what it saw and the
 * caller, which knows the phase and its own fallbacks, decides what that means.
 */

/** Zoom's own loading/connecting copy. Waiting-room text is deliberately absent:
 *  "please wait, the meeting host will let you in soon" is a legitimate state
 *  that can last the full admission timeout and must never read as a stall. */
const LOADING_TEXTS = [
  "joining meeting",
  "joining the meeting",
  "connecting to the meeting",
  "connecting...",
  "loading...",
  "preparing the meeting",
  "your meeting is loading"
]

/** Text that proves the client is up and showing meeting UI, even though no
 *  in-meeting DOM node has mounted yet. Mirrors ZOOM_STATE_CONFIG's waiting-room
 *  patterns. */
const MEETING_UI_TEXTS = [
  "the meeting host will let you in",
  "will let you in",
  "waiting for the host to start",
  "waiting room",
  "admitted shortly",
  "host has joined"
]

/** No observable change for this long, while the page is not up, is a stall.
 *  Zoom's client mutates the DOM far more often than this whenever it really is
 *  still working, so a quiet window this long means nothing is coming. */
export const STALL_AFTER_MS = 25_000

/** In-page reloads before the stall is escalated out of this pod. A stalled
 *  asset or socket almost always clears on the first reload; a third has never
 *  been the difference and just holds a warm pod open. */
export const MAX_STALL_RELOADS = 2

/** Ceiling for one load phase however much the page appears to progress — stops
 *  a client that repaints a spinner forever from holding the pod all the way to
 *  the 600s admission timeout. */
export const LOAD_PHASE_HARD_CAP_MS = 180_000

/** A white page is conclusive far sooner than a spinner: there is no partial
 *  render to be patient with, nothing is mounted at all. Zoom's client puts its
 *  root in place within a second or two of the navigation committing, so a
 *  document still empty after this long is not slow, it is broken. */
export const BLANK_STALL_AFTER_MS = 12_000

/** A page that has finished loading but shows something we don't recognise is
 *  not slow, it is wrong (an error page, an unmatched wall). Give it only enough
 *  time to cover a mid-mount frame, then hand back to the caller's own checks. */
export const UNKNOWN_GRACE_MS = 15_000

/**
 * What the Zoom client looks like right now. Plain values only, so every
 * decision below stays pure and testable without a browser.
 */
export interface ZoomLoadSnapshot {
  /** document.readyState */
  readyState: string
  /** Current URL — a redirect is progress, not a stall. */
  url: string
  /** Visible body text, lowercased and truncated. */
  text: string
  /** Zoom's spinner / loading layer is mounted. */
  loadingIndicator: boolean
  /** Total elements in the document. Rises steadily while the client builds
   *  itself, which is progress even before a single character is painted. */
  elementCount: number
  /** Nothing is mounted: no body children, or Zoom's own root is empty. The
   *  white-page case — the client took the navigation and then rendered
   *  literally nothing. */
  appRootEmpty: boolean
  /** The pre-join card is rendered (name input present). */
  prejoinReady: boolean
  /** Waiting-room or in-meeting UI is rendered. */
  meetingUiReady: boolean
}

export type ZoomLoadState = "ready" | "loading" | "blank" | "unknown"

export type ZoomLoadAction =
  | { type: "ready" }
  | { type: "wait" }
  | { type: "reload"; attempt: number; stalledForMs: number }
  /** Stop waiting. `stalled` distinguishes "never finished loading" — the case
   *  worth its own end reason and its own retry — from "loaded into something
   *  unexpected", which the caller should classify with its existing checks. */
  | { type: "giveUp"; state: ZoomLoadState; stalled: boolean; detail: string }

/**
 * Classify a single observation.
 *
 * Rendered UI wins over a lingering spinner NODE: Zoom leaves those in the DOM
 * after the pre-join card mounts, and reading one as "still loading" would
 * strand a bot that has in fact arrived. Zoom's explicit connecting COPY is the
 * one exception and wins over everything — see below.
 */
export function classifyZoomLoadState(snapshot: ZoomLoadSnapshot): ZoomLoadState {
  const text = snapshot.text.toLowerCase()

  // Zoom's explicit connecting copy outranks rendered UI. While the "Joining
  // Meeting…" overlay is up Zoom has ALREADY mounted an empty
  // #video-share-layout video-player behind it, and reading that as "in meeting"
  // is exactly how a bot ends up recording the spinner.
  if (LOADING_TEXTS.some((t) => text.includes(t))) return "loading"

  if (snapshot.prejoinReady || snapshot.meetingUiReady) return "ready"
  if (MEETING_UI_TEXTS.some((t) => text.includes(t))) return "ready"

  // A bare spinner NODE is much weaker evidence than the copy above — Zoom
  // leaves those in the DOM after the card mounts — so it only counts once
  // nothing rendered has been found.
  if (snapshot.loadingIndicator) return "loading"
  if (snapshot.readyState !== "complete") return "loading"

  // Nothing painted AND nothing mounted: the white page. Distinguished from a
  // client that has built its DOM but not painted text yet — that one is still
  // coming up and gets the ordinary, longer patience.
  if (text.trim().length === 0) return snapshot.appRootEmpty ? "blank" : "loading"

  // Recognised nothing on a fully loaded page: a wall, a denial or an error
  // page. Those carry their own end reasons and must not be reloaded away, so
  // say so plainly rather than guessing "loading".
  return "unknown"
}

/**
 * The fingerprint that answers "did anything change since last time?". Text
 * length rather than the text itself keeps a ticking clock or participant
 * counter from reading as progress on its own — those advance without the load
 * advancing.
 */
export function loadFingerprint(snapshot: ZoomLoadSnapshot): string {
  return [
    snapshot.url,
    snapshot.readyState,
    String(snapshot.text.length),
    // Without this, a client that is busily mounting its DOM but has not painted
    // any text yet looks frozen — identical text length every poll — and gets
    // reloaded out from under itself while it was in fact working.
    String(snapshot.elementCount),
    snapshot.loadingIndicator ? "spin" : "-"
  ].join("|")
}

export interface ZoomLoadingStallOptions {
  stallAfterMs?: number
  blankStallAfterMs?: number
  maxReloads?: number
  hardCapMs?: number
  unknownGraceMs?: number
}

/**
 * Feed it observations, it says whether to keep waiting, reload, or stop.
 *
 * An object rather than a bare function because the decision depends on history:
 * how long the page has been frozen, and how many reloads it has already had.
 * `now` is injected so tests can drive time directly.
 */
export class ZoomLoadingStallTracker {
  private readonly stallAfterMs: number
  private readonly blankStallAfterMs: number
  private readonly maxReloads: number
  private readonly hardCapMs: number
  private readonly unknownGraceMs: number

  private startedAt: number | null = null
  private lastFingerprint: string | null = null
  private lastChangeAt = 0
  private unknownSince: number | null = null
  private reloads = 0

  constructor(
    private readonly phase: string,
    options: ZoomLoadingStallOptions = {}
  ) {
    this.stallAfterMs = options.stallAfterMs ?? STALL_AFTER_MS
    this.blankStallAfterMs = options.blankStallAfterMs ?? BLANK_STALL_AFTER_MS
    this.maxReloads = options.maxReloads ?? MAX_STALL_RELOADS
    this.hardCapMs = options.hardCapMs ?? LOAD_PHASE_HARD_CAP_MS
    this.unknownGraceMs = options.unknownGraceMs ?? UNKNOWN_GRACE_MS
  }

  /** Reloads spent so far — for the caller's logging. */
  get reloadCount(): number {
    return this.reloads
  }

  observe(snapshot: ZoomLoadSnapshot, now: number): ZoomLoadAction {
    this.startedAt ??= now

    const state = classifyZoomLoadState(snapshot)
    if (state === "ready") {
      this.unknownSince = null
      return { type: "ready" }
    }

    if (state === "unknown") {
      this.unknownSince ??= now
      // Drop the change fingerprint so the next loading observation starts a
      // fresh stall window. Without this a loading -> unknown -> loading flip
      // that happens to keep an identical fingerprint would be measured as one
      // long freeze and spend a reload it never earned.
      this.lastFingerprint = null
      const unknownFor = now - this.unknownSince
      if (unknownFor >= this.unknownGraceMs) {
        return {
          type: "giveUp",
          state,
          stalled: false,
          detail: `${this.phase}: page loaded but showed nothing recognisable for ${Math.round(
            unknownFor / 1000
          )}s`
        }
      }
      return { type: "wait" }
    }
    this.unknownSince = null

    const fingerprint = loadFingerprint(snapshot)
    if (fingerprint !== this.lastFingerprint) {
      this.lastFingerprint = fingerprint
      this.lastChangeAt = now
    }

    const elapsed = now - this.startedAt
    if (elapsed >= this.hardCapMs) {
      return {
        type: "giveUp",
        state,
        stalled: true,
        detail: `${this.phase}: never finished loading within ${Math.round(
          this.hardCapMs / 1000
        )}s (state=${state}, reloads=${this.reloads})`
      }
    }

    // A white page gets the short window: there is nothing half-rendered to be
    // patient with, so waiting the full spinner budget just wastes the pod.
    const patience = state === "blank" ? this.blankStallAfterMs : this.stallAfterMs
    const frozenFor = now - this.lastChangeAt
    if (frozenFor < patience) return { type: "wait" }

    if (this.reloads >= this.maxReloads) {
      return {
        type: "giveUp",
        state,
        stalled: true,
        detail: `${this.phase}: frozen for ${Math.round(frozenFor / 1000)}s after ${
          this.reloads
        } reload(s) (state=${state})`
      }
    }

    this.reloads += 1
    // The reload restarts the observation: the fresh page gets its own first
    // paint, and keeping the old fingerprint would trip the stall again on the
    // very next poll.
    this.lastFingerprint = null
    this.lastChangeAt = now
    return { type: "reload", attempt: this.reloads, stalledForMs: frozenFor }
  }
}

/**
 * Selectors the caller considers proof the client is up. Passed in rather than
 * duplicated here so zoom.ts stays the single source of truth for Zoom's DOM and
 * the two can never drift apart.
 */
export interface ZoomLoadProbeSelectors {
  /** Pre-join card (the name input). */
  prejoin: string
  /** Waiting-room / in-meeting UI. */
  meetingUi: string
}

/** Ceiling on one probe. `page.evaluate` has no timeout of its own, so a
 *  renderer whose main thread is wedged never returns from it — and that is the
 *  exact page this module exists to catch. Without a bound the polling loop
 *  blocks forever *before* the tracker can order a reload or hit the hard cap. */
export const PROBE_TIMEOUT_MS = 5_000

/** What we report when the page will not answer: a frozen, unchanging snapshot.
 *  Not flagged as an empty root — an evaluate can also fail because a navigation
 *  is committing, and calling that a white page would cut the patience short on
 *  a page that is about to come up fine. Being constant is the point: the
 *  fingerprint never moves, so the stall clock runs and the tracker acts. */
function unresponsiveSnapshot(): ZoomLoadSnapshot {
  return {
    readyState: "loading",
    url: "",
    text: "",
    elementCount: 0,
    appRootEmpty: false,
    loadingIndicator: false,
    prejoinReady: false,
    meetingUiReady: false
  }
}

/**
 * A probe bound in time and limited to one outstanding evaluation.
 *
 * Both guards matter. The timeout stops a wedged renderer from hanging the
 * caller; the in-flight check stops a probe being queued behind one that is
 * never coming back, which would otherwise pile up a new pending evaluation
 * every poll for as long as the page stays frozen.
 */
export function createZoomLoadProbe(
  page: Page,
  selectors: ZoomLoadProbeSelectors,
  timeoutMs: number = PROBE_TIMEOUT_MS
): () => Promise<ZoomLoadSnapshot> {
  let inFlight = false

  return async function probe(): Promise<ZoomLoadSnapshot> {
    // An earlier probe that still has not come back is itself the answer: the
    // page is not responding.
    if (inFlight) return unresponsiveSnapshot()

    inFlight = true
    const evaluation = readZoomLoadSnapshot(page, selectors).finally(() => {
      inFlight = false
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        evaluation,
        new Promise<ZoomLoadSnapshot>((resolve) => {
          timer = setTimeout(() => resolve(unresponsiveSnapshot()), timeoutMs)
        })
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

/**
 * Read the indicators off a live page. Deliberately defensive: this runs against
 * a page that may be mid-navigation or already torn down, and a throw here would
 * surface as a join failure rather than the stall it is describing.
 *
 * Unbounded on its own — callers should go through `createZoomLoadProbe`.
 */
export async function readZoomLoadSnapshot(
  page: Page,
  selectors: ZoomLoadProbeSelectors
): Promise<ZoomLoadSnapshot> {
  try {
    return await page.evaluate(
      ({ prejoin, meetingUi }) => {
        const text = (document.body?.innerText || "").slice(0, 4000)

        // Raw querySelector, never a Playwright visibility check: Zoom's web
        // client reports its own controls as not-visible/not-actionable, so a
        // locator-based probe false-negatives here (the same reason detectBotWall
        // reads the DOM directly).
        const has = (selector: string): boolean => {
          try {
            return Boolean(document.querySelector(selector))
          } catch {
            return false
          }
        }

        // Zoom's client mounts into one of these. "Empty" means the navigation
        // committed and then nothing was built — a genuinely white page, as
        // opposed to a client that is mid-build.
        const roots = ["#zmmtg-root", "#root", "#app"]
          .map((sel) => document.querySelector(sel))
          .filter((el): el is Element => el !== null)
        const appRootEmpty =
          roots.length > 0
            ? roots.every((el) => el.children.length === 0)
            : (document.body?.children.length ?? 0) === 0

        return {
          readyState: document.readyState,
          url: location.href,
          text,
          elementCount: document.getElementsByTagName("*").length,
          appRootEmpty,
          loadingIndicator: has(
            [
              ".loading-layer",
              ".zm-loading",
              '[class*="loading-spinner"]',
              '[class*="LoadingLayer"]',
              ".preview-loading",
              "#zmmtg-root > .loading"
            ].join(",")
          ),
          prejoinReady: has(prejoin),
          meetingUiReady: has(meetingUi)
        }
      },
      { prejoin: selectors.prejoin, meetingUi: selectors.meetingUi }
    )
  } catch {
    // An unreadable page is exactly the frozen case this module exists for, so
    // report the unresponsive snapshot and let the tracker's clock run, instead
    // of the caller treating the error as a hard join failure.
    return unresponsiveSnapshot()
  }
}
