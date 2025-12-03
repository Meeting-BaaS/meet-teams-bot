import { createWriteStream, type WriteStream } from "node:fs"
import { join } from "node:path"
import { GLOBAL } from "./singleton"
import type { SpeakerData } from "./types"
import { PathManager } from "./utils/PathManager"

interface DiarizationSegment {
  speaker: string
  start_time: number
  end_time: number
}

/**
 * Tracks speaker diarization during the meeting and writes to a local file.
 * Uses in-memory buffering to minimize file I/O operations.
 */
export class DiarizationTracker {
  private static instance: DiarizationTracker | null = null
  private fileStream: WriteStream | null = null
  private currentSegment: { speaker: string; startTime: number } | null = null
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
        end_time: relativeTime
      }
      this.writeToFile(closedSegment)
    }

    // Start new segment (keep in memory)
    this.currentSegment = {
      speaker: speaker.name,
      startTime: relativeTime
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
            end_time: relativeTime
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
