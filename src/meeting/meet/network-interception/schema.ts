// Protobuf schema definition (Keep exactly as is)
export const PROTO_SCHEMA = [
  {
    name: "CollectionEvent",
    fields: [
      {
        name: "body",
        fieldNumber: 1,
        type: "message",
        messageType: "CollectionEventBody"
      }
    ]
  },
  {
    name: "CollectionEventBody",
    fields: [
      {
        name: "userInfoListWrapperAndChatWrapperWrapper",
        fieldNumber: 2,
        type: "message",
        messageType: "UserInfoListWrapperAndChatWrapperWrapper"
      }
    ]
  },
  {
    name: "UserInfoListWrapperAndChatWrapperWrapper",
    fields: [
      {
        name: "deviceInfoWrapper",
        fieldNumber: 3,
        type: "message",
        messageType: "DeviceInfoWrapper"
      },
      {
        name: "userInfoListWrapperAndChatWrapper",
        fieldNumber: 13,
        type: "message",
        messageType: "UserInfoListWrapperAndChatWrapper"
      }
    ]
  },
  {
    name: "UserInfoListWrapperAndChatWrapper",
    fields: [
      {
        name: "userInfoListWrapper",
        fieldNumber: 1,
        type: "message",
        messageType: "UserInfoListWrapper"
      },
      {
        name: "chatMessageWrapper",
        fieldNumber: 4,
        type: "message",
        messageType: "ChatMessageWrapper",
        repeated: true
      }
    ]
  },
  {
    name: "ChatMessageWrapper",
    fields: [
      {
        name: "chatMessage",
        fieldNumber: 2,
        type: "message",
        messageType: "ChatMessage"
      }
    ]
  },
  {
    name: "ChatMessage",
    fields: [
      { name: "messageId", fieldNumber: 1, type: "string" },
      { name: "deviceId", fieldNumber: 2, type: "string" },
      { name: "timestamp", fieldNumber: 3, type: "int64" },
      {
        name: "chatMessageContent",
        fieldNumber: 5,
        type: "message",
        messageType: "ChatMessageContent"
      }
    ]
  },
  {
    name: "ChatMessageContent",
    fields: [{ name: "text", fieldNumber: 1, type: "string" }]
  },
  {
    name: "UserEventInfo",
    fields: [{ name: "eventNumber", fieldNumber: 1, type: "varint" }]
  },
  {
    name: "UserInfoListWrapper",
    fields: [
      {
        name: "userEventInfo",
        fieldNumber: 1,
        type: "message",
        messageType: "UserEventInfo"
      },
      {
        name: "userInfoList",
        fieldNumber: 2,
        type: "message",
        messageType: "UserInfoList",
        repeated: true
      }
    ]
  },
  {
    name: "DeviceInfoWrapper",
    fields: [
      {
        name: "deviceOutputInfoList",
        fieldNumber: 2,
        type: "message",
        messageType: "DeviceOutputInfoList",
        repeated: true
      }
    ]
  },
  {
    name: "DeviceOutputInfoList",
    fields: [
      { name: "deviceOutputType", fieldNumber: 2, type: "varint" }, // 1=audio, 2=video
      { name: "streamId", fieldNumber: 4, type: "string" }, // This IS the SSRC
      { name: "deviceId", fieldNumber: 6, type: "string" }, // The actual Device ID
      // Field 9: candidate per-device speaking/activity signal (probe v6). Its
      // varint at position 2 toggles per device; v6 correlates it against the
      // CSRC audio level for the same stream to decide if it means "speaking".
      {
        name: "deviceOutputActivity",
        fieldNumber: 9,
        type: "message",
        messageType: "DeviceOutputActivity"
      },
      {
        name: "deviceOutputStatus",
        fieldNumber: 10,
        type: "message",
        messageType: "DeviceOutputStatus"
      },
      // Field 14: NetEq-only per-device active-speaker candidate (probe v9). It
      // appears only where audio is server-mixed (no per-stream CSRC) and is
      // one-device-at-a-time, which is the dominant-speaker shape. Its varint
      // at position 1 is the flag.
      {
        name: "deviceOutputActiveSpeaker",
        fieldNumber: 14,
        type: "message",
        messageType: "DeviceOutputActiveSpeaker"
      }
    ]
  },
  {
    name: "DeviceOutputActivity",
    fields: [{ name: "value", fieldNumber: 2, type: "varint" }]
  },
  {
    name: "DeviceOutputActiveSpeaker",
    // Capture the first few varint sub-fields — the raw walk saw activity here
    // but we don't know which position holds the flag/level, so decode 1/2/3.
    fields: [
      { name: "v1", fieldNumber: 1, type: "varint" },
      { name: "v2", fieldNumber: 2, type: "varint" },
      { name: "v3", fieldNumber: 3, type: "varint" }
    ]
  },
  {
    name: "DeviceOutputStatus",
    fields: [{ name: "disabled", fieldNumber: 1, type: "varint" }]
  },
  {
    name: "UserInfoList",
    fields: [
      { name: "deviceId", fieldNumber: 1, type: "string" },
      { name: "fullName", fieldNumber: 2, type: "string" },
      { name: "profilePicture", fieldNumber: 3, type: "string" },
      { name: "status", fieldNumber: 4, type: "varint" },
      { name: "isCurrentUserString", fieldNumber: 7, type: "string" },
      { name: "parentDeviceId", fieldNumber: 21, type: "string" },
      { name: "displayName", fieldNumber: 29, type: "string" },
      { name: "isHost", fieldNumber: 34, type: "varint" }
    ]
  },
  // Fetch Response Wrapper
  {
    name: "UserInfoListResponse",
    fields: [
      {
        name: "userInfoListWrapperWrapper",
        fieldNumber: 2,
        type: "message",
        messageType: "UserInfoListWrapperWrapper"
      }
    ]
  },
  {
    name: "UserInfoListWrapperWrapper",
    fields: [
      {
        name: "userInfoListWrapper",
        fieldNumber: 2,
        type: "message",
        messageType: "UserInfoListWrapper"
      }
    ]
  }
]
