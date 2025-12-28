import fs from "node:fs"
import path from "node:path"
import winston from "winston"
import { envVars } from "../config/env-vars"
import { GLOBAL } from "../singleton"
import { PathManager } from "./PathManager"
import { S3Uploader, s3cp } from "./S3Uploader"

/**
 * Error information extracted safely with type checking
 */
export interface ErrorInfo {
    error: unknown
    message: string
    stack?: string
    name?: string
    errorType?: string
}

/**
 * Safely extracts error information with type checking and preserves stack traces
 * @param error - The error object (can be any type)
 * @param additionalContext - Optional additional context to include
 * @returns Structured error information with stack trace
 */
export function formatError(
    error: unknown,
    additionalContext?: Record<string, unknown>,
): ErrorInfo & Record<string, unknown> {
    const errorInfo: ErrorInfo = {
        error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : undefined,
        errorType: error?.constructor?.name,
    }

    return { ...errorInfo, ...additionalContext }
}

// Reference to current bot log file
const currentBotLogFile: string | null = null

// Store current caller info globally
let currentCaller = "unknown:0"

const format = winston.format.combine(
  winston.format.colorize({
    all: true,
    colors: {
      info: "cyan",
      warn: "yellow",
      error: "red",
      debug: "blue"
    }
  }),
  winston.format.timestamp({
    format: () => new Date().toISOString()
  }),
  winston.format.printf(({ timestamp, level, message }) => {
    return `${timestamp}  ${level} ${currentCaller}: ${message}`
  })
)

function formatTable(data: unknown): string {
  if (!Array.isArray(data) && typeof data !== "object") {
    return String(data)
  }

  const array = Array.isArray(data) ? data : [data]
  if (array.length === 0) return ""

  const headers = new Set<string>()
  for (const item of array) {
    for (const key of Object.keys(item)) {
      headers.add(key)
    }
  }
  const cols = Array.from(headers)

  const lines = [
    cols,
    cols.map(() => "-".repeat(15)),
    ...array.map((item) => cols.map((col) => String(item[col] ?? "").substring(0, 15)))
  ]

  const colWidths = cols.map((_, i) => Math.max(...lines.map((line) => line[i].length)))

  return (
    "\n" +
    lines
      .map((line) => `│ ${line.map((val, i) => val.padEnd(colWidths[i])).join(" │ ")} │`)
      .join("\n")
  )
}

function formatArgs(msg: string, args: unknown[]) {
  return (
    msg +
    " " +
    args
      .map((arg) => {
        if (arg === null) return "null"
        if (arg === undefined) return "undefined"
        if (typeof arg === "object") {
          try {
            return JSON.stringify(arg, null, 2)
          } catch (_e) {
            return String(arg)
          }
        }
        return String(arg)
      })
      .join(" ")
  )
}

// Function to capture caller info at the console override level
function getCaller(): string {
  const stack = new Error().stack
  if (!stack) return "unknown:0"

  const lines = stack.split("\n")
  // Look for the first non-internal frame (skip Error, getCaller, and console override)
  for (let i = 3; i < lines.length; i++) {
    const line = lines[i]
    if (line && !line.includes("node_modules") && !line.includes("Logger.ts")) {
      const match = line.match(/at.*\((.+):(\d+):\d+\)/) || line.match(/at (.+):(\d+):\d+/)
      if (match) {
        const fullPath = match[1]
        const filename = fullPath.split("/").pop()?.split(".")[0] || "unknown"
        const lineNumber = match[2]
        return `${filename}:${lineNumber}`
      }
    }
  }
  return "unknown:0"
}

// Global winston logger
const logger = winston.createLogger({
  level: "debug",
  format: format,
  transports: [
    new winston.transports.Console({
      format: format
    })
  ]
})

export function setupConsoleLogger() {
  console.log("Setting up console logger")

  console.log = (msg: string, ...args: unknown[]) => {
    currentCaller = getCaller()
    logger.info(formatArgs(msg, args))
  }
  console.info = (msg: string, ...args: unknown[]) => {
    currentCaller = getCaller()
    logger.info(formatArgs(msg, args))
  }
  console.warn = (msg: string, ...args: unknown[]) => {
    currentCaller = getCaller()
    logger.warn(formatArgs(msg, args))
  }
  console.error = (msg: string, ...args: unknown[]) => {
    currentCaller = getCaller()
    logger.error(formatArgs(msg, args))
  }
  console.debug = (msg: string, ...args: unknown[]) => {
    currentCaller = getCaller()
    logger.debug(formatArgs(msg, args))
  }
  console.table = (data: unknown) => {
    currentCaller = getCaller()
    logger.info(formatTable(data))
  }

  console.log("Console logger setup complete")
}

export async function uploadScreenshotsToS3(): Promise<void> {
  const pathManager = PathManager.getInstance()
  const logPath = currentBotLogFile || pathManager.getIdentifier()

  // Screenshots directory
  const screenshotsPath = pathManager.getScreenshotsPath()
  const s3ScreenshotsPath = `${logPath}/screenshots`
  try {
    console.log("Looking for screenshots at:", screenshotsPath)

    // Upload screenshots directory
    if (fs.existsSync(screenshotsPath)) {
      const screenshotFiles = fs.readdirSync(screenshotsPath)
      if (screenshotFiles.length > 0) {
        logger.info(`Uploading ${screenshotFiles.length} screenshots to S3...`)

        // Use directory sync for better performance
        try {
          await S3Uploader.getInstance()?.uploadDirectory(
            screenshotsPath,
            envVars.AWS_S3_ARTIFACTS_BUCKET, // Screenshots are considered artifacts, storing them in the artifacts bucket
            s3ScreenshotsPath
          )
          GLOBAL.addArtifactKey({
            s3Key: s3ScreenshotsPath,
            filePath: screenshotsPath,
            extension: "directory",
            uploaded: true,
            uploadedAt: new Date().toISOString(),
            type: "screenshots",
            errorCode: null,
            errorMessage: null
          })
          logger.info("Screenshots uploaded to S3")
        } catch (error) {
          logger.error("Directory sync failed:", error)
          GLOBAL.addArtifactKey({
            s3Key: null,
            filePath: screenshotsPath,
            extension: "directory",
            uploaded: false,
            uploadedAt: null,
            type: "screenshots",
            errorCode: "UPLOAD_FAILED",
            errorMessage: error instanceof Error ? error.message : JSON.stringify(error)
          })
        }
      } else {
        console.log("Screenshots directory exists but is empty:", screenshotsPath)
        GLOBAL.addArtifactKey({
          s3Key: null,
          filePath: screenshotsPath,
          extension: "directory",
          uploaded: false,
          uploadedAt: null,
          type: "screenshots",
          errorCode: "FILE_NOT_FOUND",
          errorMessage: `Screenshots directory not found: ${screenshotsPath}`
        })
      }
    } else {
      console.log("No screenshots directory found at path:", screenshotsPath)
    }
  } catch (error) {
    logger.error("Failed to upload screenshots to S3:", error)
    GLOBAL.addArtifactKey({
      s3Key: null,
      filePath: screenshotsPath,
      extension: "directory",
      uploaded: false,
      uploadedAt: null,
      type: "screenshots",
      errorCode: "UPLOAD_FAILED",
      errorMessage: error instanceof Error ? error.message : JSON.stringify(error)
    })
  }
}

export async function uploadLogsToS3(): Promise<void> {
  try {
    const pathManager = PathManager.getInstance()
    const logPath = currentBotLogFile || pathManager.getIdentifier()

    // Sound log file
    const soundLogPath = pathManager.getSoundLogPath()
    const s3SoundLogPath = `${logPath}/sound.log`

    // Speaker separation log file
    const speakerLogPath = pathManager.getSpeakerLogPath()
    const s3SpeakerLogPath = `${logPath}/speaker_separation.log`

    // Network speaker detection log file
    const networkSpeakerLogPath = pathManager.getNetworkSpeakerLogPath()
    const s3NetworkSpeakerLogPath = `${logPath}/network_speaker_activity.log`

    // Network speaker metadata file (PII - separate from activity logs)
    const networkSpeakerMetadataPath = pathManager.getNetworkSpeakerMetadataPath()
    const s3NetworkSpeakerMetadataPath = `${logPath}/network_speaker_metadata.json`

    // HTML snapshots directory
    const htmlSnapshotsPath = pathManager.getHtmlSnapshotsPath()
    const s3HtmlSnapshotsPath = `${logPath}/html_snapshots`

    console.log("Looking for internal log files at:", {
      soundLogPath,
      speakerLogPath,
      networkSpeakerLogPath,
      networkSpeakerMetadataPath,
      htmlSnapshotsPath
    })

    // Upload sound log file (internal log file)
    if (fs.existsSync(soundLogPath)) {
      logger.info("Uploading sound logs to S3...")
      await s3cp(soundLogPath, s3SoundLogPath)
      logger.info("Sound logs uploaded to S3")
    } else {
      console.log("No sound log file found at path:", soundLogPath)
    }

    // Upload speaker separation log file
    if (fs.existsSync(speakerLogPath)) {
      logger.info("Uploading speaker separation logs to S3...")
      await s3cp(speakerLogPath, s3SpeakerLogPath)
      logger.info("Speaker separation logs uploaded to S3")
    } else {
      console.log("No speaker separation log file found at path:", speakerLogPath)
    }

    // Upload network speaker detection log file
    if (fs.existsSync(networkSpeakerLogPath)) {
      logger.info("Uploading network speaker detection logs to S3...")
      await s3cp(networkSpeakerLogPath, s3NetworkSpeakerLogPath)
      logger.info("Network speaker detection logs uploaded to S3")
    } else {
      console.log("No network speaker detection log file found at path:", networkSpeakerLogPath)
    }

    // Upload network speaker metadata file
    if (fs.existsSync(networkSpeakerMetadataPath)) {
      logger.info("Uploading network speaker metadata to S3...")
      await s3cp(networkSpeakerMetadataPath, s3NetworkSpeakerMetadataPath)
      logger.info("Network speaker metadata uploaded to S3")
    } else {
      console.log("No network speaker metadata file found at path:", networkSpeakerMetadataPath)
    }

    // Upload screenshots if they are not already uploaded
    if (GLOBAL.getArtifactKeys().some((artifact) => artifact.type !== "screenshots")) {
      await uploadScreenshotsToS3()
    }

    // Upload HTML snapshots directory
    if (fs.existsSync(htmlSnapshotsPath)) {
      const htmlSnapshotFiles = fs.readdirSync(htmlSnapshotsPath)
      if (htmlSnapshotFiles.length > 0) {
        logger.info(`Uploading ${htmlSnapshotFiles.length} HTML snapshots to S3...`)

        // Use directory sync for better performance
        try {
          await S3Uploader.getInstance()?.uploadDirectory(
            htmlSnapshotsPath,
            envVars.AWS_S3_LOGS_BUCKET,
            s3HtmlSnapshotsPath
          )
          logger.info("HTML snapshots uploaded to S3")
        } catch (error) {
          logger.error(
            "HTML snapshots directory sync failed, falling back to individual uploads:",
            error
          )
          // Fallback to individual uploads
          for (const filename of htmlSnapshotFiles) {
            const htmlSnapshotPath = path.join(htmlSnapshotsPath, filename)
            const s3HtmlSnapshotPath = `${s3HtmlSnapshotsPath}/${filename}`
            await s3cp(htmlSnapshotPath, s3HtmlSnapshotPath)
          }
          logger.info("HTML snapshots uploaded to S3 (fallback)")
        }
      } else {
        console.log("HTML snapshots directory exists but is empty:", htmlSnapshotsPath)
      }
    } else {
      console.log("No HTML snapshots directory found at path:", htmlSnapshotsPath)
    }
  } catch (error) {
    logger.error("Failed to upload logs to S3:", error)
    throw error
  }
}

export function setupExitHandler() {
  process.on("uncaughtException", async (error) => {
    logger.error(`Uncaught Exception: ${error}`)
    if (!GLOBAL.isServerless()) {
      try {
        await uploadLogsToS3()
      } catch (uploadError) {
        logger.error(`Failed to upload crash logs to S3: ${uploadError}`)
      }
    }
  })

  process.on("unhandledRejection", async (reason, promise) => {
    logger.error(`Unhandled Rejection at: ${promise} reason: ${reason}`)
    if (!GLOBAL.isServerless()) {
      try {
        await uploadLogsToS3()
      } catch (uploadError) {
        logger.error(`Failed to upload crash logs to S3: ${uploadError}`)
      }
    }
    // Force exit to avoid hanging processes
    process.exit(1)
  })
}
