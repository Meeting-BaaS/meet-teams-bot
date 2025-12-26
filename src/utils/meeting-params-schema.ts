import {
  array,
  boolean,
  number,
  object,
  type output,
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

/**
 * Streaming transcription options schema
 */
export const StreamingTranscriptionOptionsSchema = object({
  interim_results: boolean().default(true),
  language: string().nullable().default(null),
  diarization: boolean().default(false),
  word_timestamps: boolean().default(false),
  punctuation: boolean().default(true),
  profanity_filter: boolean().default(false),
  custom_vocabulary: array(string()).nullable().default(null),
  endpointing_ms: number().int().min(100).max(10000).nullable().default(null)
})

/**
 * Streaming transcription config schema
 * Contains all config needed for real-time transcription via VoiceRouter SDK
 */
export const StreamingTranscriptionSchema = object({
  output_url: url(),
  provider: StreamingTranscriptionProviderSchema.default("gladia"),
  api_key: string().nullable().default(null),
  encoding: string().default("linear16"),
  sample_rate: string().default("16000"),
  options: StreamingTranscriptionOptionsSchema.nullable().default(null)
})

export type StreamingTranscriptionConfig = output<typeof StreamingTranscriptionSchema>
export type StreamingTranscriptionOptions = output<typeof StreamingTranscriptionOptionsSchema>

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
  streaming_transcription: StreamingTranscriptionSchema.nullable().default(null),
  start_time: number().int().default(0),
  exit_time: number().int().default(0),
  waiting_room_timeout: number().int().positive().default(600),
  no_one_joined_timeout: number().int().positive().default(600),
  speech_to_text_provider: SpeechToTextProviderSchema.default("none")
})

export type BotMessage = output<typeof BotMessageSchema>
