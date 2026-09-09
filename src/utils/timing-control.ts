import { GLOBAL } from "../singleton"
import { MeetingEndReason } from "../state-machine/types"

// A bot may legitimately start late: a pod cold start, a queue backlog, an SQS
// requeue after a failed join. It may never start SO late that the meeting it
// was sent to cannot still be running. max_recording_duration is exactly that
// bound — the longest window this bot was ever going to record — so past it the
// meeting is over by construction and joining can only sit in an empty room
// until the waiting-room timeout, on a billed pod. Floored so a very short
// recording cap does not reject an ordinary cold start.
const MIN_LATENESS_ALLOWANCE_SEC = 15 * 60

function latenessAllowanceSec(): number {
  const cap = GLOBAL.get().max_recording_duration
  return Math.max(typeof cap === "number" && cap > 0 ? cap : 0, MIN_LATENESS_ALLOWANCE_SEC)
}

/**
 * Handles timing control for precise meeting join times.
 * If start_time is provided, waits until that exact time before joining.
 * This allows for pre-warmed bots to join at the precise scheduled time.
 * Returns the actual start time (either scheduled or current) for reporting to backend.
 *
 * @param abortCheck - Optional async callback polled every ~3s during the wait.
 *                     If it returns true the wait is terminated early (e.g. page navigated away).
 */
export async function handleTimingControl(
  startTime?: number,
  abortCheck?: () => Promise<boolean>
): Promise<number> {
  if (!startTime) {
    // No scheduled start time - capture actual start time
    const actualStartTime = Math.floor(Date.now() / 1000)
    console.log(
      `No timing control needed - joining immediately at actual start time: ${actualStartTime}`
    )
    return actualStartTime
  }

  const currentTime = Math.floor(Date.now() / 1000) // Current time in seconds

  if (startTime > currentTime) {
    const waitDuration = startTime - currentTime
    console.log(
      `Bot is early by ${waitDuration} seconds. Waiting until scheduled start time: ${startTime}`
    )

    // Poll in short intervals so we can detect page state changes (e.g. denial redirects)
    const POLL_INTERVAL_MS = 3000
    const endTime = Date.now() + waitDuration * 1000
    while (Date.now() < endTime) {
      if (abortCheck) {
        try {
          if (await abortCheck()) {
            console.log("Timing control: abort check triggered, stopping wait early")
            return Math.floor(Date.now() / 1000)
          }
        } catch (err) {
          console.warn(`Timing control: abortCheck threw, treating as no-abort: ${err}`)
        }
      }
      const remaining = endTime - Date.now()
      if (remaining <= 0) break
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)))
    }

    console.log("Timing control: Bot is now ready to join at scheduled time")
    return startTime
  }
  const lateBy = currentTime - startTime
  const allowance = latenessAllowanceSec()
  if (lateBy > allowance) {
    // Do not join. Reaching here means something requeued a bot long after its
    // meeting could still have been running (see the watchdog note in main.ts).
    console.error(
      `Bot is late by ${lateBy}s, past its ${allowance}s allowance — the meeting cannot still be running. Not joining.`
    )
    GLOBAL.setError(MeetingEndReason.TimeoutWaitingToStart)
    GLOBAL.setShouldRetry(false)
    throw new Error(
      `Refusing to join ${lateBy}s after the scheduled start (allowance ${allowance}s)`
    )
  }
  console.log(
    `Bot is late by ${lateBy} seconds. Joining immediately (scheduled: ${startTime}, current: ${currentTime})`
  )
  return startTime
}
