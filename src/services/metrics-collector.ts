import { envVars } from "../config/env-vars"
import { GLOBAL } from "../singleton"

export interface BotMetricsPayload {
  bot_id: number
  bot_uuid: string
  platform: "meet" | "teams" | "zoom"
  bot_type: "meet-teams"
  config: {
    resolution: "720" | "1080"
    recording_mode: "speaker_view" | "gallery_view" | "audio_only"
  }
  duration: {
    total_sec: number
    recording_sec: number
    idle_sec: number
  }
  resources: {
    cpu_total_sec: number
    mem_rss_start_mb: number
    mem_rss_end_mb: number
    mem_heap_start_mb: number
    mem_heap_end_mb: number
  }
  meeting_info: {
    participant_count: number
    speaker_count: number
  }
}

export class MetricsCollector {
  private cpuStart: NodeJS.CpuUsage | null = null
  private memRssStartMb = 0
  private memHeapStartMb = 0
  private recordingStartTime = 0
  private cpuDeltaSec = 0
  private memRssEndMb = 0
  private memHeapEndMb = 0
  private stopped = false

  start(): void {
    const mem = process.memoryUsage()
    this.cpuStart = process.cpuUsage()
    this.memRssStartMb = Math.round(mem.rss / 1024 / 1024)
    this.memHeapStartMb = Math.round(mem.heapUsed / 1024 / 1024)
    this.recordingStartTime = Date.now()
    this.stopped = false
  }

  stop(): void {
    const cpuEnd = process.cpuUsage(this.cpuStart ?? undefined)
    const mem = process.memoryUsage()
    this.cpuDeltaSec = (cpuEnd.user + cpuEnd.system) / 1e6
    this.memRssEndMb = Math.round(mem.rss / 1024 / 1024)
    this.memHeapEndMb = Math.round(mem.heapUsed / 1024 / 1024)
    this.stopped = true
  }

  isRunning(): boolean {
    return !this.stopped && this.cpuStart !== null
  }

  getPayload(): BotMetricsPayload {
    if (!this.stopped) {
      this.stop()
    }

    const startTime = GLOBAL.get().start_time
    const exitTime = GLOBAL.get().exit_time || Math.floor(Date.now() / 1000)
    const totalSec = Math.max(0, exitTime - startTime)
    const recordingSec = Math.max(0, (Date.now() - this.recordingStartTime) / 1000)
    const idleSec = Math.max(0, totalSec - recordingSec)

    const platform = GLOBAL.get().meeting_platform

    return {
      bot_id: GLOBAL.get().bot_id,
      bot_uuid: GLOBAL.get().bot_uuid,
      platform: (platform === "zoom" ? "zoom" : platform) as "meet" | "teams" | "zoom",
      bot_type: "meet-teams",
      config: {
        resolution: envVars.RESOLUTION as "720" | "1080",
        recording_mode: GLOBAL.get().recording_mode as
          | "speaker_view"
          | "gallery_view"
          | "audio_only"
      },
      duration: {
        total_sec: totalSec,
        recording_sec: recordingSec,
        idle_sec: idleSec
      },
      resources: {
        cpu_total_sec: this.cpuDeltaSec,
        mem_rss_start_mb: this.memRssStartMb,
        mem_rss_end_mb: this.memRssEndMb,
        mem_heap_start_mb: this.memHeapStartMb,
        mem_heap_end_mb: this.memHeapEndMb
      },
      meeting_info: {
        participant_count: GLOBAL.getParticipants().length,
        speaker_count: GLOBAL.getSpeakers().length
      }
    }
  }
}
