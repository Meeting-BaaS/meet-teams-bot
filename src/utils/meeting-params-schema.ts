import {
  array,
  nullable,
  number,
  object,
  optional,
  record,
  string,
  url,
  uuid,
  enum as zodEnum,
  unknown as zodUnknown
} from "zod"

export const RecordingModeSchema = zodEnum(["speaker_view", "audio_only", "gallery_view"])
export const SpeechToTextProviderSchema = zodEnum([
  "gladia",
  "deepgram",
  "assemblyai",
  "speechmatics",
  "soniox",
  "none"
])
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
  start_time: number().int().default(0),
  exit_time: number().int().default(0),
  waiting_room_timeout: number().int().positive().default(600),
  no_one_joined_timeout: number().int().positive().default(600),
  silence_timeout: number().int().positive().default(600),
  grace_period: number().int().nonnegative().default(0),
  ignored_participant_names: array(string()).default([]),
  speech_to_text_provider: SpeechToTextProviderSchema.default("none"),
  retry_count: number().int().nonnegative().default(0),

  // ISO-3166 alpha-2 countries the residential proxy exit may pin to, chosen by
  // the team in settings (api-server passes them through). The bot picks one;
  // if that region's pool is unreachable it falls through to the next. Empty =
  // no pinning (env RESIDENTIAL_PROXY_COUNTRY default applies).
  proxy_countries: array(string()).default([]),

  // Meet SSO authenticated bot config — present when api-server assigned a meet_login.
  // Bot uses these to sign in to Google before joining the meeting.
  meet_sso_config: optional(
    nullable(
      object({
        session_id: uuid(),
        login_email: string().email(),
        set_cookie_url: url(),
        fallback: zodEnum(["fail", "anonymous"]).default("anonymous")
      })
    )
  ).default(null),

  // Teams authenticated bot config — present when api-server assigned a teams_login.
  // Bot fetches { email, password } from resolve_url and signs in before joining.
  teams_login_config: optional(
    nullable(
      object({
        session_id: uuid(),
        login_email: string().email(),
        resolve_url: url(),
        fallback: zodEnum(["fail", "anonymous"]).default("anonymous")
      })
    )
  ).default(null)
})
