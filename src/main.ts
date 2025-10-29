import { exit } from "node:process"
import { ZodError } from "zod"
import { Api } from "./api/methods"
import { Events } from "./events"
import { server } from "./server"
import { GLOBAL } from "./singleton"
import { SpeakerManager } from "./speaker-manager"
import { MeetingStateMachine } from "./state-machine/machine"
import { getErrorMessageFromCode } from "./state-machine/types"
import type { MeetingParams } from "./types"
import { setupConsoleLogger, setupExitHandler, uploadLogsToS3 } from "./utils/Logger"
import { BotMessageSchema } from "./utils/meeting-params-schema"
import { PathManager } from "./utils/PathManager"

// Setup console logger first to ensure proper formatting
setupConsoleLogger()

// Setup crash handlers to upload logs in case of unexpected exit
setupExitHandler()

/**
 * Read and parse meeting parameters from stdin
 */
async function readFromStdin(): Promise<MeetingParams> {
  return new Promise((resolve) => {
    let data = ""
    process.stdin.on("data", (chunk) => {
      data += chunk
    })

    process.stdin.on("end", () => {
      try {
        const params = JSON.parse(data)
        const parsedParams = BotMessageSchema.parse(params)

        GLOBAL.set(parsedParams)
        PathManager.getInstance().initializePaths()
        resolve(parsedParams)
      } catch (error) {
        if (error instanceof ZodError) {
          console.error("Failed to validate JSON from stdin:", error.issues)
          process.exit(1)
        }

        console.error("Failed to parse JSON from stdin:", error)
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
    `Recording ended normally with reason: ${MeetingStateMachine.instance.getEndReason()}`
  )

  // Finalize diarization tracking (writes final segment to file)
  try {
    await SpeakerManager.finalize()
    console.log("Diarization tracking finalized")
  } catch (error) {
    console.error("Failed to finalize diarization:", error)
    // Continue despite error
  }

  // Send success webhook - Waits for completion to ensure status history order is correct
  await Events.recordingSucceeded()

  // Handle API endpoint call with built-in retry logic
  if (!GLOBAL.isServerless()) {
    await Api.instance.handleEndMeetingWithRetry()
  }
}

/**
 * Handle failed recording
 */
async function handleFailedRecording(): Promise<void> {
  console.error("Recording did not complete successfully")

  // Log the end reason for debugging
  const endReason = GLOBAL.getEndReason()
  console.log(`Recording failed with reason: ${endReason || "Unknown"}`)

  // Send failure webhook to user before sending to backend
  const errorMessage =
    (GLOBAL.hasError() && GLOBAL.getErrorMessage()) ||
    (endReason ? getErrorMessageFromCode(endReason) : "Recording did not complete successfully")

  // Send failure webhook - Waits for completion to ensure status history order is correct
  await Events.recordingFailed(errorMessage)

  console.log("📤 Sending error to backend")

  // Notify backend of recording failure (function deduces errorCode and message automatically)
  if (!GLOBAL.isServerless() && Api.instance) {
    await Api.instance.notifyRecordingFailure()
  }
  console.log("✅ Error sent to backend successfully")
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
    console.log("Starting recording for bot uuid:", meetingParams.botUuid)

    // Start the server
    await server()
      .then(() => {
        console.log("Server started successfully")
      })
      .catch((e) => {
        console.error(`Failed to start server: ${e}`)
        throw e
      })

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
    console.error("Meeting failed:", error instanceof Error ? error.message : error)

    // Use global error if available, otherwise fallback to error message
    const errorMessage = GLOBAL.hasError()
      ? GLOBAL.getErrorMessage() || "Unknown error"
      : error instanceof Error
        ? error.message
        : "Recording failed to complete"

    // Send failure webhook to user before sending to backend
    await Events.recordingFailed(errorMessage)

    console.log(`📤 Sending error to backend: ${errorMessage}`)

    // Notify backend of recording failure
    if (!GLOBAL.isServerless() && Api.instance) {
      await Api.instance.notifyRecordingFailure()
    }

    console.log("✅ Error sent to backend successfully")
  } finally {
    if (!GLOBAL.isServerless()) {
      try {
        await uploadLogsToS3()
      } catch (error) {
        console.error("Failed to upload logs to S3:", error)
      }
    }
    console.log("exiting instance")
    exit(0)
  }
})()
