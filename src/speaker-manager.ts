import * as fs from "node:fs"
import { enablePrintPageLogs } from "./browser/page-logger"
import { DiarizationTracker } from "./diarization-tracker"
import type { NetworkUser } from "./meeting/meet/network-interception/types"
import { GLOBAL } from "./singleton"
import { MeetingStateMachine } from "./state-machine/machine"
import type { ParticipantState } from "./state-machine/types"
import { Streaming } from "./streaming"
import type { Participant, SpeakerData } from "./types"
import { PathManager } from "./utils/PathManager"
import { createSequentialIdManager, generateStableUserId } from "./utils/speaker-id"

export class SpeakerManager {
  private static instance: SpeakerManager | null = null
  private currentSpeaker: SpeakerData | null = null
  private readonly PAUSE_BETWEEN_SENTENCES = 1000 // 1 second
  private lastSpeakerTime: number | null = null
  private diarizationTracker: DiarizationTracker | null = null
  private lastCallbackTime: number | null = null // Track when we last received ANY callback
  // Sequential ID manager for network-detected speakers
  private sequentialIdManager = createSequentialIdManager()

  private constructor() {}

  /**
   * Get the last time we received a speaker callback (regardless of speaking state)
   * Used to verify the page is still responsive before declaring bot removal
   */
  public getLastCallbackTime(): number | null {
    return this.lastCallbackTime
  }

  public static getInstance(): SpeakerManager {
    if (!SpeakerManager.instance) {
      SpeakerManager.instance = new SpeakerManager()
    }
    return SpeakerManager.instance
  }

  public static start(): void {
    const instance = SpeakerManager.getInstance()
    // Initialize diarization tracker (file-based, no API calls)
    instance.diarizationTracker = DiarizationTracker.getInstance()
  }

  /**
   * Finalize diarization tracking when meeting ends.
   */
  public static async finalize(): Promise<void> {
    const instance = SpeakerManager.getInstance()
    if (instance.diarizationTracker) {
      const lastTimestamp = Date.now()
      const meetingStartTime = MeetingStateMachine.instance.getStartTime()
      if (meetingStartTime) {
        // Wait for the stream to fully flush before continuing
        await instance.diarizationTracker.end(lastTimestamp, meetingStartTime)
      }
    }
  }

  public async handleSpeakerUpdate(speakers: SpeakerData[]): Promise<void> {
    try {
      // Update singleton with participants and speakers
      this.updateSingletonParticipants(speakers)

      // Track when we received this callback (for bot removal detection)
      this.lastCallbackTime = Date.now()

      // Send the speaker state to the streaming service only if RECORDING is enabled
      if (Streaming.instance) {
        Streaming.instance.send_speaker_state(speakers)
      }

      await this.logSpeakers(speakers)

      // Count the active speakers
      const speakersCount = this.countActiveSpeakers(speakers)

      // Update the meeting state
      this.updateMeetingState(speakers, speakersCount)

      // Handle the speaker transcription
      await this.handleSpeakersTranscription(speakers, speakersCount)
    } catch (error) {
      console.error("[SpeakerManager] ❌ Error handling speaker update:", error)
      throw error
    }
  }

  /**
   * Handle network speaker updates from network interception.
   * Converts NetworkUser[] to SpeakerData[] and stores metadata in singleton.
   */
  public async handleNetworkSpeakerUpdate(
    networkUsers: NetworkUser[],
    timestamp: number
  ): Promise<void> {
    try {
      // Convert network users to SpeakerData format
      const speakers: SpeakerData[] = networkUsers.map((user) => {
        // Use fullName as stable identifier, fallback to name (displayName)
        const stableName = user.fullName || user.name || "Unknown"
        const stableId = generateStableUserId(stableName, user.profilePicture)
        const sequentialId = this.sequentialIdManager.getSequentialId(stableId)

        // Store participant metadata in singleton
        const participant: Participant = {
          name: stableName, // Full name (stable identifier)
          id: sequentialId,
          displayName: user.displayName !== stableName ? user.displayName : undefined,
          profilePicture: user.profilePicture,
          participantId: user.deviceId, // Network payload ID for debugging
          isNetworkDetected: true
        }

        // Add all participants (whether speaking or not)
        GLOBAL.addParticipantIfNotExists(participant)

        // Add speakers who are currently speaking
        if (user.isSpeaking === true) {
          GLOBAL.addSpeakerIfNotExists(participant)
        }

        // Return SpeakerData for diarization
        return {
          name: stableName,
          id: sequentialId,
          timestamp,
          isSpeaking: user.isSpeaking === true
        }
      })

      // Process as regular speaker update
      await this.handleSpeakerUpdate(speakers)
    } catch (error) {
      console.error("[SpeakerManager] ❌ Error handling network speaker update:", error)
      throw error
    }
  }

  /**
   * Update singleton with participants and speakers information.
   * - All participants (whether speaking or not) are added via addParticipantIfNotExists
   * - Participants who are currently speaking (isSpeaking === true) are also added via addSpeakerIfNotExists
   */
  private updateSingletonParticipants(speakers: SpeakerData[]): void {
    for (const speaker of speakers) {
      // Convert SpeakerData to Participant format
      const participant: Participant = {
        name: speaker.name,
        id: speaker.id || null
      }

      // Add all participants (whether speaking or not)
      GLOBAL.addParticipantIfNotExists(participant)

      // Add speakers who are currently speaking
      if (speaker.isSpeaking === true) {
        GLOBAL.addSpeakerIfNotExists(participant)
      }
    }
  }

  private async logSpeakers(speakers: SpeakerData[]): Promise<void> {
    const input = JSON.stringify(speakers)
    const botName = GLOBAL.get().bot_name
    const maskedSpeakers = speakers.map((speaker, index) => {
      // Check if this speaker's name matches the bot name
      const isPotentialBot =
        botName && speaker.name && speaker.name.toLowerCase() === botName.toLowerCase()
      return {
        ...speaker,
        name: isPotentialBot ? `Speaker ${index + 1} (Bot)` : `Speaker ${index + 1}`
      }
    })
    console.table(maskedSpeakers)
    await fs.promises
      .appendFile(PathManager.getInstance().getSpeakerLogPath(), `${input}\n`)
      .catch((e) => {
        console.error("Cannot append speaker log file:", e)
      })
  }

  private countActiveSpeakers(speakers: SpeakerData[]): number {
    return speakers.reduce((acc, s) => acc + (s.isSpeaking === true ? 1 : 0), 0)
  }

  private updateMeetingState(speakers: SpeakerData[], speakersCount: number): void {
    if (!MeetingStateMachine.instance) {
      return
    }

    if (speakersCount > 0) {
      this.lastSpeakerTime = Date.now()
    } else if (speakers.length === 0) {
      // Only enable page logs when NO participants are found (SpeakerObserver failure)
      enablePrintPageLogs()
    }

    // Track no active speakers time - only set once when silence starts
    let noSpeakerDetectedTime = MeetingStateMachine.instance.getContext().noSpeakerDetectedTime
    if (speakersCount === 0) {
      // Only set the timer if it's not already set (first time silence detected)
      if (!noSpeakerDetectedTime) {
        noSpeakerDetectedTime = Date.now()
      }
      // Otherwise keep the existing value (don't reset the timer)
    } else if (speakersCount > 0) {
      noSpeakerDetectedTime = null
    }
    // If speakersCount is neither 0 nor > 0 (impossible), keep existing value

    const participantState: ParticipantState = {
      attendeesCount: speakers.length,
      firstUserJoined: speakers.length > 0,
      lastSpeakerTime: this.lastSpeakerTime,
      noSpeakerDetectedTime
    }

    MeetingStateMachine.instance.updateParticipantState(participantState)
  }

  private async handleSpeakersTranscription(
    speakers: SpeakerData[],
    speakersCount: number
  ): Promise<void> {
    switch (speakersCount) {
      case 0:
        await this.handleNoSpeakers(speakers)
        break
      case 1:
        await this.handleSingleSpeaker(speakers)
        break
      default:
        await this.handleMultipleSpeakers(speakers)
        break
    }
  }

  private async handleNoSpeakers(speakers: SpeakerData[]): Promise<void> {
    if (this.currentSpeaker) {
      this.currentSpeaker.isSpeaking = false
      if (speakers.length > 0) {
        this.currentSpeaker.timestamp = speakers[0].timestamp
      }
    }
  }

  private async handleSingleSpeaker(speakers: SpeakerData[]): Promise<void> {
    const activeSpeaker = speakers.find((v) => v.isSpeaking === true)
    if (!activeSpeaker) return

    const meetingStartTime = MeetingStateMachine.instance.getStartTime()
    if (!meetingStartTime) return

    if (activeSpeaker.name !== this.currentSpeaker?.name) {
      // Speaker changed - update diarization tracker (writes to file)
      this.diarizationTracker?.updateSpeaker(activeSpeaker, meetingStartTime)
    } else if (this.currentSpeaker.isSpeaking === false) {
      // The speaker has started speaking again after a pause
      if (activeSpeaker.timestamp >= this.currentSpeaker.timestamp + this.PAUSE_BETWEEN_SENTENCES) {
        this.diarizationTracker?.updateSpeaker(activeSpeaker, meetingStartTime)
      }
    }
    this.currentSpeaker = activeSpeaker
  }

  private async handleMultipleSpeakers(speakers: SpeakerData[]): Promise<void> {
    const meetingStartTime = MeetingStateMachine.instance.getStartTime()
    if (!meetingStartTime) return

    const hasSpeakingCurrentSpeaker = speakers.some(
      (speaker) => speaker.name === this.currentSpeaker?.name && speaker.isSpeaking === true
    )

    if (hasSpeakingCurrentSpeaker) {
      const activeSpeaker = speakers.find((speaker) => speaker.name === this.currentSpeaker!.name)
      if (this.currentSpeaker!.isSpeaking === false) {
        if (
          activeSpeaker.timestamp >=
          this.currentSpeaker!.timestamp + this.PAUSE_BETWEEN_SENTENCES
        ) {
          this.diarizationTracker?.updateSpeaker(activeSpeaker, meetingStartTime)
        }
      }
      this.currentSpeaker = activeSpeaker
    } else {
      const activeSpeaker = speakers.find((v) => v.isSpeaking === true)
      this.diarizationTracker?.updateSpeaker(activeSpeaker, meetingStartTime)
      this.currentSpeaker = activeSpeaker
    }
  }
}
