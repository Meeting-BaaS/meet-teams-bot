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
import { getMaxRetryCount } from "./config/retry-config"
import {
  buildRetryMessage,
  requeueToSQS,
  shouldAttemptRetry
} from "./utils/retry-handler"

// Bot-like display-name tokens; log-only hint when a Zoom join is rejected.
const BOT_LIKE_NAME_RE =
  /note ?taker|recorder|recording|transcri|\bbots?\b|\bai\b|assistant|\bnotes?\b/i

// On SIGTERM (k8s eviction), requeue the meeting to a fresh pod so it isn't lost.
// The shared GLOBAL.claimRecovery() token is taken ONLY right before a requeue, so
// at most one requeue happens; a non-requeuing path must never take it (that would
// starve the primary retry in handleFailedRecording).
process.on("SIGTERM", async () => {
  if (GLOBAL.isRecoveryClaimed()) {
    // A requeuing path already owns recovery and may be mid-write — stand down
    // (do NOT exit) so we don't kill it.
    console.log("[SIGTERM] Recovery already owned by a requeuing handler — standing down")
    return
  }
  console.error("[SIGTERM] Pod termination received — requeuing so the meeting isn't lost")
  try {
    if (!GLOBAL.isServerless()) await uploadLogsToS3()
  } catch (e) {
    console.error("[SIGTERM] log upload failed:", formatError(e))
  }
  try {
    if (GLOBAL.hasRecordingFinalized()) {
      // Merged recording exists — preserve for S3/EFS salvage, don't requeue (no claim).
      console.log("[SIGTERM] Recording finalized — preserving artifacts (not requeuing)")
    } else if (!GLOBAL.isServerless()) {
      GLOBAL.setShouldRetry(true)
      if (shouldAttemptRetry(GLOBAL.getRetryCount())) {
        // Claim right before requeue; a lost claim means another path already requeued.
        if (GLOBAL.claimRecovery()) {
          try {
            await requeueToSQS(buildRetryMessage())
            console.log("[SIGTERM] Requeued to SQS to re-record")
          } catch (e) {
            // Send failed — release so another path can requeue (see releaseRecovery).
            GLOBAL.releaseRecovery()
            throw e
          }
          // Requeue succeeded — surface `retrying` for SIGTERM-path requeues too,
          // matching the graceful path. Best-effort; isolated so a failed emit
          // can't release the successful recovery claim.
          try {
            await Events.retrying(GLOBAL.getRetryCount() + 1, getMaxRetryCount())
          } catch (evErr) {
            console.error("[SIGTERM] retrying status emit failed (non-fatal):", formatError(evErr))
          }
        } else {
          console.log("[SIGTERM] Recovery claimed concurrently — skipping duplicate requeue")
        }
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

  // The Zoom anti-bot wall is probabilistic (keys on exit-IP reputation), so mark
  // it retryable — each requeue lands a fresh exit IP, cycling past burned ones.
  if (endReason === MeetingEndReason.ZoomAnonymousJoinNotAllowed) {
    console.log("[Retry] Zoom anti-bot wall — marking retryable to cycle exit IP")
    GLOBAL.setShouldRetry(true)
  }

  const shouldRetry = shouldAttemptRetry(currentRetryCount)

  if (shouldRetry) {
    console.log(
      `🔄 Error marked as retryable - attempting retry ${currentRetryCount + 1}/${getMaxRetryCount()}`
    )

    try {
      const retryMessage = buildRetryMessage()

      // Claim right before requeuing (primary retry path). A lost claim means a
      // SIGTERM/crash handler already requeued this meeting — skip the duplicate.
      if (!GLOBAL.claimRecovery()) {
        console.log("🔁 Recovery already requeued by another handler — skipping duplicate requeue")
        return
      }
      try {
        await requeueToSQS(retryMessage)
      } catch (requeueError) {
        // Send failed — release the claim so a SIGTERM/crash handler can take over
        // the requeue instead of standing down on a stuck claim (and losing the
        // meeting). Rethrow into the outer catch → normal failure flow.
        GLOBAL.releaseRecovery()
        throw requeueError
      }

      // A retry is now pending. Emit the non-terminal `retrying` status (NOT
      // recording_failed) so the dashboard shows "Retrying… (attempt N/max)"
      // instead of flashing a failure between attempts. The real reason is only
      // surfaced on the terminal path below once all retries are exhausted.
      const attempt = currentRetryCount + 1
      const cap = getMaxRetryCount()
      console.log(
        `📤 Emitting retrying status (attempt ${attempt}/${cap}) — reason: ${originalErrorMessage || endReason || "Recording failed"}`
      )
      await Events.retrying(attempt, cap)

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
    // Mark the run fully handled so a late SIGTERM / crash arriving during this
    // final log upload stands down instead of spuriously re-recording an
    // already-decided (e.g. terminally-failed) meeting. This runs AFTER
    // handleFailedRecording(), so — unlike the old up-front claims in the SIGTERM /
    // crash handlers — it can NEVER starve the primary retry's own claim (that
    // claim, if the run retried, was already taken). It performs no requeue itself.
    GLOBAL.claimRecovery()
    if (!GLOBAL.isServerless()) {
      try {
        await uploadLogsToS3()
      } catch (error) {
        console.error("Failed to upload logs to S3:", formatError(error))
      }

      try {
        const collector = GLOBAL.getMetricsCollector()
        if (collector.isRunning() && Api.instance) {
          collector.stop()
          const payload = collector.getPayload()
          await Promise.race([
            Api.instance.reportMetrics(payload),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("metrics shutdown timeout")), 3000)
            )
          ]).catch(() => {})
        }
      } catch {
        // metrics report is best-effort, never block exit
      }
    }
    console.log("exiting instance")
    exit(0)
  }
})()
