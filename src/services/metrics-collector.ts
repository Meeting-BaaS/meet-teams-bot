import { envVars } from "../config/env-vars"
import { GLOBAL } from "../singleton"
import { NORMAL_END_REASONS } from "../state-machine/constants"

export interface BotMetricsPayload {
  bot_uuid: string
  platform: "meet" | "teams" | "zoom"
  resolution: "720" | "1080"
  retry_count: number
  success: boolean
  pod_name: string
  node_name: string
}

export class MetricsCollector {
  private recording = false

  start(): void {
    this.recording = true
  }

  async stop(): Promise<void> {
    this.recording = false
  }

  isRunning(): boolean {
    return this.recording
  }

  async getPayload(): Promise<BotMetricsPayload> {
    if (this.recording) {
      await this.stop()
    }

    const endReason = GLOBAL.getEndReason()
    const success = endReason !== null && NORMAL_END_REASONS.includes(endReason)
    const platform = GLOBAL.get().meeting_platform

    return {
      bot_uuid: GLOBAL.get().bot_uuid,
      platform: (platform === "zoom" ? "zoom" : platform) as "meet" | "teams" | "zoom",
      resolution: envVars.RESOLUTION as "720" | "1080",
      retry_count: GLOBAL.getRetryCount(),
      success,
      pod_name: envVars.POD_NAME || process.env.HOSTNAME || "",
      node_name: envVars.NODE_NAME || ""
    }
  }
}
