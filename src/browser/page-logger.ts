import type { Page } from "@playwright/test"
import { envVars } from "../config/env-vars"

// Controlled via enablePrintPageLogs()/disablePrintPageLogs()
// Enabled when LOG_LEVEL is "debug" OR when debugging specific scenarios (e.g., no speakers detected)
let PRINT_PAGE_LOGS = envVars.LOG_LEVEL === "debug"

// Centralized filter used by both the legacy page.on("console") path and the
// new __botLog bridge below. Returns whether a browser-side log line should
// surface to the Node logger.
function shouldSurfaceBrowserLog(level: string, text: string): boolean {
  const isNetworkInterceptorLog = text.includes("[NetworkInterceptor]")
  const isNetworkError = isNetworkInterceptorLog && (level === "error" || level === "warning")
  const isDebugLog = text.includes("DEBUG")
  const isInterceptorInfo = text.includes("[MeetAudio]") || text.includes("[TeamsAudio]")
  return (
    PRINT_PAGE_LOGS ||
    isNetworkError ||
    (envVars.LOG_LEVEL === "debug" && (isDebugLog || isInterceptorInfo))
  )
}

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

/**
 * Bridge browser-side console.* and uncaught error events back to Node so they
 * land in bot.log. Necessary because rebrowser-playwright's Runtime.enable
 * patch (the core stealth fix at chromium/crPage.js:429) suppresses Playwright's
 * Runtime.consoleAPICalled / Runtime.exceptionThrown events — page.on("console")
 * and page.on("pageerror") receive nothing.
 *
 * How it works:
 *   - exposeFunction("__botLog", ...) installs a binding via Runtime.addBinding,
 *     which rebrowser does NOT block (that's how exposeFunction-based callbacks
 *     like our chat/speaker observers keep working).
 *   - addInitScript installs a monkey-patch on every navigation that wraps
 *     console.log/warn/error/info so they call __botLog in addition to the
 *     original (so devtools still works when poking around locally).
 *   - window error and unhandledrejection listeners capture errors that would
 *     otherwise go to page.on("pageerror").
 *
 * Must be called before page.goto() so the init script is in place for the
 * very first navigation. exposeFunction can finish after page.goto kicks off
 * because the monkey-patch's send() guard tolerates __botLog not being ready
 * yet (silent no-op until it lands).
 */
export async function setupBrowserLogBridge(page: Page): Promise<void> {
  try {
    await page.exposeFunction(
      "__botLog",
      (level: string, text: string, location?: string) => {
        if (!shouldSurfaceBrowserLog(level, text)) return
        const tag = location ? `[browser ${location}]` : "[browser]"
        const line = `${tag} ${text}`
        if (level === "error") console.log("\x1b[31m%s\x1b[0m", line)
        else if (level === "warn" || level === "warning")
          console.log("\x1b[38;5;214m%s\x1b[0m", line)
        else console.log(line)
      }
    )
  } catch (e) {
    // Re-installation on subsequent navigations is harmless — exposeFunction
    // throws "Function has been already registered" which we swallow.
    if (!String(e).includes("already")) {
      console.log(`setupBrowserLogBridge: failed to expose __botLog: ${e}`)
    }
  }

  await page.addInitScript(() => {
    // Guard against double-injection from re-firing init scripts.
    if ((window as any).__botLogPatched) return
    ;(window as any).__botLogPatched = true

    const orig = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      info: console.info.bind(console)
    }
    const stringify = (a: unknown): string => {
      if (a === null || a === undefined) return String(a)
      if (typeof a === "string") return a
      if (typeof a === "number" || typeof a === "boolean") return String(a)
      if (a instanceof Error) return a.stack || a.message || String(a)
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    }
    const send = (level: string, args: unknown[]) => {
      try {
        const fn = (window as any).__botLog
        if (typeof fn !== "function") return
        const text = args.map(stringify).join(" ")
        // Best-effort source location: the third frame of a fresh stack is
        // typically the caller of console.* (frame 0 = Error ctor, 1 = send,
        // 2 = the wrapper below, 3 = caller).
        const loc = (new Error().stack ?? "").split("\n")[3]?.trim()
        fn(level, text, loc)
      } catch {
        // Never let logging itself break the page.
      }
    }
    console.log = (...args: unknown[]) => {
      orig.log(...args)
      send("log", args)
    }
    console.warn = (...args: unknown[]) => {
      orig.warn(...args)
      send("warn", args)
    }
    console.error = (...args: unknown[]) => {
      orig.error(...args)
      send("error", args)
    }
    console.info = (...args: unknown[]) => {
      orig.info(...args)
      send("log", args)
    }
    window.addEventListener("error", (e: ErrorEvent) => {
      send("error", [
        `uncaught error: ${e.message} (${e.filename}:${e.lineno}:${e.colno})`,
        e.error?.stack
      ])
    })
    window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
      send("error", ["unhandled rejection:", e.reason])
    })
  })
}
