import { envVars } from "./config/env-vars"
import { NORMAL_END_REASONS } from "./state-machine/constants"
import { getErrorMessageFromCode, MeetingEndReason } from "./state-machine/types"
import type { ArtifactKey, MeetingParams, Participant, RecordingMode } from "./types"

class Global {
  private meetingParams: MeetingParams | null = null
  private endReason: MeetingEndReason | null = null
  private errorMessage: string | null = null
  private shouldRetry = false // NEW: Retry flag
  private artifactKeys: ArtifactKey[] = []
  private audioChunks: ArtifactKey[] = []
  private participants: Participant[] = []
  private speakers: Participant[] = []
  private networkInterceptionSetupFailed = false // Track if network interception scripts failed to load
  private networkDiarizationActive = false // Track if network diarization is actually active and working
  private hasTriggeredDiarizationFallback = false // Track if diarization fallback has been triggered

  /**
   * Normalizes recording mode values to snake_case format.
   *
   * This function handles both PascalCase and snake_case values because:
   * 1. API requests come in snake_case format (e.g., "speaker_view")
   * 2. The API server converts these to PascalCase (e.g., "SpeakerView") when sending to the queue
   * 3. The smart-rabbit consumer can handle both cases via #[serde(alias = "...")] attributes
   * 4. The recording server needs to handle both cases for consistency with the queue message format
   *
   * @param mode - The recording mode value (can be either PascalCase or snake_case)
   * @returns The normalized recording mode in snake_case format
   */
  private normalizeRecordingMode(
    mode: RecordingMode
  ): "speaker_view" | "gallery_view" | "audio_only" {
    switch (mode) {
      case "gallery_view": // gallery_view maps to speaker_view as requested
      case "speaker_view":
        return "speaker_view"
      case "audio_only":
        return "audio_only"
      default:
        // Default to speaker_view if unknown
        console.warn(`Unknown recording mode: ${mode}, defaulting to speaker_view`)
        return "speaker_view"
    }
  }

  public set(meetingParams: MeetingParams) {
    if (this.meetingParams !== null) {
      throw new Error("Meeting params are already set")
    }

    // Validate critical parameters before setting them
    if (!meetingParams.meeting_url || meetingParams.meeting_url.trim() === "") {
      throw new Error("Missing required parameter: meeting_url")
    }
    if (!meetingParams.bot_uuid || meetingParams.bot_uuid.trim() === "") {
      throw new Error("Missing required parameter: bot_uuid")
    }

    // Normalize the recording mode before setting
    const normalizedParams = {
      ...meetingParams,
      recording_mode: this.normalizeRecordingMode(meetingParams.recording_mode)
    }

    this.meetingParams = normalizedParams
    console.log(`🤖 Bot ${meetingParams.bot_uuid} initialized with validated parameters`)
  }

  public get(): MeetingParams {
    if (this.meetingParams === null) {
      throw new Error("Meeting params are not set")
    }
    return this.meetingParams
  }

  public isServerless(): boolean {
    if (this.meetingParams === null) {
      throw new Error("Meeting params are not set")
    }
    return envVars.SERVERLESS
  }

  public setStartTime(startTime: number): void {
    if (this.meetingParams === null) {
      throw new Error("Meeting params are not set")
    }
    this.meetingParams.start_time = startTime
  }

  public setExitTime(exitTime: number): void {
    if (this.meetingParams === null) {
      throw new Error("Meeting params are not set")
    }
    this.meetingParams.exit_time = exitTime
  }

  public setTransformedMeetingUrl(transformedMeetingUrl: string): void {
    if (this.meetingParams === null) {
      throw new Error("Meeting params are not set")
    }
    this.meetingParams.transformed_meeting_url = transformedMeetingUrl
  }

  public setError(reason: MeetingEndReason, message?: string): void {
    // Don't override these end reasons — they represent a definitive decision
    // about why the bot is stopping and shouldn't be clobbered during cleanup
    if (
      this.endReason === MeetingEndReason.ApiRequest ||
      this.endReason === MeetingEndReason.LoginRequired ||
      this.endReason === MeetingEndReason.ExitingMeetingBeforeRecord
    ) {
      console.log(`🔴 not setting global error, already set to: ${this.endReason}`)
      return
    }

    // If we already have a custom error message for the same reason, and no new message is provided, preserve the existing custom message
    if (
      this.endReason === reason &&
      !message &&
      this.errorMessage &&
      this.errorMessage !== getErrorMessageFromCode(reason)
    ) {
      console.log(
        `🔴 Preserving existing custom error message for ${reason}: "${this.errorMessage}"`
      )
      return
    }

    console.log(`🔴 Setting global error: ${reason}`)
    this.endReason = reason
    this.errorMessage = message || getErrorMessageFromCode(reason)
    console.log(`🔴 End reason set to: ${this.endReason}`)
  }

  public setEndReason(reason: MeetingEndReason): void {
    console.log(`🔵 Setting global end reason: ${reason}`)
    this.endReason = reason

    if (NORMAL_END_REASONS.includes(reason)) {
      console.log(`🔵 Clearing error state for normal termination: ${reason}`)
      // This ensures that an error message isn't propagated to the client for normal termination
      this.clearError()
    }
  }

  public getEndReason(): MeetingEndReason | null {
    return this.endReason
  }

  public getErrorMessage(): string | null {
    return this.errorMessage
  }

  public hasError(): boolean {
    // Only return true if we have an error message (indicating an actual error)
    // Having an end reason alone doesn't mean there's an error
    return this.errorMessage !== null
  }

  public clearError(): void {
    // Only clear the error message, keep the end reason
    // This allows normal termination reasons to be preserved
    this.errorMessage = null
  }

  public clearMeetSsoConfig(): void {
    if (this.meetingParams) {
      this.meetingParams.meet_sso_config = null
    }
  }

  // NEW: Retry flag methods
  public setShouldRetry(value: boolean): void {
    this.shouldRetry = value
    if (value) {
      console.log("🔄 Marking error as retryable")
    }
  }

  public getShouldRetry(): boolean {
    return this.shouldRetry
  }

  public getRetryCount(): number {
    if (this.meetingParams === null) {
      return 0
    }
    return this.meetingParams.retry_count ?? 0
  }

  public addArtifactKey(artifactKey: ArtifactKey): void {
    this.artifactKeys.push(artifactKey)
  }

  public getArtifactKeys(): ArtifactKey[] {
    return this.artifactKeys
  }

  public addAudioChunk(audioChunk: ArtifactKey): void {
    this.audioChunks.push(audioChunk)
  }

  public getAudioChunks(): ArtifactKey[] {
    return this.audioChunks
  }

  public addParticipant(participant: Participant): void {
    this.participants.push(participant)
  }

  public addParticipantIfNotExists(participant: Participant): void {
    // TODO: Use id instead of name
    if (!this.participants.some((p) => p.name === participant.name)) {
      this.participants.push(participant)
    }
  }

  public getParticipants(): Participant[] {
    return this.participants
  }

  public addSpeaker(speaker: Participant): void {
    this.speakers.push(speaker)
  }

  public addSpeakerIfNotExists(speaker: Participant): void {
    // TODO: Use id instead of name
    if (!this.speakers.some((s) => s.name === speaker.name)) {
      this.speakers.push(speaker)
    }
  }

  public getSpeakers(): Participant[] {
    return this.speakers
  }

  /**
   * Mark network interception setup as failed.
   * Used to skip retrying network interception in later states.
   */
  public setNetworkInterceptionSetupFailed(): void {
    this.networkInterceptionSetupFailed = true
  }

  /**
   * Check if network interception setup failed.
   * If true, should skip network interception and use UI-based detection directly.
   */
  public hasNetworkInterceptionSetupFailed(): boolean {
    return this.networkInterceptionSetupFailed
  }

  /**
   * Set network diarization as active (defensive: only sets if not already set).
   * This is called when network diarization is confirmed working (callback setup successful).
   * Using setIfNotSet pattern allows defensive switching back to UI-based if needed.
   */
  public setNetworkDiarizationActiveIfNotSet(): void {
    if (!this.networkDiarizationActive) {
      this.networkDiarizationActive = true
      console.log("[GLOBAL] ✅ Network diarization marked as active")
    }
  }

  /**
   * Check if network diarization is currently active.
   * Returns true if network diarization is confirmed working.
   */
  public isNetworkDiarizationActive(): boolean {
    return this.networkDiarizationActive
  }

  /**
   * Set that diarization fallback has been triggered.
   */
  public setDiarizationFallbackTriggered(): void {
    this.hasTriggeredDiarizationFallback = true
  }

  /**
   * Check if diarization fallback has been triggered.
   */
  public hasDiarizationFallbackTriggered(): boolean {
    return this.hasTriggeredDiarizationFallback
  }
}

export const GLOBAL = new Global()
