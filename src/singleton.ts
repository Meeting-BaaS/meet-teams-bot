import { envVars } from "./config/env-vars"
import { MetricsCollector } from "./services/metrics-collector"
import { NORMAL_END_REASONS } from "./state-machine/constants"
import { getErrorMessageFromCode, MeetingEndReason } from "./state-machine/types"
import type { ArtifactKey, MeetingParams, Participant, RecordingMode } from "./types"
import { PiiRedactor } from "./utils/PiiRedactor"

class Global {
  private meetingParams: MeetingParams | null = null
  private endReason: MeetingEndReason | null = null
  private errorMessage: string | null = null
  private shouldRetry = false // NEW: Retry flag
  private recoveryClaimed = false // True once a termination/crash path has taken ownership of log-upload + requeue (see claimRecovery)
  private endMeetingReportClaimed = false // True while/after a path owns the end-meeting-trampoline report (see claimEndMeetingReport)
  private recordingFinalized = false // True once the recording is merged and entering upload (see markRecordingFinalized)
  private endMeetingPayloadReady = false // True once uploadToS3 has recorded the complete artifact manifest
  private artifactKeys: ArtifactKey[] = []
  private audioChunks: ArtifactKey[] = []
  private participants: Participant[] = []
  private speakers: Participant[] = []
  private networkInterceptionSetupFailed = false // Track if network interception scripts failed to load
  private networkDiarizationActive = false // Track if network diarization is actually active and working
  private hasTriggeredDiarizationFallback = false // Track if diarization fallback has been triggered
  private lastDcrpcSpeakerAt = 0 // Date.now() of the last active speaker decoded from the dcrpc datachannel (NetEq)
  private lastNetworkAudioSpeakerAt = 0 // Date.now() of the last active speaker seen on the network audio path (CSRC/getContributingSources — force-native)
  private lastNetworkAudioFramesAt = 0 // Date.now() of the last health check reporting per-participant tracks delivering frames (path alive even during silence)
  private rearmedNetworkDiarization = false // Track if the network path was ever re-armed after a fallback
  private networkInterceptionStopped = false // Page-side interceptor was torn down; nothing can restart it

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

    // Register the bot name with the PII redactor as soon as meeting
    // params are available: bot names often contain end-user names and
    // must be masked as <BOT_NAME> in every log line.
    PiiRedactor.registerBotName(normalizedParams.bot_name)

    console.log(`🤖 Bot ${meetingParams.bot_uuid} initialized with validated parameters`)
  }

  /**
   * Meeting params if they've been parsed, otherwise null.
   *
   * Unlike `get()` this never throws, for the modules that run before stdin is
   * parsed (Logger, PathManager) and must fall back to env-var defaults rather
   * than crash. See config/storage.ts.
   */
  public tryGet(): MeetingParams | null {
    return this.meetingParams
  }

  public get(): MeetingParams {
    if (this.meetingParams === null) {
      throw new Error("Meeting params are not set")
    }
    return this.meetingParams
  }

  /**
   * True when get() will not throw.
   *
   * Exists for logging paths that run on shutdown, where params may never have
   * been set because the bot failed before initialization. A log line is not
   * worth an exception — see logStats() in proxy/toggle-proxy.ts.
   */
  public hasParams(): boolean {
    return this.meetingParams !== null
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

  /**
   * Fully wipe the transient error / end-reason / retry flags so a bounded
   * in-process join retry (fresh proxy IP, same pod) starts clean and a
   * subsequent admission isn't treated as a failed run. Only call BETWEEN
   * in-process attempts — never after a terminal decision.
   */
  public resetErrorState(): void {
    this.endReason = null
    this.errorMessage = null
    this.shouldRetry = false
  }

  public clearMeetSsoConfig(): void {
    if (this.meetingParams) {
      this.meetingParams.meet_sso_config = null
    }
  }

  public clearTeamsLoginConfig(): void {
    if (this.meetingParams) {
      this.meetingParams.teams_login_config = null
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

  /**
   * Single, atomic recovery-ownership claim shared by the requeue sites (the
   * primary failure-retry in handleFailedRecording, the SIGTERM handler's requeue
   * branch, and the Logger crash handler's requeue branch). The first caller wins
   * and receives `true`; every subsequent caller receives `false`.
   *
   * INVARIANT (see the #224 regression note in main.ts): this token is taken ONLY
   * immediately before an actual requeueToSQS() — never up front by a handler that
   * might then take a non-requeuing branch. Because of that, a caller that loses
   * the claim can safely conclude the meeting has ALREADY been requeued by another
   * path and skip its own requeue. Taking the claim without requeuing would starve
   * the primary retry (which is exactly the #224 bug this rule fixes).
   *
   * Node's single-threaded run-to-completion model makes the check-and-set atomic
   * with respect to other callers.
   */
  public claimRecovery(): boolean {
    if (this.recoveryClaimed) {
      return false
    }
    this.recoveryClaimed = true
    return true
  }

  /**
   * Release a claim taken by claimRecovery() when the requeueToSQS() it guarded
   * FAILED to send. Without this, a failed send leaves recoveryClaimed=true, so
   * every other requeue path (SIGTERM / crash handler) sees isRecoveryClaimed()
   * and stands down — and the meeting is never requeued (silently lost). Callers
   * MUST release ONLY on send failure, and ONLY the caller that won the claim, so
   * another path can take over the requeue. Never release after a successful send.
   */
  public releaseRecovery(): void {
    this.recoveryClaimed = false
  }

  /**
   * Read-only peek at whether a recovery path already owns the claim. Terminator
   * handlers (SIGTERM / crash) use it only to STAND DOWN — return without calling
   * exit(), so they don't kill an in-flight requeue mid-write. They must NOT use it
   * to gate a requeue: only claimRecovery(), taken immediately before the requeue,
   * may do that.
   */
  public isRecoveryClaimed(): boolean {
    return this.recoveryClaimed
  }

  /**
   * Atomic ownership claim for the end-meeting-trampoline report, shared by the
   * happy path (handleSuccessfulRecording → handleEndMeetingWithRetry) and the
   * crash handler's finalized branch (Logger handleCrash). The first caller wins;
   * a loser can safely conclude another path is reporting (or already reported)
   * and skip — a double POST would double-submit transcription server-side.
   *
   * Same claim/release discipline as claimRecovery(): release ONLY when every
   * attempt to send the report failed, so a later path (e.g. the crash handler
   * after the happy path crashed mid-flight) can take over.
   */
  public claimEndMeetingReport(): boolean {
    if (this.endMeetingReportClaimed) {
      return false
    }
    this.endMeetingReportClaimed = true
    return true
  }

  public releaseEndMeetingReport(): void {
    this.endMeetingReportClaimed = false
  }

  // Phase marker: true once the recording has been MERGED into its final output
  // and is entering the upload phase. Crash/eviction handlers use it to decide
  // requeue vs preserve:
  //   - BEFORE finalize (join, or mid-recording): the only copy lives in ephemeral
  //     /tmp, which dies with the pod — so REQUEUE to re-record (nothing to salvage).
  //   - AFTER finalize (uploading): the merged output exists and the S3Uploader
  //     EFS-fallback + reconciliation job salvage any upload failure — so do NOT
  //     requeue (that would re-record and duplicate).
  public markRecordingFinalized(): void {
    this.recordingFinalized = true
  }

  public hasRecordingFinalized(): boolean {
    return this.recordingFinalized
  }

  public markEndMeetingPayloadReady(): void {
    this.endMeetingPayloadReady = true
  }

  public hasEndMeetingPayloadReady(): boolean {
    return this.endMeetingPayloadReady
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
   * Record that the dcrpc datachannel just decoded an active speaker (NetEq
   * sessions). Used to hold the network path against the stale-diarization
   * fallback while the dcrpc signal is live.
   */
  public markDcrpcSpeaker(): void {
    this.lastDcrpcSpeakerAt = Date.now()
  }

  /**
   * Milliseconds since the last dcrpc-decoded active speaker, or Infinity if
   * dcrpc has never produced one.
   */
  public msSinceLastDcrpcSpeaker(): number {
    if (this.lastDcrpcSpeakerAt === 0) return Number.POSITIVE_INFINITY
    return Date.now() - this.lastDcrpcSpeakerAt
  }

  /**
   * Record that the network audio path (CSRC / getContributingSources, exposed
   * once MEET_FORCE_NATIVE_AUDIO_PIPELINE flips Meet onto the native WebRTC
   * pipeline) just reported an active speaker — even if the name has not
   * resolved yet. Used to tell a live-but-unresolved path (roster race) apart
   * from a genuinely dead one so the stale monitor holds the former and
   * fast-falls-back the latter.
   */
  public markNetworkAudioSpeaker(): void {
    this.lastNetworkAudioSpeakerAt = Date.now()
  }

  /**
   * Milliseconds since the last network-audio active speaker, or Infinity if
   * the network audio path has never reported one.
   */
  public msSinceLastNetworkAudioSpeaker(): number {
    if (this.lastNetworkAudioSpeakerAt === 0) return Number.POSITIVE_INFINITY
    return Date.now() - this.lastNetworkAudioSpeakerAt
  }

  /**
   * Record that the network audio interceptor just reported per-participant
   * tracks delivering frames. This is the liveness signal that survives a
   * silence window: the native path can be alive (tracks flowing) with no
   * speaker active at the instant the never-produced stale threshold fires.
   */
  public markNetworkAudioFrames(): void {
    this.lastNetworkAudioFramesAt = Date.now()
  }

  /**
   * Milliseconds since the network audio path last reported tracks delivering
   * frames, or Infinity if it never has.
   */
  public msSinceLastNetworkAudioFrames(): number {
    if (this.lastNetworkAudioFramesAt === 0) return Number.POSITIVE_INFINITY
    return Date.now() - this.lastNetworkAudioFramesAt
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

  /**
   * Re-arm the network diarization path after a fallback. Clears BOTH latches
   * (fallback-triggered and interception-setup-failed) so the source arbitration
   * in SpeakerManager flips back: network updates are processed again and the UI
   * bridge re-mutes automatically. Only call this once the network path is
   * demonstrably alive again (per-participant tracks delivering frames), so
   * clearing the interception-failed latch reflects reality.
   */
  public rearmNetworkDiarization(): boolean {
    // Refuse to re-arm a path that was torn down. __stopNetworkInterception
    // aborts the tracks and clears the CSRC sampler with no restart, so clearing
    // the latches would mute the UI bridge in favour of a source that can never
    // produce again — worse than the fallback it replaces. Meet never stops the
    // interceptor, which is what makes its re-arm safe; this keeps that a
    // checked invariant rather than a convention.
    if (this.networkInterceptionStopped) return false
    this.hasTriggeredDiarizationFallback = false
    this.networkInterceptionSetupFailed = false
    this.rearmedNetworkDiarization = true
    return true
  }

  /**
   * Record that the page-side interceptor was torn down. One-way: there is no
   * restart path, so a stopped interceptor stays stopped for the meeting.
   */
  public markNetworkInterceptionStopped(): void {
    this.networkInterceptionStopped = true
  }

  public isNetworkInterceptionStopped(): boolean {
    return this.networkInterceptionStopped
  }

  /**
   * True once the network path has been re-armed at least this call. The UI
   * bridge mutes on it: a re-arm usually follows a never-produced fallback, so
   * the network path has never reported a speaker and the bridge's own
   * first-speaker latch is still false — without this both sources would commit
   * speaker boundaries until the first network speaker arrives.
   */
  public hasRearmedNetworkDiarization(): boolean {
    return this.rearmedNetworkDiarization
  }

  private metricsCollector: MetricsCollector | null = null

  public getMetricsCollector(): MetricsCollector {
    if (!this.metricsCollector) {
      this.metricsCollector = new MetricsCollector()
    }
    return this.metricsCollector
  }
}

export const GLOBAL = new Global()
