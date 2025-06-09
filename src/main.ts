import {
    API_SERVER_BASEURL,
    LOCK_INSTANCE_AT_STARTUP,
    delSessionInRedis,
    terminateInstance,
} from './instance'
import { MeetingHandle } from './meeting'

import { clientRedis } from './server'

import axios from 'axios'
import { exit } from 'process'
// import { generateBranding } from './branding'
import { Api } from './api/methods'
import { Consumer } from './rabbitmq'
import {
    JoinError,
    JoinErrorCode,
    MeetingParams,
    MeetingProvider,
} from './types'

import { spawn } from 'child_process'
import { Events } from './events'
import { RecordingEndReason } from './state-machine/types'
import {
    logger,
    redirectLogsToBot,
    setupConsoleLogger,
    setupExitHandler,
    uploadLogsToS3,
} from './utils/Logger'

// Configuration pour activer/désactiver l'enregistrement
export const RECORDING = process.env.RECORDING === 'true' // Par défaut false, true si RECORDING=true

const ZOOM_SDK_DEBUG_EXECUTABLE_PATHNAME = './target/debug/client-zoom'
const ZOOM_SDK_RELEASE_EXECUTABLE_PATHNAME = './target/release/client-zoom'
const ZOOM_SDK_LIBRARY_PATH = './dependencies/zoom-sdk-linux-rs/zoom-meeting-sdk-linux'
const ZOOM_SDK_RELATIVE_DIRECTORY = '../zoom'

// Setup initial console logging
setupConsoleLogger()

// Setup exit handler for proper log file cleanup
setupExitHandler()

// Add a constant for the maximum meeting duration (5 hours in milliseconds)
const MAX_INSTANCE_DURATION_AFTER_RABBIT_MESSAGE_RECIEVED_MS =
    5 * 60 * 60 * 1000 // 5 hours
let forceTerminationTimeout: NodeJS.Timeout | null = null

// Helper function to detect meeting provider
function detectMeetingProvider(url: string): MeetingProvider {
    if (url.includes('https://teams')) {
        return 'Teams'
    } else if (url.includes('https://meet')) {
        return 'Meet'
    } else {
        return 'Zoom'
    }
}

// Helper function to read data from stdin (for serverless mode)
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
                resolve(params)
            } catch (error) {
                console.error('Failed to parse JSON from stdin:', error)
                process.exit(1)
            }
        })
    })
}

// Check if running in serverless mode
const isServerless = process.env.SERVERLESS === 'true'

// ENTRY POINT
// syntax convention
// minus => Library
// CONST => Const
// camelCase => Fn
// PascalCase => Classes

;(async () => {
    // set default axios config
    axios.defaults.baseURL = API_SERVER_BASEURL
    axios.defaults.withCredentials = true

    let environ: string = process.env.ENVIRON

    // Save the original directory
    const originalDirectory = process.cwd()

    let consumeResult: {
        params: MeetingParams
        error: Error
    }

    if (isServerless) {
        // SERVERLESS MODE: Read parameters from stdin
        console.log(
            'Running in serverless mode - reading parameters from stdin',
        )
        try {
            const meetingParams = await readFromStdin()
            console.log(
                'Received meeting parameters:',
                JSON.stringify({
                    meeting_url: meetingParams.meeting_url,
                    bot_uuid: meetingParams.bot_uuid,
                    bot_name: meetingParams.bot_name,
                }),
            )
            // Redirect logs to bot-specific file
            console.log(
                'About to redirect logs to bot:',
                meetingParams.bot_uuid,
            )
            await redirectLogsToBot(meetingParams.bot_uuid)
            console.log('Logs redirected successfully')
            // Setup force termination timer for safety
            setupForceTermination({
                secret: meetingParams.secret,
                bot_uuid: meetingParams.bot_uuid,
            })

            // Create a fake consumeResult structure to match the original logic
            consumeResult = {
                params: meetingParams,
                error: null,
            }
        } catch (e) {
            console.error('Error reading from stdin:', e)
            process.exit(1)
        }
    } else {
        // NORMAL MODE: Use Redis and RabbitMQ (original logic)
        console.log('Before REDIS.connect()')
        await clientRedis.connect().catch((e) => {
            console.error(`Fail to connect to redis: ${e}`)
            throw e
        })

        console.log('Before RABBIT.connect()')
        const consumer = await Consumer.init().catch((e) => {
            console.error(`Fail to init consumer: ${e}`)
            throw e
        })

        console.log('start consuming rabbitmq messages')
        try {
            consumeResult = await consumer.consume(Consumer.handleStartRecord)
        } catch (e) {
            if (LOCK_INSTANCE_AT_STARTUP) {
                await consumer.deleteQueue().catch((e) => {
                    console.error('fail to delete queue', e)
                })
                throw e
            }
        }

        // Setup force termination timer for safety (only after getting params)
        if (consumeResult?.params) {
            setupForceTermination({
                secret: consumeResult.params.secret,
                bot_uuid: consumeResult.params.bot_uuid,
            })
        }
    }

    if (consumeResult.error) {
        // Assuming Recording does not start at this point
        // So there are not video to upload. Just send webhook failure
        console.error(
            'error in start meeting:',
            consumeResult.error instanceof JoinError
                ? consumeResult.error.message
                : consumeResult.error,
        )

        await handleErrorInStartRecording(
            consumeResult.error,
            consumeResult.params,
        ).catch((e) => {
            console.error(
                'error in handleErrorInStartRecording:',
                e instanceof JoinError ? e.message : e,
            )
        })
    } else if (consumeResult.params.meetingProvider !== 'Zoom') {
        // Assuming that recording is active at this point
        try {
            // In serverless mode, we need to initialize MeetingHandle ourselves
            if (isServerless) {
                // Create the API instance
                new Api(consumeResult.params)

                // Import necessary modules
                const { server } = await import('./server')
                const { Events } = await import('./events')

                // Start the server
                await server().catch((e) => {
                    console.error(`Fail to start server: ${e}`)
                    throw e
                })
                console.log('Server started successfully')

                // Initialize MeetingHandle with parameters
                MeetingHandle.init(consumeResult.params)

                // Initialize events
                Events.init(consumeResult.params)
                Events.joiningCall()
            }

            // Start the meeting with state machine
            await MeetingHandle.instance.startRecordMeeting()

            // Check if recording was successful and ended normally
            if (MeetingHandle.instance.wasRecordingSuccessful()) {
                console.log(
                    `${Date.now()} Finalize project && Sending WebHook complete`,
                )

                // Log the end reason for debugging
                const endReason = MeetingHandle.instance.getEndReason()
                console.log(
                    `Recording ended normally with reason: ${endReason}`,
                )

                // Start retry process and set a timeout
                let webhookSentForApiFailure = false
                const apiStartTime = Date.now()
                const maxApiWaitTime = 20 * 60 * 1000 // 20 minutes
                const retryDelay = 10000 // 10 seconds

                // Keep retrying until we succeed or time runs out
                while (Date.now() - apiStartTime < maxApiWaitTime) {
                    try {
                        // Try to call the API
                        if (isServerless) {
                            console.log(
                                'Skipping endMeetingTrampoline - serverless mode',
                            )
                        } else {
                            await Api.instance.endMeetingTrampoline()
                        }
                        console.log(
                            'API call to endMeetingTrampoline succeeded',
                        )
                        break // Success! Exit the loop
                    } catch (apiError) {
                        const elapsedSeconds =
                            (Date.now() - apiStartTime) / 1000
                        const remainingSeconds =
                            Math.max(
                                0,
                                maxApiWaitTime - (Date.now() - apiStartTime),
                            ) / 1000

                        console.log(
                            `API call failed after ${elapsedSeconds.toFixed(1)}s, ` +
                                `${remainingSeconds.toFixed(1)}s remaining before timeout. ` +
                                `Retrying in ${retryDelay / 1000}s...`,
                            apiError,
                        )

                        // Only send the webhook once if we're going to keep trying
                        if (
                            !webhookSentForApiFailure &&
                            remainingSeconds < maxApiWaitTime / 1000 - 60
                        ) {
                            // If we've been retrying for more than a minute, send webhook but keep trying
                            try {
                                await sendWebhookOnce({
                                    meetingUrl:
                                        consumeResult.params.meeting_url,
                                    botUuid: consumeResult.params.bot_uuid,
                                    success: true,
                                    errorMessage:
                                        'Recording completed successfully but having difficulty notifying API',
                                })
                                webhookSentForApiFailure = true
                                console.log(
                                    'Sent webhook for successful recording while API retries continue',
                                )
                            } catch (webhookError) {
                                console.error(
                                    'Failed to send interim webhook:',
                                    webhookError,
                                )
                            }
                        }

                        // Wait before retrying
                        await new Promise((resolve) =>
                            setTimeout(resolve, retryDelay),
                        )
                    }
                }

                // If we exited the loop without breaking, it means we timed out
                if (Date.now() - apiStartTime >= maxApiWaitTime) {
                    console.error('API call failed after 20 minutes of retries')

                    // Send final webhook if we haven't already
                    if (!webhookSentForApiFailure) {
                        await sendWebhookOnce({
                            meetingUrl: consumeResult.params.meeting_url,
                            botUuid: consumeResult.params.bot_uuid,
                            success: true,
                            errorMessage:
                                'Recording completed successfully but API notification failed after 20 minutes',
                        })
                    }
                }
            } else {
                // Recording did not reach Recording state or failed
                console.error('Recording did not complete successfully')

                // Get the specific reason for the failure
                const endReason = MeetingHandle.instance.getEndReason()
                let errorMessage

                // Check if we have a JoinError type error in the context
                const joinError =
                    MeetingHandle.instance?.stateMachine?.context?.error
                if (joinError && joinError instanceof JoinError) {
                    // Use the JoinError message directly
                    errorMessage = joinError.message
                    console.log(
                        `Found JoinError in context with code: ${errorMessage}`,
                    )
                } else if (endReason) {
                    // Use endReason as fallback
                    errorMessage = String(endReason)
                }

                console.log(
                    `Recording failed with reason: ${errorMessage || 'Unknown'}`,
                )

                // Don't call endMeetingTrampoline here
                await sendWebhookOnce({
                    meetingUrl: consumeResult.params.meeting_url,
                    botUuid: consumeResult.params.bot_uuid,
                    success: false,
                    errorMessage:
                        errorMessage ||
                        'Recording did not complete successfully',
                })
            }
        } catch (error) {
            // Explicit error propagated from state machine (error during recording)
            console.error('Meeting failed:', error)

            await sendWebhookOnce({
                meetingUrl: consumeResult.params.meeting_url,
                botUuid: consumeResult.params.bot_uuid,
                success: false,
                errorMessage:
                    error instanceof JoinError
                        ? error.message
                        : 'Recording failed to complete',
            })
        }
    } else {
        // Configuring and launching LINUX ZOOM SDK
        console.log('Current Directory :', process.cwd())
        process.chdir(ZOOM_SDK_RELATIVE_DIRECTORY)
        console.log('Switching to :', process.cwd())

        const libraryPath = ZOOM_SDK_LIBRARY_PATH
        process.env.LD_LIBRARY_PATH = `${libraryPath}:${process.env.LD_LIBRARY_PATH || ''}`
        console.log(
            'LD_LIBRARY_PATH :',
            process.env.LD_LIBRARY_PATH || 'Undefined',
        )

        async function runClient(params: MeetingParams) {
            try {
                console.log('Executing client...')

                const clientProcess = spawn(
                    environ === 'local'
                        ? ZOOM_SDK_DEBUG_EXECUTABLE_PATHNAME
                        : ZOOM_SDK_RELEASE_EXECUTABLE_PATHNAME,
                    process.argv[2]?.includes('--zoom-no-recursive-env')
                        ? ['--no-recursive-env', '--pulse']
                        : ['--pulse'],
                    {
                        env: process.env,
                        stdio: ['pipe', 'inherit', 'inherit'],
                    },
                )

                clientProcess.stdin?.write(JSON.stringify(params))
                clientProcess.stdin?.end()

                const exitCode = await new Promise<number>(
                    (resolve, reject) => {
                        clientProcess.on('close', resolve)
                        clientProcess.on('error', reject)
                    },
                )

                console.log(`Process terminated with code: ${exitCode}`)
            } catch (error) {
                console.error('Error while loading Zoom: ', error)
            }
        }
        try {
            await runClient(consumeResult.params)
        } catch (e) {
            // Add handling for Zoom client errors
            console.error(`Promise rejected : ${e}`)
            await sendWebhookOnce({
                meetingUrl: consumeResult.params.meeting_url,
                botUuid: consumeResult.params.bot_uuid,
                success: false,
                errorMessage: 'Zoom client error',
            })
        }
    }

    // Only do Redis cleanup in normal mode
    if (!isServerless) {
        await delSessionInRedis(consumeResult.params.session_id).catch((e) => {
            console.error('fail delete session in redis: ', e)
        })

        if (LOCK_INSTANCE_AT_STARTUP) {
            await Consumer.init()
                .then((consumer) => {
                    return consumer.deleteQueue()
                })
                .catch((e) => {
                    console.error('fail to delete queue', e)
                })
            await terminateInstance().catch((e) => {
                console.error('fail to terminate instance', e)
            })
        }

        // Upload logs to S3 before exiting
        try {
            // Return to the original directory before uploading logs
            if (originalDirectory) {
                console.log(
                    `Switching back to original directory: ${originalDirectory}`,
                )
                process.chdir(originalDirectory)
            }

            await uploadLogsToS3({
                type: 'normal',
                bot_uuid: consumeResult.params.bot_uuid,
                secret: consumeResult.params.secret,
            })
        } catch (error) {
            console.error('Failed to upload logs to S3:', error)
        }
    }
    console.log('exiting instance')
    exit(0)
})()

let webhookSent = false

async function sendWebhookOnce(params: {
    meetingUrl: string
    botUuid: string
    success: boolean
    errorMessage?: string
}) {
    if (webhookSent) {
        console.log('Webhook already sent, skipping...')
        return
    }

    try {
        // Multiple attempts for webhook sending
        const maxRetries = 3
        let attempt = 0

        while (attempt < maxRetries) {
            try {
                const callEndedPromise = Events.callEnded()
                await Promise.race([
                    callEndedPromise,
                    new Promise((_, reject) =>
                        setTimeout(
                            () => reject(new Error('Call ended event timeout')),
                            30000,
                        ),
                    ),
                ])

                if (!params.success) {
                    await meetingBotStartRecordFailed(
                        params.meetingUrl,
                        params.botUuid,
                        params.errorMessage || 'Unknown error',
                    )
                }

                console.log('All webhooks sent successfully')
                break
            } catch (e) {
                attempt++
                if (attempt === maxRetries) {
                    console.error('Final webhook attempt failed:', e)
                } else {
                    console.warn(
                        `Webhook attempt ${attempt} failed, retrying...`,
                    )
                    await new Promise((resolve) =>
                        setTimeout(resolve, 2000 * attempt),
                    )
                }
            }
        }
    } finally {
        webhookSent = true // Mark as sent even in case of failure
    }
}

async function handleErrorInStartRecording(error: Error, data: MeetingParams) {
    console.log('Handling error in start recording:', {
        errorType: error.constructor.name,
        isJoinError: error instanceof JoinError,
        message: error.message,
        endReason: MeetingHandle.instance?.stateMachine?.context?.endReason,
    })

    // Utiliser le endReason du context si disponible
    const endReason = MeetingHandle.instance?.stateMachine?.context?.endReason

    let errorMessage
    if (endReason === RecordingEndReason.ApiRequest) {
        errorMessage = JoinErrorCode.ApiRequest
    } else if (error instanceof JoinError) {
        errorMessage = error.message
    } else {
        errorMessage = 'InternalError : ' + error.message
    }

    await meetingBotStartRecordFailed(
        data.meeting_url,
        data.bot_uuid,
        errorMessage,
    )
}

export function meetingBotStartRecordFailed(
    meetingLink: string,
    bot_uuid: string,
    message: string,
): Promise<void> {
    if (isServerless) {
        console.log('Notifying failed recording attempt:', {
            meetingLink,
            bot_uuid,
            message,
        })
        return Promise.resolve()
    }
    console.log('Notifying failed recording attempt:', {
        meetingLink,
        bot_uuid,
        message,
    })

    return axios({
        method: 'POST',
        url: `/bots/start_record_failed`,
        timeout: 10000,
        data: { meeting_url: meetingLink, message },
        params: { bot_uuid },
    })
        .then(() => {
            console.log('Successfully notified backend of recording failure')
        })
        .catch((error) => {
            console.error('Failed to notify recording failure:', error.message)
            // Rethrow the error to ensure the promise is rejected
            throw error
        })
}

// Add this function to set up the force termination timer
export function setupForceTermination(params: {
    secret: string
    bot_uuid: string
}) {
    // Clear any existing timeout
    if (forceTerminationTimeout) {
        clearTimeout(forceTerminationTimeout)
    }

    // Set up new timeout
    forceTerminationTimeout = setTimeout(async () => {
        logger.warn(
            `Force terminating instance after ${MAX_INSTANCE_DURATION_AFTER_RABBIT_MESSAGE_RECIEVED_MS / 1000 / 60 / 60} hours for safety`,
        )

        try {
            // Log the forced termination
            logger.error(
                'CRITICAL: Forcing immediate process termination after timeout',
            )

            if (process.env.SERVERLESS !== 'true') {
                // Try to upload logs before termination
                try {
                    await uploadLogsToS3({
                        type: 'force-termination',
                        secret: params.secret,
                        bot_uuid: params.bot_uuid,
                    })
                } catch (uploadError) {
                    logger.error(
                        'Failed to upload logs before termination:',
                        uploadError,
                    )
                }
                process.kill(process.pid, 'SIGKILL')
            }
        } catch (e) {
            logger.error('Failed to terminate gracefully, using immediate exit')
            process.exit(9)
        }
    }, MAX_INSTANCE_DURATION_AFTER_RABBIT_MESSAGE_RECIEVED_MS)
}
