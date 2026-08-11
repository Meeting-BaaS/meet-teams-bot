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
  source:
    | "roster"
    | "audio"
    | "health_check"
    | "network_interception_failed"
    | "csrc_probe"
    | "media_probe"
    | "dc_probe"
    | "f14_live"
    | "dc_channels"
    | "dcrpc_decode"
  /** v12: per-datachannel-label raw traffic ("label:Nm/Bb/sndK/lenL"). */
  channels?: string[]
  /** v14: raw-decoded dcrpc/media-director frame fields + sound flag. */
  rpc?: { label: string; fields: string[]; sound: boolean }
  /** v11: edge-triggered live field-14 — active masked devices + sound. */
  f14live?: { active: string[]; sound: boolean; at: number }
  /** Datachannel speaking-signal probe: undecoded varint field paths that toggle. */
  dc?: {
    messages: number
    bytes: number
    distinctPaths: number
    toggling: string[]
    /** v6: undecoded varint paths whose value exceeds 1 (candidate levels). */
    levels?: string[]
    /** v6: field-9 vs CSRC-loud agreement counts (per audio device output). */
    corr?: {
      onLoud: number
      onQuiet: number
      offLoud: number
      offQuiet: number
      samples: number
    }
    /** v9: field-14 (NetEq active-speaker candidate) vs tap audio energy. */
    f14?: {
      onSound: number
      onQuiet: number
      offSound: number
      offQuiet: number
      samples: number
      seen: boolean
    }
    /** v8: SSRC id spaces (hex) to crack the loud-SSRC ↔ streamId mapping. */
    ssrc?: {
      loudCsrc: string[]
      audioStreamIds: string[]
      syncSsrc: string[]
      allCsrc: string[]
      loudInStreamIds: number
      loudInSync: number
      loudSamples: number
    }
    timestamp: number
  }
  /** Media-architecture probe: where Meet's media stack lives in this frame. */
  media?: {
    frame: string
    pcCreated: number
    workers: string[]
    sharedWorkers: number
    webTransport: string[]
    scriptTransforms: number
    trackGenerators: number
    audioContexts: number
    workletModules: string[]
    /** AudioWorkletNode processors created, as "name:count". */
    workletNodes?: string[]
    /** Observed worklet-node connect() destinations, as "name->DestCtor". */
    workletEdges?: string[]
    mediaEls: number
    elsWithStream: number
    liveAudioTracks: number
    timestamp: number
  }
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
