import { S3Client } from "@aws-sdk/client-s3"
import { GLOBAL } from "../singleton"
import { envVars } from "./env-vars"

/**
 * Where this bot writes its artifacts.
 *
 * Default (and the case for every team that hasn't asked for it): the platform
 * buckets from AWS_S3_*_BUCKET, uploaded with the pod's ambient AWS credentials —
 * exactly the behaviour that existed before "bring your own bucket".
 *
 * When api-server dispatched the bot with a `storage_config` — i.e. the team has
 * its own object storage — every bucket name and the S3 client come from that
 * config instead, so recordings, audio chunks, screenshots and logs land in the
 * customer's account and never touch ours.
 *
 * Everything here is resolved lazily through GLOBAL rather than captured at import
 * time: modules like Logger and PathManager are constructed before the meeting
 * params are parsed, so a module-level constant would freeze in the platform
 * values and quietly send a customer's recording to our bucket.
 */

export interface StorageBuckets {
  artifacts: string
  audioChunks: string
  logs: string
}

/** The dispatched storage config, or null before params are set / when unset. */
function customStorage() {
  return GLOBAL.tryGet()?.storage_config ?? null
}

export function storageBuckets(): StorageBuckets {
  const custom = customStorage()
  if (custom) {
    return {
      artifacts: custom.artifacts_bucket,
      audioChunks: custom.audio_chunks_bucket,
      logs: custom.logs_bucket
    }
  }
  return {
    artifacts: envVars.AWS_S3_ARTIFACTS_BUCKET,
    audioChunks: envVars.AWS_S3_AUDIO_CHUNKS_BUCKET,
    logs: envVars.AWS_S3_LOGS_BUCKET
  }
}

/** True when this bot is writing into a customer-owned bucket. */
export function usingCustomStorage(): boolean {
  return customStorage() !== null
}

/**
 * Whether an artifact whose S3 upload failed may be copied to MeetingBaas EFS for a
 * reconciliation job to push later.
 *
 * True on platform storage — that is the long-standing safety net and the artifact is
 * going to our bucket anyway. On customer storage it follows the team's
 * `allow_transient_spill`, which defaults to FALSE: those teams are usually there for
 * data residency, and this is the one path that puts a full recording (video, audio,
 * transcripts, chunks) on our volume in our account. When it is false the upload
 * failure is final and the artifact is reported as UPLOAD_FAILED — a deliberate trade
 * of durability for residency.
 */
export function transientSpillAllowed(): boolean {
  const custom = customStorage()
  if (!custom) return true
  return custom.allow_transient_spill
}

let cachedClient: S3Client | null = null
let cachedForCustom: boolean | null = null

/**
 * The S3 client every upload should use.
 *
 * Built once per process. A bot handles exactly one meeting, so the config cannot
 * change under us; the cache key still tracks whether we're on custom storage so a
 * client built before params were parsed (e.g. by an early log upload) is not
 * reused for the customer's bucket afterwards.
 */
export function storageS3Client(): S3Client {
  const custom = customStorage()
  const isCustom = custom !== null

  if (cachedClient && cachedForCustom === isCustom) {
    return cachedClient
  }

  cachedClient?.destroy()
  cachedClient = custom
    ? new S3Client({
        endpoint: custom.endpoint,
        region: custom.region,
        forcePathStyle: custom.force_path_style,
        // More attempts than the SDK default of 3. A customer bucket is off our
        // network and may be a different provider, so transient failures are likelier
        // here than against the platform bucket — and when transient spill is off there
        // is no EFS safety net behind this, so a blip that exhausts the retries loses
        // the recording outright. Still bounded by the caller's UPLOAD_TIMEOUT_MS wall
        // clock, so this cannot extend a bot's life.
        maxAttempts: 6,
        credentials: {
          accessKeyId: custom.access_key_id,
          secretAccessKey: custom.secret_access_key
        }
      })
    : // AWS SDK v3 automatically detects credentials, endpoint (AWS_ENDPOINT_URL)
      // and region from the environment / pod IAM role.
      new S3Client()
  cachedForCustom = isCustom
  return cachedClient
}
