import {
  array,
  boolean,
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
export const StreamingTranscriptionProviderSchema = zodEnum(["gladia", "deepgram", "assemblyai"])

// Streaming transcription options schema
export const StreamingTranscriptionOptionsSchema = object({
  language: string().optional(),
  interim_results: boolean().optional(),
  diarization: boolean().optional(),
  word_timestamps: boolean().optional(),
  punctuation: boolean().optional(),
  profanity_filter: boolean().optional(),
  custom_vocabulary: array(string()).optional().nullable(),
  endpointing_ms: number().int().positive().optional().nullable()
}).optional().nullable()

// Streaming transcription config schema
export const StreamingTranscriptionConfigSchema = object({
  provider: StreamingTranscriptionProviderSchema.default("gladia"),
  api_key: string().optional().nullable(),
  output_url: url(),
  websocket_timeout_ms: number().int().positive().optional(),
  encoding: string().optional(),
  sample_rate: number().int().positive().optional(),
  options: StreamingTranscriptionOptionsSchema
})

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
  speech_to_text_provider: SpeechToTextProviderSchema.default("none"),
  retry_count: number().int().nonnegative().default(0),
  streaming_transcription: StreamingTranscriptionConfigSchema.nullable().default(null)
})
