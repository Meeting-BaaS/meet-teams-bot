import { exit } from "node:process"
import { ZodError } from "zod"
import { Api } from "./api/methods"
import { Events } from "./events"
import { server } from "./server"
import { GLOBAL } from "./singleton"
import { MeetingStateMachine } from "./state-machine/machine"
import { getErrorMessageFromCode, MeetingEndReason } from "./state-machine/types"
import type { MeetingParams } from "./types"
import {
  formatError,
  setupConsoleLogger,
  setupExitHandler,
  setupFileLogging,
  uploadLogsToS3,
  uploadScreenshotsToS3
} from "./utils/Logger"
import { BotMessageSchema } from "./utils/meeting-params-schema"
import { PathManager } from "./utils/PathManager"
import {
  buildRetryMessage,
  formatRetryErrorMessage,
  MAX_RETRY_COUNT,
  requeueToSQS,
  shouldAttemptRetry
} from "./utils/retry-handler"

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
        // Setup file logging now that meeting params are set
        setupFileLogging()
        resolve(parsedParams)
      } catch (error) {
        if (error instanceof ZodError) {
          console.error("Failed to validate JSON from stdin:", error.issues)
          process.exit(1)
        }

        console.error("Failed to parse JSON from stdin:", formatError(error))
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

  // Send success webhook - Waits for completion to ensure status history order is correct
  await Events.recordingSucceeded()

  // Upload screenshots before endMeetingTrampoline so they're included in artifacts
  if (!GLOBAL.isServerless()) {
    await uploadScreenshotsToS3()
  }

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

  const endReason = GLOBAL.getEndReason()
  const originalErrorMessage = GLOBAL.getErrorMessage()
  const currentRetryCount = GLOBAL.getRetryCount()

  console.log(`Recording failed with reason: ${endReason || "Unknown"}`)
  console.log(`Error message: ${originalErrorMessage || "None"}`)
  console.log(`Should retry: ${GLOBAL.getShouldRetry()}`)
  console.log(`Current retry count: ${currentRetryCount}/${MAX_RETRY_COUNT}`)

  // Early return for serverless mode - no SQS retry available
  if (GLOBAL.isServerless()) {
    console.log("🚫 Serverless mode - skipping retry logic")
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
        originalErrorMessage || "Recording failed",
        currentRetryCount
      )
      await Events.recordingFailed(retryErrorMessage)

      console.log("✅ Job requeued successfully - exiting without calling backend")
      // Exit cleanly - new pod will handle retry
      return
    } catch (error) {
      console.error("❌ Failed to requeue message:", formatError(error))
      console.log("⚠️ Falling back to normal failure flow")
      // Fall through to normal failure handling
    }
  } else {
    if (GLOBAL.getShouldRetry()) {
      console.log(
        `🚫 Maximum retry attempts reached (${currentRetryCount}/${MAX_RETRY_COUNT}) - reporting failure`
      )
    } else {
      console.log("🚫 Error not retryable - reporting failure immediately")
    }
  }

  // Normal failure handling (original code)
  const errorMessage =
    originalErrorMessage ||
    (endReason ? getErrorMessageFromCode(endReason) : "Recording did not complete successfully")

  await Events.recordingFailed(errorMessage)

  console.log("📤 Sending error to backend")

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
    console.log("Starting recording for bot uuid:", meetingParams.bot_uuid)

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

    // Check if a stop request was issued while the bot was scaling up.
    // This is a lightweight DB check — failures are non-fatal (bot proceeds normally).
    if (!GLOBAL.isServerless() && Api.instance) {
      const shouldStop = await Api.instance.checkStopRequest()
      if (shouldStop) {
        console.log("Stop request detected on startup — aborting before joining meeting")
        GLOBAL.setError(
          MeetingEndReason.ExitingMeetingBeforeRecord,
          "Bot was stopped before recording started"
        )
        await handleFailedRecording()
        return
      }
    }

    // Graceful shutdown. Without this, SIGTERM kills the process outright: the
    // browser dies mid-call having never left, so the platform keeps the bot in
    // the participant list as a GHOST until its own heartbeat timeout. Observed
    // directly — SIGKILLed containers left bots sitting in a live Zoom meeting
    // and the host had to remove them by hand.
    //
    // This matters in production, not just locally: k8s sends SIGTERM on pod
    // eviction, node drain and scale-down, and the bots run on preemptible
    // nodes where evictions are routine — so each one can strand a ghost bot in
    // a customer's meeting. Applies to Meet and Teams exactly as much as Zoom.
    //
    // stopMeeting() sets the end reason and lets the state machine unwind through
    // Cleanup, which calls closeMeeting() and actually leaves the call — the same
    // path POST /stop_record uses. Idempotent: repeated signals are ignored.
    let shuttingDown = false
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        if (shuttingDown) return
        shuttingDown = true
        console.log(`Received ${signal} — leaving the meeting before exiting`)
        MeetingStateMachine.instance
          ?.stopMeeting(MeetingEndReason.ApiRequest)
          .catch((e) => console.error(`Error during ${signal} shutdown:`, formatError(e)))
      })
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
    console.error("Meeting failed:", formatError(error))

    // Delegate to handleFailedRecording which includes retry logic
    await handleFailedRecording()
  } finally {
    if (!GLOBAL.isServerless()) {
      try {
        await uploadLogsToS3()
      } catch (error) {
        console.error("Failed to upload logs to S3:", formatError(error))
      }
    }
    console.log("exiting instance")
    exit(0)
  }
})()
