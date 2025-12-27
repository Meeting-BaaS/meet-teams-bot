import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { GLOBAL } from '../singleton'

export const MAX_RETRY_COUNT = 2

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
        console.log('🔐 Using SQS-specific credentials for authentication')
        return new SQSClient({
            credentials: {
                accessKeyId: sqsAccessKey,
                secretAccessKey: sqsSecretKey,
            }
        })
    } else {
        console.log('🔐 Using default AWS credentials for SQS (EKS IAM role or default chain)')
        // AWS SDK v3 automatically handles credential detection
        return new SQSClient()
    }
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
 * Uses v2 BotMessageSchema format
 */
export function buildRetryMessage(): any {
    const params = GLOBAL.get()
    const currentRetryCount = GLOBAL.getRetryCount()

    return {
        // Core identifiers
        bot_id: params.bot_id,
        bot_uuid: params.bot_uuid,
        bot_name: params.bot_name,

        // Meeting details
        meeting_url: params.meeting_url,
        transformed_meeting_url: params.transformed_meeting_url ?? null,
        meeting_platform: params.meeting_platform,

        // Bot configuration
        bot_image: params.bot_image ?? null,
        entry_message: params.entry_message ?? null,
        recording_mode: params.recording_mode,
        extra: params.extra ?? null,
        data_retention_days: params.data_retention_days,

        // Streaming
        streaming_input: params.streaming_input ?? null,
        streaming_output: params.streaming_output ?? null,
        streaming_audio_frequency: params.streaming_audio_frequency ?? 24000,

        // Timeouts
        start_time: params.start_time ?? 0,
        exit_time: params.exit_time ?? 0,
        waiting_room_timeout: params.waiting_room_timeout ?? 600,
        no_one_joined_timeout: params.no_one_joined_timeout ?? 600,
        silence_timeout: params.silence_timeout ?? 600,

        // Transcription
        speech_to_text_provider: params.speech_to_text_provider ?? 'none',

        // Increment retry count
        retry_count: currentRetryCount + 1
    }
}

/**
 * Sends retry message to SQS queue
 * Uses SQS_QUEUE_URL from container environment (already available)
 */
export async function requeueToSQS(message: any): Promise<void> {
    const queueUrl = process.env.SQS_QUEUE_URL
    if (!queueUrl) {
        throw new Error('SQS_QUEUE_URL environment variable not set')
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
export function formatRetryErrorMessage(
    originalMessage: string,
    retryCount: number
): string {
    const attemptNumber = retryCount + 1
    const totalAttempts = MAX_RETRY_COUNT + 1
    return `${originalMessage} - Retrying (${attemptNumber}/${totalAttempts})`
}

