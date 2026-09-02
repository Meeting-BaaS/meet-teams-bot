/**
 * Rotate an ordered country pool so one join attempt starts in the next region.
 * The input order is already bot-stable; this adds attempt-level diversity
 * without changing how separate bots are spread across the pool.
 */
export function rotateCountriesForAttempt(
  countries: readonly string[],
  attemptIndex: number
): string[] {
  if (countries.length <= 1) return [...countries]

  const safeAttempt = Number.isFinite(attemptIndex) ? Math.max(0, Math.trunc(attemptIndex)) : 0
  const offset = safeAttempt % countries.length
  return [...countries.slice(offset), ...countries.slice(0, offset)]
}

/**
 * Flatten SQS pod retries and in-process browser relaunches into one monotonic
 * join-attempt index. This prevents every fresh pod from restarting at the
 * same country.
 */
export function getZoomJoinAttemptIndex(
  outerRetryCount: number,
  inProcessAttempt: number,
  attemptsPerPod: number
): number {
  const safeOuterRetry = Math.max(0, Math.trunc(outerRetryCount))
  const safeInProcessAttempt = Math.max(0, Math.trunc(inProcessAttempt))
  const safeAttemptsPerPod = Math.max(1, Math.trunc(attemptsPerPod))
  return safeOuterRetry * safeAttemptsPerPod + safeInProcessAttempt
}
