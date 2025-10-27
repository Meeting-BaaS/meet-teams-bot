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
  botImage: url().optional(),
  meetingUrl: url(),
  transformedMeetingUrl: url().optional(),
  meetingPlatform: zodEnum(["zoom", "meet", "teams"]),
  entryMessage: string().optional(),
  recordingMode: RecordingModeSchema.default("speakerView"),
  streamingInput: url().optional(),
  streamingOutput: url().optional(),
  streamingAudioFrequency: number().int().positive().default(24000),
  startTime: number().int().positive().default(0),
  exitTime: number().int().positive().default(0),
  waitingRoomTimeout: number().int().positive().default(600),
  noOneJoinedTimeout: number().int().positive().default(600),
  eventUuid: uuid().optional(),
  speechToTextProvider: zodEnum(["gladia", "assembly"]).default("gladia")
})
