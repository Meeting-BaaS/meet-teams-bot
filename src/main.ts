import { Api } from './api/methods'
import { Events } from './events'
import { server } from './server'
import { GLOBAL } from './singleton'
import { MeetingStateMachine } from './state-machine/machine'
import { detectMeetingProvider } from './utils/detectMeetingProvider'
import {
    setupConsoleLogger,
    setupFileLogging,
    setupExitHandler,
    uploadLogsToS3,
    formatError,
} from './utils/Logger'
import { PathManager } from './utils/PathManager'
import {
    shouldAttemptRetry,
    buildRetryMessage,
    requeueToSQS,
    formatRetryErrorMessage,
    MAX_RETRY_COUNT,
} from './utils/retry-handler'

import { getErrorMessageFromCode } from './state-machine/types'
import { MeetingParams } from './types'

import { exit } from 'process'

// ========================================
// CONFIGURATION
// ========================================

// Setup console logger first to ensure proper formatting
setupConsoleLogger()

// Setup crash handlers to upload logs in case of unexpected exit
setupExitHandler()

// Configuration to enable/disable DEBUG logs
export const DEBUG_LOGS =
    process.argv.includes('--debug') || process.env.DEBUG_LOGS === 'true'
if (DEBUG_LOGS) {
    console.log('🐛 DEBUG mode activated - speakers debug logs will be shown')
    // Dynamically import page-logger to enable page logs only when DEBUG_LOGS is true
    // This is done to avoid circular dependency issues
    import('./browser/page-logger')
        .then(({ enablePrintPageLogs }) => enablePrintPageLogs())
        .catch((e) =>
            console.error('Failed to enable page logs dynamically:', e),
        )
}

// ========================================
// UTILITY FUNCTIONS
// ========================================

/**
 * Read and parse meeting parameters from stdin
 */
async function readFromStdin(): Promise<MeetingParams> {
    return new Promise((resolve) => {
        let data = ''
        process.stdin.on('data', (chunk) => {
            data += chunk
        })

        process.stdin.on('end', () => {
            try {
                const params = JSON.parse(data) as MeetingParams

                // Detect the meeting provider
                params.meetingProvider = detectMeetingProvider(
                    params.meeting_url,
                )
                GLOBAL.set(params)
                PathManager.getInstance().initializePaths()
                setupFileLogging()
                resolve(params)
            } catch (error) {
                console.error('Failed to parse JSON from stdin:', formatError(error))
                console.error('Raw data was:', JSON.stringify(data))
                process.exit(1)
            }
        })
    })
}

/**
 * Handle successful recording completion
 */
async function handleSuccessfulRecording(): Promise<void> {
    console.log(`${Date.now()} Finalize project && Sending WebHook complete`)

    // Log the end reason for debugging
    console.log(
        `Recording ended normally with reason: ${MeetingStateMachine.instance.getEndReason()}`,
    )

    // Handle API endpoint call with built-in retry logic
    if (!GLOBAL.isServerless()) {
        await Api.instance.handleEndMeetingWithRetry()
    }

    // Send success webhook
    await Events.recordingSucceeded()
}

/**
 * Handle failed recording
 */
async function handleFailedRecording(): Promise<void> {
    console.error('Recording did not complete successfully')

    const endReason = GLOBAL.getEndReason()
    const originalErrorMessage = GLOBAL.getErrorMessage()
    const currentRetryCount = GLOBAL.getRetryCount()
    
    console.log(`Recording failed with reason: ${endReason || 'Unknown'}`)
    console.log(`Error message: ${originalErrorMessage || 'None'}`)
    console.log(`Should retry: ${GLOBAL.getShouldRetry()}`)
    console.log(`Current retry count: ${currentRetryCount}/${MAX_RETRY_COUNT}`)

    // Early return for serverless mode - no SQS retry available
    if (GLOBAL.isServerless()) {
        console.log('🚫 Serverless mode - skipping retry logic')
        const errorMessage =
            originalErrorMessage ||
            (endReason
                ? getErrorMessageFromCode(endReason)
                : 'Recording did not complete successfully')
        await Events.recordingFailed(errorMessage)
        console.log(`✅ Error webhook sent`)
        return
    }

    // Check if we should retry instead of failing permanently
    const shouldRetry = shouldAttemptRetry(currentRetryCount)

    if (shouldRetry) {
        console.log(
            `🔄 Error marked as retryable - attempting retry ${currentRetryCount + 1}/${MAX_RETRY_COUNT}`
        )

        try {
            // Build and send retry message to SQS
            const retryMessage = buildRetryMessage()
            await requeueToSQS(retryMessage)

            // Send webhook with retry indication
            const retryErrorMessage = formatRetryErrorMessage(
                originalErrorMessage || 'Recording failed',
                currentRetryCount
            )
            await Events.recordingFailed(retryErrorMessage)

            console.log(
                `✅ Job requeued successfully - exiting without calling backend`
            )
            // Exit cleanly - new pod will handle retry
            return
        } catch (error) {
            console.error(
                `❌ Failed to requeue message:`,
                error instanceof Error ? error.message : error
            )
            console.log(`⚠️ Falling back to normal failure flow`)
            // Fall through to normal failure handling
        }
    } else {
        if (GLOBAL.getShouldRetry()) {
            console.log(
                `🚫 Maximum retry attempts reached (${currentRetryCount}/${MAX_RETRY_COUNT}) - reporting failure`
            )
        } else {
            console.log(`🚫 Error not retryable - reporting failure immediately`)
        }
    }

    // Normal failure handling (original code)
    const errorMessage =
        originalErrorMessage ||
        (endReason
            ? getErrorMessageFromCode(endReason)
            : 'Recording did not complete successfully')

    await Events.recordingFailed(errorMessage)

    console.log(`📤 Sending error to backend`)

    if (!GLOBAL.isServerless() && Api.instance) {
        await Api.instance.notifyRecordingFailure()
    }
    console.log(`✅ Error sent to backend successfully`)
}

// ========================================
// MAIN ENTRY POINT
// ========================================

/**
 * Main application entry point
 *
 * Syntax conventions:
 * - minus => Library
 * - CONST => Const
 * - camelCase => Fn
 * - PascalCase => Classes
 */
;(async () => {
    const meetingParams = await readFromStdin()

    try {
        // Log all meeting parameters (masking sensitive data)
        const logParams = { ...meetingParams }

        // Mask sensitive data for security
        if (logParams.user_token) logParams.user_token = '***MASKED***'
        if (logParams.bots_api_key) logParams.bots_api_key = '***MASKED***'
        if (logParams.speech_to_text_api_key)
            logParams.speech_to_text_api_key = '***MASKED***'
        if (logParams.zoom_sdk_pwd) logParams.zoom_sdk_pwd = '***MASKED***'
        if (logParams.secret) logParams.secret = '***MASKED***'

        console.log(
            'Received meeting parameters:',
            JSON.stringify(logParams, null, 2),
        )

        console.log('About to redirect logs to bot:', meetingParams.bot_uuid)
        console.log('Logs redirected successfully')

        // Start the server
        await server().catch((e) => {
            console.error(`Failed to start server: ${e}`)
            throw e
        })
        console.log('Server started successfully')

        // Initialize components
        MeetingStateMachine.init()
        Events.init()
        Events.joiningCall()

        // Create API instance for non-serverless mode
        if (!GLOBAL.isServerless()) {
            new Api()
        }

        // Start the meeting recording
        await MeetingStateMachine.instance.startRecordMeeting()

        // Handle recording result
        if (MeetingStateMachine.instance.wasRecordingSuccessful()) {
            await handleSuccessfulRecording()
        } else {
            await handleFailedRecording()
        }
    } catch (error) {
        // Handle explicit errors from state machine
        console.error(
            'Meeting failed:',
            error instanceof Error ? error.message : error,
        )

        // Delegate to handleFailedRecording which includes retry logic
        await handleFailedRecording()
    } finally {
        if (!GLOBAL.isServerless()) {
            try {
                await uploadLogsToS3({})
            } catch (error) {
                console.error('Failed to upload logs to S3:', formatError(error))
            }
        }
        console.log('exiting instance')
        exit(0)
    }
})()
