// Types for Teams network-based speaker observation.

export type NetworkUser = {
  deviceId: string
  name: string
  isCurrentUser: boolean
  isSpeaking: boolean
  status?: number
  isHost?: boolean
  audioLevel?: number
  fullName?: string
  displayName?: string
  profilePicture?: string
}

export type NetworkPayload = {
  users: NetworkUser[]
  timestamp: number
  source: "roster" | "audio"
}

// --- Teams raw wire shapes (decoded from WebSocket / data-channel) ---

// A participant's media stream from a rosterUpdate. sourceId is the "virtual
// stream" id the dominant-speaker (dsh) message references.
export type TeamsMediaStream = {
  sourceId: number | string
  type: string // "audio" | "video" | "applicationsharing-video"
  direction: string // "sendrecv" | "sendonly" | "recvonly" | "inactive"
}

export type TeamsRosterEndpoint = {
  call?: {
    mediaStreams?: TeamsMediaStream[]
  }
}

export type TeamsRosterParticipant = {
  details?: {
    id?: string
    displayName?: string
  }
  state?: string // "active" | "inactive" | ...
  meetingRole?: string // "organizer" | "presenter" | "attendee"
  endpoints?: Record<string, TeamsRosterEndpoint>
}

export type TeamsRosterUpdateBody = {
  participants: Record<string, TeamsRosterParticipant>
}

// "main-channel" dsh message; history[0] is the dominant speaker's audio
// virtual stream id: [{"type":"dsh","history":[<audioSourceId>, ...]}].
export type TeamsDshMessage = {
  type: "dsh"
  history: Array<number | string>
}
