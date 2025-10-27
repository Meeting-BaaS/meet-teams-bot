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
  private botUuid: string

  private constructor(tempDir: string, botUuid: string) {
    this.botUuid = botUuid
    this.filePath = join(tempDir, "diarization.jsonl")
    // Open file stream for append-only writing (efficient for continuous logs)
    this.fileStream = createWriteStream(this.filePath, { flags: "a" })
  }

  public static getInstance(): DiarizationTracker {
    if (!DiarizationTracker.instance) {
      const pathManager = PathManager.getInstance()
      const tempDir = pathManager.getTempPath()
      const botUuid = GLOBAL.get().botUuid
      DiarizationTracker.instance = new DiarizationTracker(tempDir, botUuid)
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
   */
  public end(lastTimestamp: number, meetingStartTime: number): void {
    if (this.isEnded) {
      return
    }
    this.isEnded = true

    // Close the last segment if it exists
    if (this.currentSegment) {
      const relativeTime = (lastTimestamp - meetingStartTime) / 1000
      const finalSegment: DiarizationSegment = {
        speaker: this.currentSegment.speaker,
        start_time: this.currentSegment.startTime,
        end_time: relativeTime
      }
      this.writeToFile(finalSegment)
    }

    // Close the file stream
    if (this.fileStream) {
      this.fileStream.end()
      this.fileStream = null
    }

    console.log(`Diarization tracking completed: ${this.filePath}`)
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
