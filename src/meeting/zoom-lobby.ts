import { MeetingEndReason } from "../state-machine/types"

// What Zoom's lobby copy says about the host.
export type ZoomLobbyState = "host_not_started" | "waiting_for_admission"

const HOST_NOT_STARTED_TEXTS = ["waiting for the host to start"]
// Copy that only appears once the host is in the meeting.
const WAITING_FOR_ADMISSION_TEXTS = [
  "host has joined",
  "will let you in",
  "admitted shortly",
  "waiting room"
]

export function classifyZoomLobby(text: string): ZoomLobbyState | null {
  const lower = text.toLowerCase()
  if (WAITING_FOR_ADMISSION_TEXTS.some((t) => lower.includes(t))) return "waiting_for_admission"
  if (HOST_NOT_STARTED_TEXTS.some((t) => lower.includes(t))) return "host_not_started"
  return null
}

/** Once the host has been seen, they stay seen: a later frame cannot un-start the meeting. */
export function updateZoomLobbyState(
  previous: ZoomLobbyState | null,
  text: string
): ZoomLobbyState | null {
  if (previous === "waiting_for_admission") return previous
  return classifyZoomLobby(text) ?? previous
}

/** The end reason for a waiting-room timeout, given what the lobby showed. */
export function zoomWaitingTimeoutReason(state: ZoomLobbyState | null): MeetingEndReason {
  return state === "host_not_started"
    ? MeetingEndReason.WaitingForHostTimeout
    : MeetingEndReason.TimeoutWaitingToStart
}
