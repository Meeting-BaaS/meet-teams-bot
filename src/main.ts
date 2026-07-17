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
  getMaxRetryCount,
  requeueToSQS,
  shouldAttemptRetry
} from "./utils/retry-handler"

// Display names Zoom hosts commonly auto-reject as "obviously a bot". Surfaced as
// a LOG hint (never the user-facing error) when a join is rejected.
const BOT_LIKE_NAME_RE =
  /note ?taker|recorder|recording|transcri|\bbots?\b|\bai\b|assistant|\bnotes?\b|meeting ?baas|fireflies|otter|read ?ai/i

// Set once the run has finished (success or a handled failure) so a SIGTERM
// during normal shutdown never double-requeues.
let settled = false

// k8s evicts / scales down bot pods with SIGTERM. If it arrives BEFORE the run
// has settled, the meeting would otherwise be lost — so requeue it to a fresh pod
// (bounded by the retry cap), upload logs, and exit cleanly instead of being
// force-killed. Best-effort and guarded (GLOBAL may be unset on a very early kill).
process.on("SIGTERM", async () => {
  if (settled) {
    exit(0)
    return
  }
  settled = true
  console.error("[SIGTERM] Pod termination received — requeuing so the meeting isn't lost")
  try {
    if (!GLOBAL.isServerless()) await uploadLogsToS3()
  } catch (e) {
    console.error("[SIGTERM] log upload failed:", formatError(e))
  }
  try {
    if (GLOBAL.hasRecordingFinalized()) {
      // Eviction during upload: the merged recording exists — preserve it for the
      // S3/EFS salvage path rather than requeuing (which would re-record).
      console.log(
        "[SIGTERM] Recording finalized/uploading — preserving artifacts for salvage (not requeuing)"
      )
    } else if (!GLOBAL.isServerless()) {
      // Join or mid-recording: the only copy is ephemeral /tmp, lost with the pod —
      // requeue to re-record on a fresh pod.
      GLOBAL.setShouldRetry(true)
      if (shouldAttemptRetry(GLOBAL.getRetryCount())) {
        await requeueToSQS(buildRetryMessage())
        console.log("[SIGTERM] Requeued to SQS to re-record")
      }
    }
  } catch (e) {
    console.error("[SIGTERM] requeue failed:", formatError(e))
  }
  exit(0)
})

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
  console.log(`Current retry count: ${currentRetryCount}/${getMaxRetryCount()}`)

  // Zoom hosts frequently auto-reject bot-sounding display names ("Notetaker",
  // "…Bot", "AI …"). When a Zoom join is rejected, hint at it in the logs — a more
  // human name often clears the wall. Log-only; not exposed to the user.
  const botName = GLOBAL.get().bot_name ?? ""
  if (
    (endReason === MeetingEndReason.ZoomAnonymousJoinNotAllowed ||
      endReason === MeetingEndReason.BotNotAccepted) &&
    BOT_LIKE_NAME_RE.test(botName)
  ) {
    console.warn(
      `[Hint] Bot display name "${botName}" contains a bot-indicating keyword; some Zoom hosts auto-reject such names — a more human name may get admitted.`
    )
  }

  // Early return for serverless mode - no SQS retry available
  if (GLOBAL.isServerless()) {
    console.log("🚫 Serverless mode - skipping retry logic")
    return
  }

  // The Zoom browser-join anti-bot / RTMS wall is probabilistic: it keys on the
  // exit IP's reputation, and our proxy pool mixes clean and burned IPs (a live
  // test joined 1 of 4 bots with identical fingerprints — the pass/fail split was
  // purely the exit IP). Mark the wall retryable so the bot requeues onto a FRESH
  // exit IP — the proxy session token embeds the retry count, so each requeue
  // lands a different IP — cycling past burned ones up to MAX_RETRY_COUNT.
  if (endReason === MeetingEndReason.ZoomAnonymousJoinNotAllowed) {
    console.log("[Retry] Zoom RTMS wall — marking retryable to cycle exit IP")
    GLOBAL.setShouldRetry(true)
  }

  // Check if we should retry instead of failing permanently
  const shouldRetry = shouldAttemptRetry(currentRetryCount)

  if (shouldRetry) {
    console.log(
      `🔄 Error marked as retryable - attempting retry ${currentRetryCount + 1}/${getMaxRetryCount()}`
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
        `🚫 Maximum retry attempts reached (${currentRetryCount}/${getMaxRetryCount()}) - reporting failure`
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
    // Mark settled so a SIGTERM during shutdown doesn't requeue an already-handled run.
    settled = true
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
