// Type definitions for network-based speaker observation

// --- Public API Types ---

export type NetworkUser = {
  deviceId: string
  name: string
  isCurrentUser: boolean
  isSpeaking: boolean
  status: number
  isHost: boolean
  audioLevel?: number
  // PII fields for enhanced Speaker/Participant capture
  fullName?: string
  displayName?: string
  profilePicture?: string
}

export type ChatMessage = {
  messageId: string
  deviceId: string
  timestamp: number | string
  text: string
  senderName?: string
}

export type NetworkPayload = {
  users: NetworkUser[]
  timestamp: number
  source: "roster" | "audio" | "health_check" | "network_interception_failed" | "csrc_probe"
  /** Read-only CSRC/SSRC audio-level probe summary (counts only, no ids). */
  probe?: {
    receivers: number
    meetCalls: number
    csrcSources: number
    csrcWithLevel: number
    csrcMax: number
    ssrcSources: number
    ssrcWithLevel: number
    ssrcMax: number
    mapped: number
    timestamp: number
  }
  health?: {
    subscribed: boolean
    /** Tracks that have delivered at least one audio frame. */
    activeTrackCount: number
    /** Tracks registered for monitoring, whether or not a processor exists yet. */
    registeredTrackCount?: number
    /** Age of the most recent frame across all tracks; null if none ever arrived. */
    lastFrameAgeMs?: number | null
    audioProcessingActive: boolean
    subscriptionError: string | null
    timestamp: number
  }
  failure?: {
    trackId: string
    reason: "timeout" | "immediate_failure" | "processor_unavailable"
    trackState: string
    timestamp: number
  }
}

// --- Browser Manager Types ---

export type ReceiverManager = {
  receiverMap: Map<unknown, unknown>
  receiverToTrackMap: Map<unknown, unknown>
}

// Raw device output from protobuf (before processing)
export type RawDeviceOutput = {
  deviceId: string
  deviceOutputType: number // 1=audio, 2=video
  streamId: string
  deviceOutputStatus?: {
    disabled: number
  }
}

// Processed device output (stored in manager)
export type DeviceOutput = {
  deviceId: string
  outputType: number // 1=audio, 2=video
  streamId: string // This IS the SSRC
  lastUpdated: number
}

// Raw user data from protobuf (before processing)
export type RawUser = {
  deviceId: string
  fullName?: string | Uint8Array
  displayName?: string
  profilePicture?: string
  status?: number
  isCurrentUserString?: string
  parentDeviceId?: string
  isHost?: number
}

export type UserManager = {
  deviceOutputMap: Map<string, DeviceOutput>
  allUsersMap: Map<string, RawUser>
  ssrcToDeviceMap: Map<unknown, string>
}

// --- Utility Types ---

// Protobuf Reader type (from protobufjs library)
export type ProtobufReader = {
  pos: number
  len: number
  uint32(): number
  int64(): number | string
  string(): string
  bytes(): Uint8Array
  skipType(wireType: number): void
}

export type MessageDecoders = {
  [key: string]: (reader: ProtobufReader | Uint8Array, length?: number) => unknown
}
