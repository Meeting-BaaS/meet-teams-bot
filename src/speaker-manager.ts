import * as fs from "node:fs"
import { enablePrintPageLogs } from "./browser/page-logger"
import { DiarizationTracker } from "./diarization-tracker"
import type { NetworkUser } from "./meeting/meet/network-interception/types"
import { GLOBAL } from "./singleton"
import { MeetingStateMachine } from "./state-machine/machine"
import type { ParticipantState } from "./state-machine/types"
import { Streaming } from "./streaming"
import { type Participant, type SpeakerData, UNKNOWN_SPEAKER } from "./types"
import { PathManager } from "./utils/PathManager"
import { PiiRedactor } from "./utils/PiiRedactor"
import { isBotName, silenceBotSpeaker } from "./utils/speaker-attribution"
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
  // Best name seen so far per network device. Rosters arrive incrementally and
  // a later payload can omit a name that an earlier one carried; without this,
  // a participant flips back to "Unknown" mid-meeting.
  private deviceNames = new Map<string, string>()
  // Stable sequential user id -> resolved name. Populated live whenever a
  // speaker resolves to a real name. The device-keyed backfill misses speakers
  // whose deviceId churns (CSRC/SSRC active-speaker switching: each swap is a
  // new bare-numeric deviceId the roster never maps), but their user id stays
  // stable — so this lets finalize repair them by user id instead of device.
  private userIdNames = new Map<number, string>()
  // Profile picture per device, so a backfilled segment gets the same stable id
  // the live path would have produced for that participant.
  private deviceProfilePictures = new Map<string, string | undefined>()
  // True once the network path has reported an actual SPEAKING participant.
  // Until then the UI bridge (see handleUiBridgeUpdate) is allowed to feed the
  // diarization, because a participant's audio track only starts flowing a few
  // seconds after they first speak — Meet's UI indicator fires much earlier.
  private networkSpeakerActive = false
  private uiBridgeMuteLogged = false

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
        this.deviceNames.set(deviceId, incoming)
        this.deviceProfilePictures.set(deviceId, user.profilePicture)
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
        // Hand over the FINAL roster so any segment written while a participant
        // was still unnamed gets repaired before the artifact is uploaded. The
        // live path can only ever fix the segment that is still open; by the end
        // of the meeting we know every name we are ever going to know.
        await instance.diarizationTracker.end(
          lastTimestamp,
          meetingStartTime,
          (deviceId) => instance.resolveDeviceForBackfill(deviceId),
          (userId) => instance.userIdNames.get(userId)
        )
      }
    }
  }

  /** Final name + stable id for a device, or undefined if it never resolved. */
  private resolveDeviceForBackfill(
    deviceId: string
  ): { name: string; userId: number } | undefined {
    const name = this.deviceNames.get(deviceId)
    if (!name || name === UNKNOWN_SPEAKER) {
      return undefined
    }
    return {
      name,
      userId: this.idForDevice(name, this.deviceProfilePictures.get(deviceId))
    }
  }

  /** Sequential id for a resolved participant, matching the live path exactly. */
  private idForDevice(name: string, profilePicture: string | undefined): number {
    return this.sequentialIdManager.getSequentialId(generateStableUserId(name, profilePicture))
  }

  /**
   * Entry point for the Meet UI speaker bridge: the DOM speaking indicator
   * observed in parallel with the (primary) network path.
   *
   * Why it exists: at first speech after silence, a participant's WebRTC audio
   * track takes 3-5s to spin up before the network path can see them — Meet's
   * own UI indicator lights up almost immediately. Measured in prod (2026-08-10,
   * 27/47 Meet transcripts): every leading-"Unknown" run ended exactly in that
   * gap, median 5.3s before the first network segment.
   *
   * Arbitration: UI events flow only while the network path has never reported
   * a speaking participant. From the first network speaker on, the bridge is
   * muted — the network path carries deviceIds (enabling finalize-time repair)
   * and survives DOM changes, so it stays authoritative. If the stale-diarization
   * monitor later retires the network path, the fallback flags unmute the bridge
   * automatically and the same observer becomes the primary source.
   */
  public async handleUiBridgeUpdate(observed: SpeakerData[]): Promise<void> {
    const networkRetired =
      GLOBAL.hasNetworkInterceptionSetupFailed() || GLOBAL.hasDiarizationFallbackTriggered()

    // A re-arm mutes the bridge on its own. Re-arms follow a never-produced
    // fallback, so the network path has never reported a speaker and
    // networkSpeakerActive is still false — gating on that alone would leave the
    // observer live alongside the just-restored network path, both committing
    // speaker boundaries until the first network speaker finally lands.
    const networkOwnsFloor = this.networkSpeakerActive || GLOBAL.hasRearmedNetworkDiarization()

    if (networkOwnsFloor && !networkRetired) {
      if (!this.uiBridgeMuteLogged) {
        this.uiBridgeMuteLogged = true
        console.log("[SpeakerBridge] Network path owns attribution — UI bridge muted")
      }
      return
    }

    await this.handleSpeakerUpdate(
      observed.map((speaker) => ({ ...speaker, id: this.resolveUiUserId(speaker.name) })),
      "ui-observer"
    )
  }

  /**
   * Reuse the id the network path already gave this name.
   *
   * The observers emit id 0 — they run in the page with no access to the
   * sequential id manager. That was harmless while retirement was permanent, but
   * the path can now be re-armed, so one person would land as user_id 2, then 0,
   * then 2 again across a single meeting and read downstream as two speakers.
   *
   * Falls back to 0 when the network never named them, so a meeting that only
   * ever used the observer keeps exactly the ids it has today.
   */
  private resolveUiUserId(name: string): number {
    if (!name || name === UNKNOWN_SPEAKER) return 0
    for (const [id, known] of this.userIdNames) {
      if (id !== 0 && known === name) return id
    }
    return 0
  }

  public async handleSpeakerUpdate(
    observed: SpeakerData[],
    source: string
  ): Promise<void> {
    try {
      // Which source drives every committed speaker update: network CSRC,
      // network dcrpc (NetEq), roster, or the UI-observer bridge. This is the
      // only node-side signal of source — the browser-side interceptor logs do
      // not reach the bot log. Count only; names/ids are PII and this ships to S3.
      const speakingNow = observed.filter((s) => s.isSpeaking).length
      console.log(
        `[SPEAKER-SRC] source=${source} speaking=${speakingNow}/${observed.length}`
      )
      // A recording bot stays in the roster but can never hold the floor — see
      // silenceBotSpeaker for what happens to a meeting when it does. A bot that
      // streams audio in does speak, and keeps its turns.
      const params = GLOBAL.get()
      const speakers = silenceBotSpeaker(observed, params.bot_name, Boolean(params.streaming_input))

      // Remember every user id we ever resolved to a real name, so finalize can
      // repair Unknown segments by user id when the device-keyed repair can't
      // (churning SSRC deviceId). Never store the placeholder.
      for (const speaker of speakers) {
        if (speaker.id != null && speaker.name && speaker.name !== UNKNOWN_SPEAKER) {
          this.userIdNames.set(speaker.id, speaker.name)
        }
      }

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
    timestamp: number,
    source: string = "network"
  ): Promise<void> {
    // Once the fallback has retired the network path, the UI observer is the
    // primary source. Stopping the page-side interceptor is best-effort, so a
    // straggler callback can still land here — processing it would have two
    // sources writing speaker boundaries at once.
    if (GLOBAL.hasDiarizationFallbackTriggered()) {
      return
    }

    try {
      const params = GLOBAL.get()
      const botName = params.bot_name
      const botCanSpeak = Boolean(params.streaming_input)

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

        // A recording bot is never a speaker, and that has to be decided here
        // rather than downstream: the global speaker registry is append-only, so
        // a bot added once stays in the final payload no matter what the
        // diarization path does with it afterwards. A bot streaming audio in is
        // a real speaker and passes through untouched.
        const isSpeaking =
          user.isSpeaking === true && (botCanSpeak || !isBotName(stableName, botName))

        // Add speakers who are currently speaking
        if (isSpeaking) {
          GLOBAL.addSpeakerIfNotExists(participant)
        }

        // Return SpeakerData for diarization.
        //
        // Audio can beat the roster: the first CSRC often resolves to a device
        // whose name has not been decoded yet. NEVER drop that speech — an
        // earlier version withheld the speaking flag until the name resolved,
        // which silently deleted the opening seconds of the meeting from the
        // artifact: the first segment landed ten seconds in, and everything
        // before it rendered as "Unknown" downstream.
        //
        // Emit the segment immediately under whatever name we have. deviceId is
        // what makes the repair possible: at finalize every segment still marked
        // "Unknown" is matched back to its participant by device and relabelled,
        // including the ones already flushed to disk.
        return {
          name: stableName,
          id: sequentialId,
          timestamp,
          deviceId: user.deviceId,
          isSpeaking
        }
      })

      // First actual speaker from the network path mutes the UI bridge — from
      // here the track-based signal is live and authoritative.
      if (!this.networkSpeakerActive && speakers.some((s) => s.isSpeaking)) {
        this.networkSpeakerActive = true
        console.log("[SpeakerBridge] First speaking participant on the network path")
      }

      // Process as regular speaker update
      await this.handleSpeakerUpdate(speakers, source)
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
      // deviceId exists to match segments back to participants at finalize; it
      // is noise in the console table and belongs to no column a reader wants.
      const { deviceId: _deviceId, ...rest } = speaker
      return {
        ...rest,
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
