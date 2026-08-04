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
import { PiiRedactor } from "./utils/PiiRedactor"
import { createSequentialIdManager, generateStableUserId } from "./utils/speaker-id"

/** The placeholder every platform's interceptor falls back to before a roster lands. */
const UNKNOWN_SPEAKER = "Unknown"

export class SpeakerManager {
  private static instance: SpeakerManager | null = null
  private currentSpeaker: SpeakerData | null = null
  private readonly PAUSE_BETWEEN_SENTENCES = 1000 // 1 second
  private lastSpeakerTime: number | null = null
  private diarizationTracker: DiarizationTracker | null = null
  private lastCallbackTime: number | null = null // Track when we last received ANY callback
  // Sequential ID manager for network-detected speakers
  private sequentialIdManager = createSequentialIdManager()
  // Best name seen so far per network device. Rosters arrive incrementally and
  // a later payload can omit a name that an earlier one carried; without this,
  // a participant flips back to "Unknown" mid-meeting.
  private deviceNames = new Map<string, string>()

  private constructor() {}

  /**
   * Best available name for a network participant, never downgrading.
   *
   * Teams already repairs this inside its own interceptor (it upgrades an
   * "Unknown" record once a displayName shows up). Meet and Zoom have no such
   * path — Meet's decodeUserName and Zoom's `displayName || "Unknown"` both
   * hand back the placeholder and nothing ever revisits it. Doing it here fixes
   * all three platforms in one place.
   */
  private resolveNetworkName(user: NetworkUser): string {
    const deviceId = user.deviceId
    const incoming = (user.fullName || user.name || "").trim()

    if (incoming && incoming !== UNKNOWN_SPEAKER) {
      if (deviceId) {
        const previous = this.deviceNames.get(deviceId)
        this.deviceNames.set(deviceId, incoming)
        // First time this device got a real name. If speech already opened a
        // segment under the placeholder, repair it in place rather than leaving
        // the opening of the meeting mislabelled.
        if (previous === undefined) {
          const renamed = this.diarizationTracker?.renameOpenSegment(
            UNKNOWN_SPEAKER,
            incoming,
            this.sequentialIdManager.getSequentialId(
              generateStableUserId(incoming, user.profilePicture)
            )
          )
          if (renamed) {
            console.log(
              `[SpeakerManager] Roster resolved late — backfilled the open segment to the correct speaker`
            )
          }
        }
      }
      return incoming
    }

    const remembered = deviceId ? this.deviceNames.get(deviceId) : undefined
    return remembered ?? UNKNOWN_SPEAKER
  }

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
        const stableName = this.resolveNetworkName(user)
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

        // Return SpeakerData for diarization.
        //
        // Audio can beat the roster: the first CSRC often resolves to a device
        // whose name has not been decoded yet. NEVER drop that speech — an
        // earlier version withheld the speaking flag until the name resolved,
        // which silently deleted the opening seconds of the meeting from the
        // artifact (preprod bot 99517dc3: first segment at 10.0s, so everything
        // before it had no segment and rendered as "Unknown" downstream).
        //
        // Emit the segment immediately under whatever name we have, and let
        // resolveNetworkName() backfill the real name into the still-open
        // segment once the roster lands. Speech is never lost; at worst a
        // segment is briefly labelled "Unknown" in memory before being renamed.
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
    // Register every observed speaker name so the PII redactor can map it
    // to a stable placeholder in all log files, then redact the raw JSON
    // before it hits speaker_separation.log (uploaded to S3).
    for (const speaker of speakers) {
      if (speaker.name) {
        PiiRedactor.registerSpeaker(speaker.name)
      }
    }
    const input = PiiRedactor.redact(JSON.stringify(speakers))
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

    const ignoredNames = GLOBAL.get().ignored_participant_names ?? []
    const filteredSpeakersLength =
      ignoredNames.length > 0
        ? speakers.filter(
            (s) => !ignoredNames.some((n) => n.toLowerCase() === s.name.toLowerCase())
          ).length
        : speakers.length

    const participantState: ParticipantState = {
      attendeesCount: filteredSpeakersLength,
      firstUserJoined: filteredSpeakersLength > 0,
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
