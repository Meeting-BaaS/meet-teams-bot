import { number, object, string, url, uuid, enum as zodEnum } from "zod"

export const RecordingModeSchema = zodEnum(["speakerView", "audioOnly", "galleryView"])

/**
 * Input parameters schema for bot messages
 * This matches the baas-config-scheme InputParameters from the Rust code
 */
export const BotMessageSchema = object({
  botId: number().int().positive(),
  botUuid: uuid(),
  botName: string(),
  botImage: url().nullable(),
  meetingUrl: url(),
  transformedMeetingUrl: url().nullable(),
  meetingPlatform: zodEnum(["zoom", "meet", "teams"]),
  entryMessage: string().nullable(),
  recordingMode: RecordingModeSchema.default("speakerView"),
  streamingInput: url().nullable(),
  streamingOutput: url().nullable(),
  streamingAudioFrequency: number().int().positive().default(24000),
  startTime: number().int().default(0),
  exitTime: number().int().default(0),
  waitingRoomTimeout: number().int().positive().default(600),
  noOneJoinedTimeout: number().int().positive().default(600),
  speechToTextProvider: zodEnum(["gladia", "assembly", "none"]).default("gladia")
})
