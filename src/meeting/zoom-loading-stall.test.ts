import {
  BLANK_STALL_AFTER_MS,
  classifyZoomLoadState,
  LOAD_PHASE_HARD_CAP_MS,
  STALL_AFTER_MS,
  ZoomLoadingStallTracker,
  type ZoomLoadSnapshot
} from "./zoom-loading-stall"

const snap = (overrides: Partial<ZoomLoadSnapshot> = {}): ZoomLoadSnapshot => ({
  readyState: "complete",
  url: "https://app.zoom.us/wc/123/join",
  text: "",
  elementCount: 250,
  appRootEmpty: false,
  loadingIndicator: false,
  prejoinReady: false,
  meetingUiReady: false,
  ...overrides
})

describe("classifyZoomLoadState", () => {
  it("treats a rendered pre-join card as ready even while a spinner node lingers", () => {
    expect(classifyZoomLoadState(snap({ prejoinReady: true, loadingIndicator: true }))).toBe(
      "ready"
    )
  })

  // The waiting room can legitimately last the full 600s admission timeout. If it
  // ever reads as "still loading" the bot reloads itself out of a queue it was
  // already sitting in.
  it.each([
    "Please wait, the meeting host will let you in soon",
    "Waiting for the host to start this meeting",
    "You will be admitted shortly"
  ])("treats waiting-room copy as ready: %s", (text) => {
    expect(classifyZoomLoadState(snap({ text }))).toBe("ready")
  })

  it("reads Zoom's own connecting copy as loading", () => {
    expect(classifyZoomLoadState(snap({ text: "Joining Meeting..." }))).toBe("loading")
  })

  // Zoom mounts an EMPTY #video-share-layout video-player behind the "Joining
  // Meeting…" overlay. If that counts as admitted, the bot starts recording the
  // spinner — the precise false positive the old isJoiningSpinner gate existed
  // to prevent, so it has to survive here.
  it("keeps the joining overlay ahead of the empty in-meeting DOM behind it", () => {
    expect(classifyZoomLoadState(snap({ text: "Joining Meeting...", meetingUiReady: true }))).toBe(
      "loading"
    )
  })

  it("reads an incomplete readyState as loading even with no other hint", () => {
    expect(classifyZoomLoadState(snap({ readyState: "loading" }))).toBe("loading")
  })

  // The white page: navigation committed, nothing mounted, nothing painted.
  it("reads a page with nothing painted and nothing mounted as blank", () => {
    expect(classifyZoomLoadState(snap({ text: "   ", appRootEmpty: true, elementCount: 4 }))).toBe(
      "blank"
    )
  })

  // Zoom builds its DOM well before it paints any text. Calling that blank would
  // spend the short white-page budget on a client that is genuinely coming up.
  it("reads a mounted but unpainted client as loading, not blank", () => {
    expect(classifyZoomLoadState(snap({ text: "", appRootEmpty: false }))).toBe("loading")
  })

  it("reads a loaded page showing something unrecognised as unknown, not loading", () => {
    expect(classifyZoomLoadState(snap({ text: "This meeting link is invalid (3,001)" }))).toBe(
      "unknown"
    )
  })
})

describe("ZoomLoadingStallTracker", () => {
  const loading = snap({ readyState: "loading", text: "Loading..." })

  // The whole point: Zoom taking minutes to come up is not a failure so long as
  // it is visibly getting somewhere. The old flat 30s deadline killed exactly
  // these joins.
  it("keeps waiting far past the old 30s deadline while the page still changes", () => {
    const tracker = new ZoomLoadingStallTracker("pre-join")
    let now = 0
    for (let i = 0; now < LOAD_PHASE_HARD_CAP_MS - STALL_AFTER_MS; i++) {
      now += STALL_AFTER_MS - 1_000
      const action = tracker.observe(snap({ readyState: "loading", text: "x".repeat(i + 1) }), now)
      expect(action.type).toBe("wait")
    }
    expect(now).toBeGreaterThan(120_000)
    expect(tracker.reloadCount).toBe(0)
  })

  // A white page has no partial render to be patient with, so it should be acted
  // on well before the spinner budget — and the spinner budget must not shrink
  // to match.
  it("reloads a white page on the shorter budget", () => {
    const white = snap({ text: "", appRootEmpty: true, elementCount: 4 })
    const tracker = new ZoomLoadingStallTracker("pre-join")

    expect(tracker.observe(white, 0).type).toBe("wait")
    expect(tracker.observe(white, BLANK_STALL_AFTER_MS - 1).type).toBe("wait")
    expect(tracker.observe(white, BLANK_STALL_AFTER_MS)).toMatchObject({ type: "reload" })
    expect(BLANK_STALL_AFTER_MS).toBeLessThan(STALL_AFTER_MS)
  })

  // Zoom mounts hundreds of nodes before painting a character. Judging progress
  // on text alone made that look frozen and reloaded a client that was working.
  it("counts DOM growth as progress even while nothing is painted", () => {
    const tracker = new ZoomLoadingStallTracker("pre-join")
    let now = 0
    for (let i = 0; i < 6; i++) {
      now += STALL_AFTER_MS - 1_000
      const action = tracker.observe(
        snap({ readyState: "complete", text: "", elementCount: 100 + i * 40 }),
        now
      )
      expect(action.type).toBe("wait")
    }
    expect(tracker.reloadCount).toBe(0)
  })

  it("reloads once the page has been frozen on the same frame", () => {
    const tracker = new ZoomLoadingStallTracker("pre-join")
    expect(tracker.observe(loading, 0).type).toBe("wait")
    expect(tracker.observe(loading, STALL_AFTER_MS - 1).type).toBe("wait")

    const action = tracker.observe(loading, STALL_AFTER_MS)
    expect(action).toMatchObject({ type: "reload", attempt: 1 })
  })

  it("does not re-trip on the reloaded page's own first frame", () => {
    const tracker = new ZoomLoadingStallTracker("pre-join")
    tracker.observe(loading, 0)
    expect(tracker.observe(loading, STALL_AFTER_MS).type).toBe("reload")
    // Same frozen frame, immediately after the reload: the clock restarted.
    expect(tracker.observe(loading, STALL_AFTER_MS + 1_000).type).toBe("wait")
  })

  it("gives up as a stall once the reload budget is spent", () => {
    const tracker = new ZoomLoadingStallTracker("pre-join", { maxReloads: 1 })
    tracker.observe(loading, 0)
    expect(tracker.observe(loading, STALL_AFTER_MS).type).toBe("reload")

    // The reloaded page gets its own full stall window before it counts again.
    expect(tracker.observe(loading, STALL_AFTER_MS + 1_000).type).toBe("wait")
    const action = tracker.observe(loading, STALL_AFTER_MS * 2 + 1_000)
    expect(action).toMatchObject({ type: "giveUp", stalled: true })
  })

  // A page that repaints its spinner forever never looks frozen, so the frozen
  // clock alone would hold the pod until the 600s admission timeout.
  it("gives up as a stall at the hard cap even while the page keeps repainting", () => {
    const tracker = new ZoomLoadingStallTracker("admission")
    let now = 0
    let action = tracker.observe(loading, now)
    for (let i = 0; action.type === "wait" && i < 500; i++) {
      now += 1_000
      action = tracker.observe(snap({ readyState: "loading", text: "y".repeat(i + 1) }), now)
    }
    expect(action).toMatchObject({ type: "giveUp", stalled: true })
    expect(now).toBeGreaterThanOrEqual(LOAD_PHASE_HARD_CAP_MS)
  })

  // An error page is not slow, it is wrong — reloading it wastes the pod, and it
  // must not be reported as a stall, because the caller has real reasons for it.
  it("hands an unrecognised loaded page back quickly and not as a stall", () => {
    const tracker = new ZoomLoadingStallTracker("pre-join", { unknownGraceMs: 5_000 })
    const wall = snap({ text: "automated bots aren't allowed" })

    expect(tracker.observe(wall, 0).type).toBe("wait")
    const action = tracker.observe(wall, 5_000)
    expect(action).toMatchObject({ type: "giveUp", stalled: false, state: "unknown" })
    expect(tracker.reloadCount).toBe(0)
  })

  it("stops counting toward the unknown grace once the client comes up", () => {
    const tracker = new ZoomLoadingStallTracker("pre-join", { unknownGraceMs: 5_000 })
    tracker.observe(snap({ text: "something odd" }), 0)
    expect(tracker.observe(snap({ prejoinReady: true }), 1_000).type).toBe("ready")
    // The odd frame reappears: the grace starts over rather than firing at once.
    expect(tracker.observe(snap({ text: "something odd" }), 4_000).type).toBe("wait")
  })
})
