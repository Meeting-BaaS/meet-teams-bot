import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs"
import { GLOBAL } from "../singleton"
import type { MeetingParams } from "../types"

export const MAX_RETRY_COUNT = 10

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

  // Check retry limit
  if (currentRetryCount >= MAX_RETRY_COUNT) {
    return false
  }

  return true
}

/**
 * Builds SQS message for retry with incremented retry_count
 */
export function buildRetryMessage(): MeetingParams {
  const params = GLOBAL.get()
  const currentRetryCount = GLOBAL.getRetryCount()

  return {
    ...params,
    // Increment retry count
    retry_count: currentRetryCount + 1
  }
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

  const client = createSQSClient()

  const command = new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(message)
  })

  await client.send(command)

  const retryCount = message.retry_count
  console.log(`✅ Requeued to SQS for retry ${retryCount}/${MAX_RETRY_COUNT}`)
}

/**
 * Formats error message to indicate retry attempt
 */
export function formatRetryErrorMessage(originalMessage: string, retryCount: number): string {
  const attemptNumber = retryCount + 1
  const totalAttempts = MAX_RETRY_COUNT + 1
  return `${originalMessage} - Retrying (${attemptNumber}/${totalAttempts})`
}
