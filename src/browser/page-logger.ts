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

export function listenPage(page: Page) {
  page.on("console", async (message) => {
    try {
      const text = message.text()
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
