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
 */
export function buildRetryMessage(): any {
    const params = GLOBAL.get()
    const currentRetryCount = GLOBAL.getRetryCount()
    
    return {
        meeting_url: params.meeting_url,
        user_id: params.user_id ?? null,
        session_id: params.session_id ?? null,
        user_token: params.user_token,
        bots_api_key: params.bots_api_key,
        bot_name: params.bot_name,
        enter_message: params.enter_message ?? null,
        bots_webhook_url: params.bots_webhook_url ?? '',
        bot_uuid: params.bot_uuid,
        // Zoom-specific fields excluded from retry - not used by recording server
        zoom_access_token_url: null,
        speech_to_text_provider: params.speech_to_text_provider ?? null,
        speech_to_text_api_key: params.speech_to_text_api_key ?? null,
        custom_branding_bot_path: params.custom_branding_bot_path ?? null,
        streaming_input: params.streaming_input ?? null,
        streaming_output: params.streaming_output ?? null,
        streaming_audio_frequency: params.streaming_audio_frequency ?? null,
        recording_mode: params.recording_mode,
        automatic_leave: params.automatic_leave ?? null,
        mp4_s3_path: params.mp4_s3_path,
        secret: params.secret ?? '',
        // Zoom SDK credentials excluded from retry - not used by recording server
        zoom_sdk_id: null,
        zoom_sdk_pwd: null,
        transcription_custom_parameters: null,
        extra: params.extra ?? null,
        start_time: params.start_time ?? null,
        event: params.event ?? null,
        environ: params.environ,
        aws_s3_temporary_audio_bucket: params.aws_s3_temporary_audio_bucket,
        remote: params.remote,
        
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

