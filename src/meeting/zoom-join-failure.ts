import { MeetingEndReason } from "../state-machine/types"

const DOWNGRADEABLE_AFTER_ZOOM_BOT_WALL: ReadonlySet<MeetingEndReason> = new Set([
  MeetingEndReason.CannotJoinMeeting,
  MeetingEndReason.TimeoutWaitingToStart,
  MeetingEndReason.ExitingMeetingBeforeRecord,
  MeetingEndReason.ProxyUnavailable,
  MeetingEndReason.Internal
])

/**
 * Keep a confirmed Zoom anti-bot wall when a later relaunch only produces a
 * less-specific transport/render failure. A successful relaunch never calls
 * this helper, while deterministic outcomes such as login/registration remain
 * authoritative.
 */
export function resolveZoomJoinFailureReason(
  confirmedBotWall: MeetingEndReason.ZoomAnonymousJoinNotAllowed | null,
  latestReason: MeetingEndReason | null
): MeetingEndReason | null {
  if (latestReason === MeetingEndReason.ZoomAnonymousJoinNotAllowed) {
    return latestReason
  }
  if (
    confirmedBotWall &&
    (latestReason === null || DOWNGRADEABLE_AFTER_ZOOM_BOT_WALL.has(latestReason))
  ) {
    return confirmedBotWall
  }
  return latestReason
}
