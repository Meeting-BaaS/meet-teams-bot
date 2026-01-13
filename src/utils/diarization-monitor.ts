import {
  type DiarizationHealthStatus,
  type DiarizationHealthStatusLevel,
  DiarizationTracker
} from "../diarization-tracker"
import { sleep } from "./sleep"

/**
 * Monitor diarization health and log status.
 */
/**
 * Check diarization health with a delay to account for race conditions
 * between sound detection and segment updates.
 * @param meetingStartTime - Meeting start timestamp in milliseconds
 * @param currentTime - Current timestamp in milliseconds
 * @returns Health status object
 */
export async function checkDiarizationHealth(
  meetingStartTime: number,
  currentTime: number
): Promise<DiarizationHealthStatus> {
  // Add 100ms delay to account for race conditions between sound detection and segment updates
  await sleep(100)

  const tracker = DiarizationTracker.getInstance()
  return tracker.hasActiveOrRecentSegment(meetingStartTime, currentTime)
}

/**
 * Log health status with appropriate message.
 * @param status - Health status from diarization tracker
 */
export function logHealthStatus(status: DiarizationHealthStatus): void {
  if (status.status === "optimal") {
    console.log(`[DiarizationHealth] ✅ Optimal: ${status.segmentCount60s} segments in last 60s`)
  } else if (status.status === "acceptable") {
    console.log(
      `[DiarizationHealth] ⚠️ Acceptable: No segments in last 60s, but ${status.segmentCount5min} segment(s) in last 5min`
    )
  } else {
    console.log("[DiarizationHealth] ❌ Stale: No segments in last 5min despite sound activity")
  }
}

export type { DiarizationHealthStatus, DiarizationHealthStatusLevel }
