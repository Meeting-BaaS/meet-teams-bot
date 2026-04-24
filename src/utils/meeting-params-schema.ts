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
export const SpeechToTextProviderSchema = zodEnum([
  "gladia", "deepgram", "assemblyai", "speechmatics", "soniox", "none"
])
export const StreamingModeSchema = zodEnum(["audio", "transcription"])
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
  bot_image: string().nullable(), // Pipe-separated URLs when multiple images
  bot_image_config: object({
    loop_mode: zodEnum(["auto", "bot_status"]),
    image_duration: number().int().min(10).max(120)
  }).nullable().default(null),
  meeting_url: url(),
  transformed_meeting_url: url().nullable(),
  meeting_platform: MeetingPlatformSchema,
  entry_message: string().nullable(),
  recording_mode: RecordingModeSchema.default("speaker_view"),
  streaming_input: url().nullable(),
  streaming_output: url().nullable(),
  streaming_audio_frequency: number().int().positive().default(24000),
  streaming_mode: StreamingModeSchema.nullable().optional().default(null),
  streaming_transcription: object({
    provider: string(),
    encrypted_api_key: string().nullable(),
    region: string().nullable(),
    custom_params: record(string(), zodUnknown()).nullable()
  }).nullable().optional().default(null),
  start_time: number().int().default(0),
  exit_time: number().int().default(0),
  waiting_room_timeout: number().int().positive().default(600),
  no_one_joined_timeout: number().int().positive().default(600),
  silence_timeout: number().int().positive().default(600),
  speech_to_text_provider: SpeechToTextProviderSchema.default("none"),
  encrypted_speech_to_text_api_key: string().nullable().optional().default(null),
  speech_to_text_region: string().nullable().optional().default(null),
  speech_to_text_custom_params: record(string(), zodUnknown()).nullable().optional().default(null),
  retry_count: number().int().nonnegative().default(0),
  zoom_config: object({
    sdk_id: string().optional(),
    sdk_secret: string().optional(),
    credential_id: uuid().optional(),
    obf_token: string().optional(),
    obf_token_url: url().optional(),
    zak_token_url: url().optional()
  }).nullable().optional().default(null)
})
