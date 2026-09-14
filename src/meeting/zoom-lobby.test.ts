import { MeetingEndReason } from "../state-machine/types"
import { classifyZoomLobby, updateZoomLobbyState, zoomWaitingTimeoutReason } from "./zoom-lobby"

describe("classifyZoomLobby", () => {
  it.each([
    "Waiting for the host to start this meeting",
    "Waiting for the host to start the meeting"
  ])("reads %p as a host who has not started", (text) => {
    expect(classifyZoomLobby(text)).toBe("host_not_started")
  })

  it.each([
    "Please wait, the meeting host will let you in soon",
    "Host has joined. We've let them know you're here",
    "You will be admitted shortly"
  ])("reads %p as waiting for the host to admit us", (text) => {
    expect(classifyZoomLobby(text)).toBe("waiting_for_admission")
  })

  it("prefers host-present copy when both appear", () => {
    expect(classifyZoomLobby("Waiting for the host to start this meeting. Host has joined.")).toBe(
      "waiting_for_admission"
    )
  })

  it("returns null for pages that say nothing about the host", () => {
    expect(classifyZoomLobby("Joining Meeting...")).toBeNull()
  })
})

describe("zoomWaitingTimeoutReason", () => {
  it("reports a host who never started the meeting as WaitingForHostTimeout", () => {
    let state = updateZoomLobbyState(null, "Waiting for the host to start this meeting")
    state = updateZoomLobbyState(state, "Joining Meeting...")
    expect(zoomWaitingTimeoutReason(state)).toBe(MeetingEndReason.WaitingForHostTimeout)
  })

  it("keeps TimeoutWaitingToStart once the host was seen, even if the copy changes back", () => {
    let state = updateZoomLobbyState(null, "Waiting for the host to start this meeting")
    state = updateZoomLobbyState(state, "Please wait, the meeting host will let you in soon")
    state = updateZoomLobbyState(state, "Waiting for the host to start this meeting")
    expect(zoomWaitingTimeoutReason(state)).toBe(MeetingEndReason.TimeoutWaitingToStart)
  })

  it("falls back to TimeoutWaitingToStart when the lobby was never read", () => {
    expect(zoomWaitingTimeoutReason(null)).toBe(MeetingEndReason.TimeoutWaitingToStart)
  })
})
