import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs"
import { getMaxRetryCount } from "../config/retry-config"
import { GLOBAL } from "../singleton"
import type { MeetingParams } from "../types"

/**
 * Creates SQS client with same credential logic as smart-rabbit
 * Supports both EKS IAM roles and explicit env var credentials (on-prem)
 *
 * Note: All env vars are available in container - no need to pass from smart-rabbit
 */
function createSQSClient(): SQSClient {
  // Check for SQS-specific credentials (for on-prem/Scaleway deployments)
  const sqsAccessKey = process.env.AWS_ACCESS_KEY_ID_SQS
  const sqsSecretKey = process.env.AWS_SECRET_ACCESS_KEY_SQS

  if (sqsAccessKey && sqsSecretKey) {
    console.log("🔐 Using SQS-specific credentials for authentication")
    return new SQSClient({
      credentials: {
        accessKeyId: sqsAccessKey,
        secretAccessKey: sqsSecretKey
      }
    })
  }
  console.log("🔐 Using default AWS credentials for SQS (EKS IAM role or default chain)")
  // AWS SDK v3 automatically handles credential detection
  return new SQSClient()
}

/**
 * Determines if we should retry based on retry flag and count
 */
export function shouldAttemptRetry(currentRetryCount: number): boolean {
  // Check if error was marked as retryable
  if (!GLOBAL.getShouldRetry()) {
    return false
  }

  // Check retry limit (Zoom web gets more attempts — see getMaxRetryCount).
  if (currentRetryCount >= getMaxRetryCount()) {
    return false
  }

  return true
}

/** True only for a well-formed http(s) URL (matches the retry schema's url()). */
function isValidHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false
  try {
    const u = new URL(value)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

/**
 * Builds SQS message for retry with incremented retry_count.
 *
 * transformed_meeting_url must be null OR a valid URL: the waiting-room state
 * overwrites it with the bare meeting ID (not a URL), which fails the retry
 * consumer's url() schema and silently kills the retry. We null anything that
 * isn't a real URL; the retry run re-derives it from meeting_url.
 */
export function buildRetryMessage(): MeetingParams {
  const params = GLOBAL.get()
  const currentRetryCount = GLOBAL.getRetryCount()

  const message = {
    ...params,
    transformed_meeting_url: isValidHttpUrl(params.transformed_meeting_url)
      ? params.transformed_meeting_url
      : null,
    retry_count: currentRetryCount + 1,
    // This process IS the Zoom *web* engine — the native SDK path is a separate
    // Rust binary (client-zoom) that never runs this code. The consumer schema
    // defaults a missing zoom_engine to "sdk", so a retry that omits it gets
    // routed to the SDK bot, which isn't in this image → `spawn … ENOENT` and a
    // crash before the retry can even proceed. Re-stamp "web" for zoom so the
    // requeue relaunches on the web engine. Absent (ignored) for meet/teams.
    ...(params.meeting_platform === "zoom" ? { zoom_engine: "web" as const } : {})
  }

  return message as MeetingParams
}

/**
 * Sends retry message to SQS queue
 * Uses SQS_QUEUE_URL from container environment (already available)
 */
export async function requeueToSQS(message: MeetingParams): Promise<void> {
  const queueUrl = process.env.SQS_QUEUE_URL
  if (!queueUrl) {
    throw new Error("SQS_QUEUE_URL environment variable not set")
  }

  // Guard the URL BEFORE enqueueing. A bad meeting_url fails the consumer's
  // schema and the retry dies silently on the other side; throwing here surfaces
  // it as a normal failure (main.ts catches and falls back) instead.
  if (!isValidHttpUrl(message.meeting_url)) {
    throw new Error(
      `Retry aborted: meeting_url is not a valid URL (${String(message.meeting_url)})`
    )
  }
  if (message.transformed_meeting_url !== null && !isValidHttpUrl(message.transformed_meeting_url)) {
    throw new Error(
      `Retry aborted: transformed_meeting_url must be null or a URL (${String(message.transformed_meeting_url)})`
    )
  }

  const client = createSQSClient()

  const command = new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(message)
  })

  await client.send(command)

  const retryCount = message.retry_count
  console.log(`✅ Requeued to SQS for retry ${retryCount}/${getMaxRetryCount()}`)
}

/**
 * Formats error message to indicate retry attempt
 */
export function formatRetryErrorMessage(originalMessage: string, retryCount: number): string {
  const attemptNumber = retryCount + 1
  const totalAttempts = getMaxRetryCount() + 1
  return `${originalMessage} - Retrying (${attemptNumber}/${totalAttempts})`
}
