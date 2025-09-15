import { Api } from './api/methods'
import { Events } from './events'
import { server } from './server'
import { GLOBAL } from './singleton'
import { MeetingStateMachine } from './state-machine/machine'
import { detectMeetingProvider } from './utils/detectMeetingProvider'
import {
    setupConsoleLogger,
    setupExitHandler,
    uploadLogsToS3,
} from './utils/Logger'
import { PathManager } from './utils/PathManager'

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
 * Read and parse meeting parameters from stdin (legacy mode)
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
                resolve(params)
            } catch (error) {
                console.error('Failed to parse JSON from stdin:', error)
                console.error('Raw data was:', JSON.stringify(data))
                process.exit(1)
            }
        })
    })
}

/**
 * Read meeting parameters from ECS metadata (Fargate mode)
 */
async function readFromEcsMetadata(): Promise<MeetingParams> {
    try {
        // Get ECS task metadata
        // const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4
        // if (!metadataUri) {
        //     throw new Error('ECS_CONTAINER_METADATA_URI_V4 not found in environment')
        // }

        // console.log('📡 Reading parameters from ECS metadata...')
        
        // // Get task metadata
        // const taskResponse = await fetch(`${metadataUri}/task`)
        //  if (!taskResponse.ok) {
        //     throw new Error(`Failed to fetch task metadata: ${taskResponse.status} ${taskResponse.statusText}`)
        // }
        // const taskMetadata = await taskResponse.json()
        
        // // Get container metadata
        // const containerResponse = await fetch(`${metadataUri}`)
        // if (!containerResponse.ok) {
        //     throw new Error(`Failed to fetch container metadata: ${containerResponse.status} ${containerResponse.statusText}`)
        // }
        // const containerMetadata = await containerResponse.json()
        
        // console.log('📋 ECS Task ARN:', taskMetadata.TaskARN)
        // console.log('📋 ECS Container Name:', containerMetadata.Name)
        
        // Look for parameters in environment variables (passed via task definition)
        const meetingParams: MeetingParams = {
            id: process.env.MEETING_ID || '',
            use_my_vocabulary: process.env.USE_MY_VOCABULARY === 'true',
            meeting_url: process.env.MEETING_URL || '',
            user_token: process.env.USER_TOKEN || '',
            bot_name: process.env.BOT_NAME || '',
            user_id: parseInt(process.env.USER_ID || '0'),
            session_id: process.env.SESSION_ID || '',
            email: process.env.EMAIL || '',
            meetingProvider: detectMeetingProvider(
                    process.env.MEETING_URL || '',
                ),
            event: process.env.EVENT_ID ? { id: parseInt(process.env.EVENT_ID) } : undefined,
            agenda: process.env.AGENDA ? JSON.parse(process.env.AGENDA) : undefined,
            custom_branding_bot_path: process.env.CUSTOM_BRANDING_BOT_PATH,
            vocabulary: process.env.VOCABULARY ? JSON.parse(process.env.VOCABULARY) : [],
            force_lang: process.env.FORCE_LANG === 'true',
            translation_lang: process.env.TRANSLATION_LANG,
            speech_to_text_provider: (process.env.SPEECH_TO_TEXT_PROVIDER as any) || 'Default',
            speech_to_text_api_key: process.env.SPEECH_TO_TEXT_API_KEY,
            streaming_input: process.env.STREAMING_INPUT,
            streaming_output: process.env.STREAMING_OUTPUT,
            streaming_audio_frequency: process.env.STREAMING_AUDIO_FREQUENCY ? parseInt(process.env.STREAMING_AUDIO_FREQUENCY) : undefined,
            bot_uuid: process.env.BOT_UUID || '',
            enter_message: process.env.ENTER_MESSAGE,
            bots_api_key: process.env.BOTS_API_KEY || '',
            bots_webhook_url: process.env.BOTS_WEBHOOK_URL,
            recording_mode: (process.env.RECORDING_MODE as any) || 'speaker_view',
            local_recording_server_location: process.env.LOCAL_RECORDING_SERVER_LOCATION || '',
            automatic_leave: {
                waiting_room_timeout: parseInt(process.env.WAITING_ROOM_TIMEOUT || '300'),
                noone_joined_timeout: parseInt(process.env.NOONE_JOINED_TIMEOUT || '300'),
            },
            mp4_s3_path: process.env.MP4_S3_PATH || '',
            environ: process.env.ENVIRON || 'preprod',
            aws_s3_temporary_audio_bucket: process.env.AWS_S3_TEMPORARY_AUDIO_BUCKET || '',
            remote: {
                api_server_baseurl: process.env.API_SERVER_URL || '',
                aws_s3_video_bucket: process.env.AWS_S3_VIDEO_BUCKET || '',
                aws_s3_log_bucket: process.env.AWS_S3_LOG_BUCKET || '',
            },
            extra: process.env.EXTRA ? JSON.parse(process.env.EXTRA) : undefined,
            zoom_sdk_id: process.env.ZOOM_SDK_ID,
            zoom_sdk_pwd: process.env.ZOOM_SDK_PWD,
        }

        // Detect the meeting provider
        meetingParams.meetingProvider = detectMeetingProvider(meetingParams.meeting_url)
        
        // Validate required parameters
        if (!meetingParams.meeting_url || !meetingParams.bot_uuid || !meetingParams.session_id) {
            throw new Error('Missing required parameters: meeting_url, bot_uuid, or session_id')
        }

        GLOBAL.set(meetingParams)
        PathManager.getInstance().initializePaths()
        
        console.log('✅ Successfully loaded parameters from ECS metadata')
        return meetingParams
    } catch (error) {
        console.error('❌ Failed to read parameters from ECS metadata:', error)
        throw error
    }
}

/**
 * Determine parameter source and read accordingly
 */
async function readMeetingParams(): Promise<MeetingParams> {
    // Check if we're running in Fargate (ECS metadata available)
    if (process.env.ECS_CONTAINER_METADATA_URI_V4) {
        console.log('🚀 Running in Fargate mode - reading from ECS metadata')
        return await readFromEcsMetadata()
    } else {
        console.log('�� Running in legacy mode - reading from stdin')
        return await readFromStdin()
    }
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

    // Log the end reason for debugging
    const endReason = GLOBAL.getEndReason()
    console.log(`Recording failed with reason: ${endReason || 'Unknown'}`)

    // Send failure webhook to user before sending to backend
    const errorMessage =
        (GLOBAL.hasError() && GLOBAL.getErrorMessage()) ||
        (endReason
            ? getErrorMessageFromCode(endReason)
            : 'Recording did not complete successfully')
    await Events.recordingFailed(errorMessage)

    console.log(`📤 Sending error to backend`)

    // Notify backend of recording failure (function deduces errorCode and message automatically)
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
    const meetingParams = await readMeetingParams()

    try {
        // Log all meeting parameters (masking sensitive data)
        const logParams = { ...meetingParams }

        // Mask sensitive data for security
        if (logParams.user_token) logParams.user_token = '***MASKED***'
        if (logParams.bots_api_key) logParams.bots_api_key = '***MASKED***'
        if (logParams.speech_to_text_api_key)
            logParams.speech_to_text_api_key = '***MASKED***'
        if (logParams.zoom_sdk_pwd) logParams.zoom_sdk_pwd = '***MASKED***'

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

        // Use global error if available, otherwise fallback to error message
        const errorMessage = GLOBAL.hasError()
            ? GLOBAL.getErrorMessage() || 'Unknown error'
            : error instanceof Error
              ? error.message
              : 'Recording failed to complete'

        // Send failure webhook to user before sending to backend
        await Events.recordingFailed(errorMessage)

        console.log(`📤 Sending error to backend: ${errorMessage}`)

        // Notify backend of recording failure
        if (!GLOBAL.isServerless() && Api.instance) {
            await Api.instance.notifyRecordingFailure()
        }

        console.log(`✅ Error sent to backend successfully`)
    } finally {
        if (!GLOBAL.isServerless()) {
            try {
                await uploadLogsToS3({})
            } catch (error) {
                console.error('Failed to upload logs to S3:', error)
            }
        }
        console.log('exiting instance')
        exit(0)
    }
})()
