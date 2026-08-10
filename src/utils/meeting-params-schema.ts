import {
  array,
  boolean,
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
import { envVars } from "../config/env-vars"

const storageBucketSchema = string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)

export const StorageConfigSchema = object({
  endpoint: url().refine(
    (endpoint) => {
      const protocol = new URL(endpoint).protocol
      return protocol === "https:" || (protocol === "http:" && envVars.ENVIRON !== "prod")
    },
    { message: "customer storage endpoint must use HTTPS" }
  ),
  region: string().min(1),
  force_path_style: boolean().default(false),
  access_key_id: string().min(1),
  secret_access_key: string().min(1),
  artifacts_bucket: storageBucketSchema,
  audio_chunks_bucket: storageBucketSchema,
  logs_bucket: storageBucketSchema,
  // When false (the default for a team on its own storage) a failed upload must
  // NOT be parked on MeetingBaas EFS — the recording is given up on instead.
  // These teams are usually on their own bucket for data residency, and the EFS
  // fallback is the one path that puts a full recording on our volume.
  allow_transient_spill: boolean().default(false)
})

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
  })
    .nullable()
    .default(null),
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
  max_recording_duration: number()
    .int()
    .positive()
    .max(6 * 60 * 60)
    .nullable()
    .default(null),
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

  // The team's own object storage ("bring your own bucket"), when it has configured
  // one. Absent/null — the default — means the bot uploads to the platform buckets
  // from AWS_S3_*_BUCKET using the pod's ambient credentials, exactly as before.
  //
  // MUST stay in sync with StorageConfigMessage in api-server and the schema in
  // sqs-consumer: zod .parse() strips unknown keys, so a field missing from any of
  // the three is silently dropped between SQS and the bot's stdin — and the bot
  // would then write a customer's recording into OUR bucket while the api-server
  // looks for it in theirs.
  storage_config: optional(
    nullable(StorageConfigSchema)
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
