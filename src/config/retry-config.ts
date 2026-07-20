import { GLOBAL } from "../singleton"
import { envVars } from "./env-vars"

/**
 * Single source of truth for every bot retry count.
 *
 * A failed join burns two independent budgets, in order:
 *   1. IN_PROCESS_RETRY_MAX  — in-pod relaunches: fast (~5-10s), fresh proxy
 *      exit IP, SAME warm pod. Zoom web only (0 elsewhere). See waiting-room-state.
 *   2. getMaxRetryCount()    — SQS pod-requeues: slow (~20-40s cold start), fresh
 *      pod. Zoom=ZOOM_WEB_MAX_RETRY_COUNT, else MAX_RETRY_COUNT.
 * Total attempts ≈ (IN_PROCESS_RETRY_MAX per pod) × (getMaxRetryCount() + 1 pods).
 *
 * NOT the same knob: apps/sqs-consumer's bot-launcher.ts has its own
 * MAX_RETRY_COUNT capping early-crash requeues on the consumer side — a
 * deliberately separate cap in a different app. Keep the two independent.
 */

// SQS pod-requeue cap (Meet/Teams default).
export const MAX_RETRY_COUNT = 2

// SQS pod-requeue cap for Zoom web — higher to cycle exit IPs past the
// probabilistic anti-bot / RTMS wall, which keys on the exit IP's reputation.
export const ZOOM_WEB_MAX_RETRY_COUNT = 5

// In-pod fast relaunches on a fresh exit IP before the first SQS requeue.
// Envalid-validated declaration + default (2) lives in env-vars.ts; re-exported
// here so all retry counts have one import surface.
export const IN_PROCESS_RETRY_MAX = envVars.IN_PROCESS_RETRY_MAX

/**
 * Platform-aware SQS requeue cap: Zoom web gets more attempts. Guarded so a
 * crash before params are set (GLOBAL unset) falls back to the default.
 */
export function getMaxRetryCount(): number {
  try {
    return GLOBAL.get().meeting_platform === "zoom" ? ZOOM_WEB_MAX_RETRY_COUNT : MAX_RETRY_COUNT
  } catch {
    return MAX_RETRY_COUNT
  }
}
