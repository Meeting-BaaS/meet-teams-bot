import { MeetingEndReason } from "../state-machine/types"
import { resolveZoomJoinFailureReason } from "./zoom-join-failure"

describe("Zoom join failure evidence", () => {
  const wall = MeetingEndReason.ZoomAnonymousJoinNotAllowed

  it.each([
    MeetingEndReason.CannotJoinMeeting,
    MeetingEndReason.TimeoutWaitingToStart,
    MeetingEndReason.ExitingMeetingBeforeRecord,
    MeetingEndReason.ProxyUnavailable,
    MeetingEndReason.Internal,
    null
  ])("preserves a confirmed bot wall over %s", (latestReason) => {
    expect(resolveZoomJoinFailureReason(wall, latestReason)).toBe(wall)
  })

  it.each([
    MeetingEndReason.LoginRequired,
    MeetingEndReason.InvalidMeetingUrl,
    MeetingEndReason.ZoomPasscodeRequired,
    MeetingEndReason.ZoomInvalidPasscode,
    MeetingEndReason.ZoomWebinarRegistrationRequired
  ])("keeps a later deterministic outcome %s", (latestReason) => {
    expect(resolveZoomJoinFailureReason(wall, latestReason)).toBe(latestReason)
  })

  it("does not manufacture bot-wall evidence", () => {
    expect(resolveZoomJoinFailureReason(null, MeetingEndReason.CannotJoinMeeting)).toBe(
      MeetingEndReason.CannotJoinMeeting
    )
  })
})
