import type { Page } from "@playwright/test"
import { envVars } from "../config/env-vars"

// Controlled via enablePrintPageLogs()/disablePrintPageLogs()
// Enabled when LOG_LEVEL is "debug" OR when debugging specific scenarios (e.g., no speakers detected)
let PRINT_PAGE_LOGS = envVars.LOG_LEVEL === "debug"

const formatValue = (value: unknown): string => {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2)
    } catch (_e) {
      return String(value)
    }
  }
  return String(value)
}

/**
 * Enable printing page logs
 */
export const enablePrintPageLogs = () => {
  PRINT_PAGE_LOGS = true
}

/**
 * Disable printing page logs.
 * This hasn't been used yet but could be implemented if we need to turn off page logs for some reason
 */
export const disablePrintPageLogs = () => {
  PRINT_PAGE_LOGS = false
}

// Known-harmless browser/Zoom console spam (especially on Firefox/stealthfox):
// Zoom's own icozoom webfont has imperfect glyph bboxes Firefox loudly "adjusts",
// plus Zoom's CSP/deprecation/WebGL chatter. None are actionable and they bury the
// real logs hundreds of lines deep, so drop them before forwarding.
const NOISE_PATTERNS = [
  "downloadable font:",
  "Glyph bbox was incorrect",
  "Content-Security-Policy: Ignoring",
  "unreachable code after return statement",
  "Synchronous XMLHttpRequest",
  "MouseEvent.mozInputSource is deprecated",
  "WebGL warning:",
  "WEBGL_debug_renderer_info is deprecated",
  "ProseMirror expects the CSS",
  "Layout was forced before the page was fully loaded",
  "This page is in Quirks Mode",
  "Using matchMedia for dark mode detection",
  // Zoom media-stack internal chatter — high-volume and not actionable.
  "CustomChunkLoader",
  "cancelConsume interval",
  "Video Version:",
  "Sharing Version:",
  "Audio Version:",
  "Report-Only policy",
  "frame-ancestors"
]

export function listenPage(page: Page) {
  // Note on PII: everything relayed here goes through the console.*
  // overrides installed by setupConsoleLogger(), whose winston format
  // passes every formatted line through PiiRedactor.redact() before any
  // transport (stdout/logs.log and bot.log). Page text (names, emails,
  // URLs) is therefore redacted at the choke point, not here.
  page.on("console", async (message) => {
    try {
      const text = message.text()
      if (NOISE_PATTERNS.some((p) => text.includes(p))) return
      const location = message.location()

      const type = message.type()

      // Always capture NetworkInterceptor errors and warnings (Since we are just adding NetworkInterceptor, we need to capture the logs to ensure its working properly)
      // TODO: Remove this once we are sure NetworkInterceptor is working properly
      const isNetworkInterceptorLog = text.includes("[NetworkInterceptor]")
      const isNetworkError = isNetworkInterceptorLog && (type === "error" || type === "warning")

      // Only show DEBUG logs when LOG_LEVEL=debug
      const isDebugLog = text.includes("DEBUG")
      const isNetworkInterceptorInfo = text.includes("[MeetAudio]") || text.includes("[TeamsAudio]")

      // Print if:
      // 1. PRINT_PAGE_LOGS is enabled, OR
      // 2. It's a NetworkInterceptor error/warning (always), OR
      // 3. LOG_LEVEL=debug and it's a relevant debug log
      const shouldPrint =
        PRINT_PAGE_LOGS ||
        isNetworkError ||
        (envVars.LOG_LEVEL === "debug" && (isDebugLog || isNetworkInterceptorInfo))
      if (!shouldPrint) {
        return
      }

      const args = await Promise.all(
        message.args().map(async (arg) => {
          try {
            const value = await arg.jsonValue()
            return formatValue(value)
          } catch {
            return "Unable to serialize value"
          }
        })
      )

      const messageType = type.substring(0, 3).toUpperCase()
      const tags = `${location.url}:${location.lineNumber}`
      const formattedText = args.length === 1 ? args[0] : args.join(" ")

      switch (messageType) {
        case "LOG":
          console.log(`${tags}\n${formattedText}`)
          break
        case "WAR":
          console.log("\x1b[38;5;214m%s\x1b[0m", `${tags}\n${formattedText}`)
          break
        case "ERR":
          console.log("\x1b[31m%s\x1b[0m", `${tags}\n${formattedText}`)
          break
        case "INF":
          console.log("\x1b[32m%s\x1b[0m", `${tags}\n${formattedText}`)
          break
        default:
          console.log(`DEFAULT CASE ${messageType} ! ${tags}\n${formattedText}`)
      }
    } catch (e) {
      console.log(`Failed to log forward logs: ${e}`)
    }
  })
}
