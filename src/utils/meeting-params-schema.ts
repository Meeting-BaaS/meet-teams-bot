import {
  number,
  object,
  record,
  string,
  url,
  uuid,
  enum as zodEnum,
  unknown as zodUnknown
} from "zod"

export const RecordingModeSchema = zodEnum(["speaker_view", "audio_only", "gallery_view"])
export const SpeechToTextProviderSchema = zodEnum(["gladia", "assembly", "none"])
export const MeetingPlatformSchema = zodEnum(["zoom", "meet", "teams"])

/**
 * Input parameters schema for bot messages
 * This matches the baas-config-scheme InputParameters from the Rust code
 */
export const BotMessageSchema = object({
  bot_id: number().int().positive(),
  bot_uuid: uuid(),
  bot_name: string(),
  extra: record(string(), zodUnknown()).nullable().default(null),
  data_retention_days: number().int().positive(),
  bot_image: url().nullable(),
  meeting_url: url(),
  transformed_meeting_url: url().nullable(),
  meeting_platform: MeetingPlatformSchema,
  entry_message: string().nullable(),
  recording_mode: RecordingModeSchema.default("speaker_view"),
  streaming_input: url().nullable(),
  streaming_output: url().nullable(),
  streaming_audio_frequency: number().int().positive().default(24000),
  start_time: number().int().default(0),
  exit_time: number().int().default(0),
  waiting_room_timeout: number().int().positive().default(600),
  no_one_joined_timeout: number().int().positive().default(600),
  silence_timeout: number().int().positive().default(600),
  speech_to_text_provider: SpeechToTextProviderSchema.default("none")
})
