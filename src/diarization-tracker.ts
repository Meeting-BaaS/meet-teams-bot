import { createWriteStream, type WriteStream } from "node:fs"
import { join } from "node:path"
import { GLOBAL } from "./singleton"
import type { SpeakerData } from "./types"
import { PathManager } from "./utils/PathManager"

interface DiarizationSegment {
  speaker: string
  user_id: number // Sequential user ID (0 for UI-based detection, 1+ for network-based)
  start_time: number
  end_time: number
}

/**
 * Health status levels for diarization monitoring.
 */
export type DiarizationHealthStatusLevel = "optimal" | "acceptable" | "stale"

/**
 * Tracks speaker diarization during the meeting and writes to a local file.
 * Uses in-memory buffering to minimize file I/O operations.
 */
export interface DiarizationHealthStatus {
  hasActive: boolean
  hasRecent60s: boolean
  hasRecent5min: boolean
  segmentCount60s: number
  segmentCount5min: number
  status: DiarizationHealthStatusLevel
}

export class DiarizationTracker {
  private static instance: DiarizationTracker | null = null
  private fileStream: WriteStream | null = null
  private currentSegment: { speaker: string; startTime: number; userId: number } | null = null
  private recentSegments: DiarizationSegment[] = [] // Last 5 closed segments
  private filePath: string
  private isEnded = false

  private constructor(tempDir: string) {
    this.filePath = join(tempDir, "diarization.jsonl")
    // Open file stream for append-only writing (efficient for continuous logs)
    this.fileStream = createWriteStream(this.filePath, { flags: "a" })
  }

  public static getInstance(): DiarizationTracker {
    if (!DiarizationTracker.instance) {
      const pathManager = PathManager.getInstance()
      const tempDir = pathManager.getTempPath()
      DiarizationTracker.instance = new DiarizationTracker(tempDir)
    }
    return DiarizationTracker.instance
  }

  /**
   * Update the current speaker segment.
   * @param speaker - Speaker data with name and timestamp
   * @param meetingStartTime - Meeting start timestamp in milliseconds
   */
  public updateSpeaker(speaker: SpeakerData, meetingStartTime: number): void {
    if (this.isEnded) {
      console.warn("DiarizationTracker: Attempted to update after ended")
      return
    }

    const relativeTime = (speaker.timestamp - meetingStartTime) / 1000

    // If we have a current segment, close it before starting a new one
    if (this.currentSegment) {
      const closedSegment: DiarizationSegment = {
        speaker: this.currentSegment.speaker,
        start_time: this.currentSegment.startTime,
        end_time: relativeTime,
        user_id: this.currentSegment.userId
      }
      this.writeToFile(closedSegment)
      
      // Add to recent segments (keep max 5)
      this.recentSegments.push(closedSegment)
      if (this.recentSegments.length > 5) {
        this.recentSegments.shift() // Remove oldest
      }
    }

    // Start new segment (keep in memory)
    this.currentSegment = {
      speaker: speaker.name,
      startTime: relativeTime,
      userId: speaker.id
    }
  }

  /**
   * Finalize the tracker by closing the last segment.
   * @param lastTimestamp - Last timestamp of the meeting in milliseconds
   * @param meetingStartTime - Meeting start timestamp in milliseconds
   * @returns Promise that resolves when the file stream is fully closed and flushed
   */
  public end(lastTimestamp: number, meetingStartTime: number): Promise<void> {
    if (this.isEnded) {
      return Promise.resolve()
    }
    this.isEnded = true

    // Close the file stream and wait for it to finish flushing
    if (this.fileStream) {
      return new Promise<void>((resolve, reject) => {
        const stream = this.fileStream!
        this.fileStream = null

        // Write the last segment if it exists
        if (this.currentSegment) {
          const relativeTime = (lastTimestamp - meetingStartTime) / 1000
          const finalSegment: DiarizationSegment = {
            speaker: this.currentSegment.speaker,
            start_time: this.currentSegment.startTime,
            end_time: relativeTime,
            user_id: this.currentSegment.userId
          }
          const line = `${JSON.stringify(finalSegment)}\n`

          // Write the final segment and check if we need to wait for drain
          const writeSuccess = stream.write(line)
          if (!writeSuccess) {
            // If write returned false, wait for drain before ending
            stream.once("drain", () => {
              stream.end()
            })
          } else {
            // Write was successful, can end immediately
            stream.end()
          }
        } else {
          // No final segment to write, just end the stream
          stream.end()
        }

        // Wait for the stream to finish flushing all data
        stream.once("finish", () => {
          console.log(`Diarization tracking completed: ${this.filePath}`)
          resolve()
        })

        stream.once("error", (error) => {
          console.error(`DiarizationTracker: Error closing stream: ${error}`)
          reject(error)
        })
      })
    }

    console.log(`Diarization tracking completed: ${this.filePath}`)
    return Promise.resolve()
  }

  /**
   * Get the file path for the diarization file.
   */
  public getFilePath(): string {
    return this.filePath
  }

  /**
   * Get the current active segment.
   */
  public getCurrentSegment(): { speaker: string; startTime: number; userId: number } | null {
    return this.currentSegment
  }

  /**
   * Check if there's an active or recent segment within the specified time windows.
   * @param meetingStartTime - Meeting start timestamp in milliseconds
   * @param currentTime - Current timestamp in milliseconds
   * @returns Health status object
   */
  public hasActiveOrRecentSegment(
    meetingStartTime: number,
    currentTime: number
  ): DiarizationHealthStatus {
    const currentTimeSeconds = (currentTime - meetingStartTime) / 1000
    const window60s = 60 // 60 seconds
    const window5min = 300 // 5 minutes

    let hasActive = false
    let hasRecent60s = false
    let hasRecent5min = false
    let segmentCount60s = 0
    let segmentCount5min = 0

    // Check current active segment
    if (this.currentSegment) {
      hasActive = true
      const segmentAge = currentTimeSeconds - this.currentSegment.startTime
      
      if (segmentAge < window60s) {
        hasRecent60s = true
        segmentCount60s++
      }
      if (segmentAge < window5min) {
        hasRecent5min = true
        segmentCount5min++
      }
    }

    // Check recent closed segments
    for (const segment of this.recentSegments) {
      const segmentAge = currentTimeSeconds - segment.end_time
      
      if (segmentAge < window60s) {
        hasRecent60s = true
        segmentCount60s++
      }
      if (segmentAge < window5min) {
        hasRecent5min = true
        segmentCount5min++
      }
    }

    // Determine overall status
    let status: DiarizationHealthStatusLevel
    if (segmentCount60s > 1) {
      status = "optimal"
    } else if (hasRecent5min) {
      status = "acceptable"
    } else {
      status = "stale"
    }

    return {
      hasActive,
      hasRecent60s,
      hasRecent5min,
      segmentCount60s,
      segmentCount5min,
      status
    }
  }

  /**
   * Write a segment to the file (JSONL format).
   */
  private writeToFile(segment: DiarizationSegment): void {
    if (!this.fileStream) {
      console.error("DiarizationTracker: File stream not initialized")
      return
    }

    const line = `${JSON.stringify(segment)}\n`
    this.fileStream.write(line)
  }
}
