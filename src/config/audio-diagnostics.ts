/** Customer-visible per-bot opt-in, persisted by the API in a reserved extra key. */
export function audioDiagnosticsEnabled(platform: string, extra: unknown): boolean {
  if (platform !== "teams" || !extra || typeof extra !== "object" || Array.isArray(extra)) return false
  const debug = (extra as Record<string, unknown>).__meeting_baas_debug
  return Boolean(
    debug && typeof debug === "object" && !Array.isArray(debug) &&
    (debug as Record<string, unknown>).AUDIO_DIAGNOSTICS === true
  )
}
