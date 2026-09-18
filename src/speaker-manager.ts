import * as fs from "node:fs"
import { enablePrintPageLogs } from "./browser/page-logger"
import { type DiarizationSegment, DiarizationTracker } from "./diarization-tracker"
import type { NetworkUser } from "./meeting/meet/network-interception/types"
import { GLOBAL } from "./singleton"
import { MeetingStateMachine } from "./state-machine/machine"
import type { ParticipantState } from "./state-machine/types"
import { Streaming } from "./streaming"
import { SpeakerAttributionShadowTracker } from "./speaker-attribution-shadow"
import { type Participant, type SpeakerData, UNKNOWN_SPEAKER } from "./types"
import { PathManager } from "./utils/PathManager"
import { PiiRedactor } from "./utils/PiiRedactor"
import { isBotName, silenceBotSpeaker } from "./utils/speaker-attribution"
import { createSequentialIdManager, generateStableUserId } from "./utils/speaker-id"
import { chooseLiveFillName, pickFreshUiSpeakerName } from "./utils/ui-name-fill"

export class SpeakerManager {
  private static instance: SpeakerManager | null = null
  private currentSpeaker: SpeakerData | null = null
  private currentSource: "ui" | "network" | null = null
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
  // Stable source id -> resolved name. Different unresolved devices never
  // share an id; learning one name cannot relabel another source.
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
  // Roster key of the last UI observation forwarded to attribution. The
  // observer heartbeats an unchanged DOM every few seconds to keep the
  // buffer fresh; attribution, streaming and logs only need changes.
  // null = nothing forwarded since the last ownership change; an empty roster
  // keys to "" and must still be forwarded (it is the first silence state).
  private lastForwardedUiKey: string | null = null
  // Canonical self identity, learned from the platform's own self marker (the
  // "(You)" row carries both the DISPLAYED name and the device id). An SSO
  // bot displays the login account's name, not bot_name, so this is the only
  // identity that catches it on every path — the network path has no isSelf.
  private selfDisplayedName?: string
  private selfDeviceId?: string
  // Latest fresh UI evidence naming the single person on the floor. The UI
  // observer keeps running while muted (shadow-only), so this keeps tracking
  // even after the network path takes attribution. Used to fill Unknown network
  // speakers live instead of waiting for the finalize-time backfill.
  private lastFreshUiName: { name: string; at: number } | null = null
  // Count of live name fills, logged (count only — names are PII) at finalize.
  private liveNameFills = 0
  // Diagnostic-only arbitration evidence. Never changes speaker ownership.
  private readonly attributionShadow = new SpeakerAttributionShadowTracker()

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
    const lastTimestamp = Date.now()
    try {
      if (instance.diarizationTracker) {
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
            (userId) => instance.userIdNames.get(userId),
            // Fresh single-speaker UI observations fill unresolved network intervals.
            [
              {
                kind: "ui",
                segments: instance.buildUiFallbackSegments(meetingStartTime, lastTimestamp)
              }
            ],
            (GLOBAL.get().streaming_input
              ? []
              : [GLOBAL.get().bot_name, instance.selfDisplayedName]
            ).filter((n): n is string => Boolean(n)),
            GLOBAL.get().streaming_input ? undefined : instance.selfDeviceId
          )
        }
      }
    } finally {
      if (instance.liveNameFills > 0) {
        console.log(`[SpeakerManager] Live name-fills applied this call: ${instance.liveNameFills}`)
      }
      instance.observeAttributionShadow(() => instance.attributionShadow.finalize(lastTimestamp))
      instance.warnUnresolvedUnknownIdentities()
    }
  }

  private warnUnresolvedUnknownIdentities(): void {
    const unknownSpeakers = GLOBAL.getSpeakers().filter(
      (speaker) => speaker.name === UNKNOWN_SPEAKER
    ).length
    const unknownParticipants = GLOBAL.getParticipants().filter(
      (participant) => participant.name === UNKNOWN_SPEAKER
    ).length
    if (unknownSpeakers === 0 && unknownParticipants === 0) {
      return
    }
    console.warn(
      `[SpeakerAlert] unresolved_unknown speakers=${unknownSpeakers} participants=${unknownParticipants}`
    )
  }

  /** Shadow telemetry must never change recording or finalization behavior. */
  private observeAttributionShadow(observe: () => void): void {
    try {
      observe()
    } catch {
      console.error("[SPEAKER-SHADOW] telemetry_error")
    }
  }

  /** Final name + stable id for a device, or undefined if it never resolved. */
  private resolveDeviceForBackfill(deviceId: string): { name: string; userId: number } | undefined {
    const name = this.deviceNames.get(deviceId)
    if (!name || name === UNKNOWN_SPEAKER) {
      return undefined
    }
    return {
      name,
      userId: this.idForDevice(name, this.deviceProfilePictures.get(deviceId), deviceId)
    }
  }

  /** Sequential id for a resolved participant, matching the live path exactly. */
  private idForDevice(name: string, profilePicture: string | undefined, deviceId?: string): number {
    return this.sequentialIdManager.getSequentialId(
      deviceId ? `device:${deviceId}` : generateStableUserId(name, profilePicture)
    )
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
    this.learnSelfIdentity(observed)
    // Recorded before the mute check below: the bridge keeps running while
    // muted (shadow-only), and its fresh name evidence is what lets the network
    // path stream a real name for speakers whose device never resolved.
    this.rememberFreshUiName(observed)
    const timestamps = observed
      .map((speaker) => speaker.timestamp)
      .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0)
    this.observeAttributionShadow(() =>
      this.attributionShadow.observeUi(
        observed,
        timestamps.length > 0 ? Math.max(...timestamps) : Date.now()
      )
    )

    await this.logShadowSpeakers(observed)

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
      // Shadow-log instead of discarding: the DOM observer runs all call and
      // is a per-call cross-check of the network path (a prod collapse where
      // the UI had the right answer was only diagnosable from video frames).
      // Attribution unchanged; lines go to speaker_separation.log redacted.
      this.lastForwardedUiKey = null
      return
    }

    // A heartbeat re-emits the unchanged roster: it refreshed the buffer above
    // and must not re-send speaker state to streaming clients, re-log the
    // roster, or reopen an identical segment. It still counts as liveness.
    const forwardedKey = observed
      .map((s) => `${s.deviceId ?? s.name}:${s.name}:${s.isSpeaking ? 1 : 0}`)
      .sort()
      .join("|")
    if (forwardedKey === this.lastForwardedUiKey) {
      this.lastCallbackTime = Date.now()
      return
    }
    this.lastForwardedUiKey = forwardedKey

    await this.handleSpeakerUpdate(
      observed.map((speaker) => ({
        ...speaker,
        id: this.resolveUiUserId(speaker.name, speaker.deviceId)
      })),
      "ui-observer"
    )
  }

  /** Prefer the platform identity; a display name is not a unique device key. */
  private resolveUiUserId(name: string, deviceId?: string): number {
    if (deviceId) return this.idForDevice(name, undefined, deviceId)
    return this.sequentialIdManager.getSequentialId(`ui:${name}`)
  }

  /** Remember the bot's displayed name + device once the self marker shows it. */
  private learnSelfIdentity(observed: SpeakerData[]): void {
    for (const speaker of observed) {
      if (speaker.isSelf === true) {
        if (speaker.name && !this.selfDisplayedName) {
          this.selfDisplayedName = speaker.name
          console.log("[SpeakerManager] Self identity learned from the platform's self marker")
        }
        if (speaker.deviceId && !this.selfDeviceId) this.selfDeviceId = speaker.deviceId
      }
    }
  }

  /**
   * Track the single named person the UI observer currently sees speaking.
   *
   * Only unambiguous evidence is recorded (exactly one active non-self speaker,
   * and it must be named), which is what makes the live fill safe: with one
   * candidate there is nothing to pick between. The observers emit full
   * speaker-state snapshots, so an ambiguous or silent snapshot clears earlier
   * evidence immediately instead of letting it age out.
   */
  private rememberFreshUiName(observed: SpeakerData[]): void {
    const params = GLOBAL.get()
    const name = pickFreshUiSpeakerName({
      observed,
      excludedNames: [params.bot_name, this.selfDisplayedName].filter((n): n is string =>
        Boolean(n)
      )
    })
    this.lastFreshUiName = name ? { name, at: Date.now() } : null
  }

  /**
   * Silence the bot under its LEARNED identity (displayed name / own device),
   * which silenceBotSpeaker's bot_name matching cannot catch for SSO logins.
   * The network path never carries isSelf, so this is the only guard there.
   */
  /** Whether an observation matches the LEARNED self identity. */
  private isLearnedSelf(name: string | undefined, deviceId: string | undefined): boolean {
    return Boolean(
      (this.selfDeviceId && deviceId === this.selfDeviceId) ||
        (this.selfDisplayedName && name === this.selfDisplayedName)
    )
  }

  private silenceSelf(speakers: SpeakerData[], botCanSpeak: boolean): SpeakerData[] {
    if (botCanSpeak || (!this.selfDisplayedName && !this.selfDeviceId)) return speakers
    return speakers.map((speaker) =>
      speaker.isSpeaking && this.isLearnedSelf(speaker.name, speaker.deviceId)
        ? { ...speaker, isSpeaking: false }
        : speaker
    )
  }

  public async handleSpeakerUpdate(observed: SpeakerData[], source: string): Promise<void> {
    try {
      // Which source drives every committed speaker update: network CSRC,
      // network dcrpc (NetEq), roster, or the UI-observer bridge. This is the
      // only node-side signal of source — the browser-side interceptor logs do
      // not reach the bot log. Count only; names/ids are PII and this ships to S3.
      const speakingNow = observed.filter((s) => s.isSpeaking).length
      console.log(`[SPEAKER-SRC] source=${source} speaking=${speakingNow}/${observed.length}`)
      // A recording bot stays in the roster but can never hold the floor — see
      // silenceBotSpeaker for what happens to a meeting when it does. A bot that
      // streams audio in does speak, and keeps its turns.
      const params = GLOBAL.get()
      const botCanSpeak = Boolean(params.streaming_input)
      const speakers = this.silenceSelf(
        silenceBotSpeaker(observed, params.bot_name, botCanSpeak),
        botCanSpeak
      )

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
      await this.handleSpeakersTranscription(
        speakers,
        speakersCount,
        source === "ui-observer" ? "ui" : "network"
      )
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
    source = "network"
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

      // Resolve the best-known names first (resolveNetworkName also remembers
      // device -> name), then fill a still-unresolved speaking speaker from
      // fresh UI evidence. Filling is deliberately narrow: the update must hold
      // EXACTLY ONE speaking network speaker, and that speaker must be the
      // unresolved one (a resolved speaker active next to it must never lend it
      // a name), with fresh unambiguous UI evidence (see rememberFreshUiName).
      // Turn boundaries stay network-owned; only the name is filled, and never
      // over a resolved network name.
      const resolvedNames = networkUsers.map((user) => this.resolveNetworkName(user))
      const networkSpeakingCount = networkUsers.filter((user) => user.isSpeaking === true).length
      const unresolvedSpeakingCount = networkUsers.filter(
        (user, index) => user.isSpeaking === true && resolvedNames[index] === UNKNOWN_SPEAKER
      ).length
      const fillName = chooseLiveFillName({
        networkSpeakingCount,
        unresolvedSpeakingCount,
        evidence: this.lastFreshUiName,
        now: Date.now()
      })

      // Convert network users to SpeakerData format
      const speakers: SpeakerData[] = networkUsers.map((user, index) => {
        // Name can resolve late; the device identity stays stable.
        let stableName = resolvedNames[index]
        if (fillName && user.isSpeaking === true && stableName === UNKNOWN_SPEAKER) {
          stableName = fillName
          // Remember the device under the filled name: resolveNetworkName reads this map,
          // so later callbacks keep the identity instead of flipping back to Unknown
          // mid-turn, and the finalize backfill reproduces the same id for this device.
          if (user.deviceId) {
            this.deviceNames.set(user.deviceId, fillName)
            this.deviceProfilePictures.set(user.deviceId, user.profilePicture)
          }
          if (this.liveNameFills === 0) {
            console.log(
              "[SpeakerManager] Live name-fill: unresolved network speaker named from fresh UI evidence"
            )
          }
          this.liveNameFills++
        }
        const sequentialId = this.idForDevice(stableName, user.profilePicture, user.deviceId)

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
        // The learned identity (displayed name / own device from the "(You)"
        // marker) catches the SSO case bot_name matching cannot — this registry
        // is append-only, so the decision has to be right here.
        const isSpeaking =
          user.isSpeaking === true &&
          (botCanSpeak ||
            (!isBotName(stableName, botName) && !this.isLearnedSelf(stableName, user.deviceId)))

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

      this.observeAttributionShadow(() =>
        this.attributionShadow.observeNetwork(speakers, timestamp, source)
      )

      // First actual speaker from the network path mutes the UI bridge — from
      // here the track-based signal is live and authoritative.
      if (!this.networkSpeakerActive && speakers.some((s) => s.isSpeaking)) {
        this.networkSpeakerActive = true
        // Ownership changed hands: whatever UI roster was forwarded last must
        // be forwarded again if the fallback ever hands the floor back, even
        // when no UI callback entered the muted branch in between.
        this.lastForwardedUiKey = null
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

  // Speaking-set key of the last shadow line, so identical consecutive
  // observations are written once (the observer can re-emit on unrelated DOM
  // churn; only changes are informative).
  private lastShadowKey = ""
  // UI observations on both primary and shadow paths; unchanged fresh
  // observations advance lastSeen without consuming another buffer slot.
  // Sized from prod: Meet's indicator can flicker ~6 observations/s (a 67-min
  // UI-fallback call produced 24k), so 20k truncated inside the hour.
  private static readonly SHADOW_BUFFER_MAX = 100000
  private shadowObservations: Array<{
    t: number
    lastSeen: number
    speakers: Array<{ name: string; deviceId?: string; isSpeaking: boolean }>
  }> = []
  // True once the buffer refused an observation; the fallback timeline must
  // then end at the last retained one, not attribute the unobserved tail.
  private shadowBufferTruncated = false
  // A single observation cannot vouch for an unbounded stretch: the observer
  // can stall. Meet/Teams refresh from DOM at least every 10 seconds.
  private static readonly SHADOW_OPEN_MAX_MS = 15_000

  /**
   * Conservative timeline from UI observations: only stretches with
   * EXACTLY ONE participant speaking are emitted — ambiguity is dropped.
   */
  public buildUiFallbackSegments(
    meetingStartTime: number,
    lastTimestamp: number
  ): DiarizationSegment[] {
    const segments: DiarizationSegment[] = []
    for (let i = 0; i < this.shadowObservations.length; i++) {
      const observation = this.shadowObservations[i]
      // Count unnamed active participants too: named + Unknown is ambiguous.
      const speaking = observation.speakers.filter((s) => s.isSpeaking)
      if (speaking.length !== 1) continue
      const observed = speaking[0]
      const resolvedName = observed.deviceId ? this.deviceNames.get(observed.deviceId) : undefined
      const speaker = {
        ...observed,
        name:
          !observed.name || observed.name === UNKNOWN_SPEAKER
            ? (resolvedName ?? UNKNOWN_SPEAKER)
            : observed.name
      }
      if (!speaker.name || speaker.name === UNKNOWN_SPEAKER) continue
      const start = Math.max(0, (observation.t - meetingStartTime) / 1000)
      const next =
        this.shadowObservations[i + 1]?.t ??
        (this.shadowBufferTruncated ? observation.lastSeen : lastTimestamp)
      const end = Math.max(
        0,
        (Math.min(next, lastTimestamp, observation.lastSeen + SpeakerManager.SHADOW_OPEN_MAX_MS) -
          meetingStartTime) /
          1000
      )
      if (end > start)
        segments.push({
          speaker: speaker.name,
          user_id: this.resolveUiUserId(speaker.name, speaker.deviceId),
          start_time: start,
          end_time: end
        })
    }
    return segments
  }

  /** Buffer fresh UI evidence on both the primary and shadow paths. */
  private async logShadowSpeakers(speakers: SpeakerData[]): Promise<void> {
    try {
      const params = GLOBAL.get()
      const botCanSpeak = Boolean(params.streaming_input)
      const silenced = this.silenceSelf(
        silenceBotSpeaker(speakers, params.bot_name, botCanSpeak),
        botCanSpeak
      )
      const timestamps = speakers.map((s) => s.timestamp).filter((t) => Number.isFinite(t) && t > 0)
      const previous = this.shadowObservations[this.shadowObservations.length - 1]
      // Page observations carry the page clock minus the platform latency; an
      // empty roster carries no timestamp and is stamped here, later. Keep the
      // buffer ordered by clamping, never by dropping: the first real
      // observation after an empty frame is the one that opens a speaker.
      const observedAt = timestamps.length > 0 ? Math.max(...timestamps) : Date.now()
      const t = previous ? Math.max(observedAt, previous.lastSeen) : observedAt
      const key = silenced
        .map((s) => `${s.deviceId ?? s.name}:${s.name}:${s.isSpeaking ? 1 : 0}`)
        .sort()
        .join("|")
      // A repeated observation refreshes the state only while it is contiguous.
      // A stalled observer must leave a hole for network attribution.
      if (
        !this.shadowBufferTruncated &&
        previous &&
        key === this.lastShadowKey &&
        t - previous.lastSeen <= SpeakerManager.SHADOW_OPEN_MAX_MS
      ) {
        previous.lastSeen = t
        return
      }
      this.lastShadowKey = key
      if (this.shadowObservations.length < SpeakerManager.SHADOW_BUFFER_MAX) {
        this.shadowObservations.push({
          t,
          lastSeen: t,
          speakers: silenced.map((s) => ({
            name: s.name,
            deviceId: s.deviceId,
            isSpeaking: s.isSpeaking === true
          }))
        })
      } else if (!this.shadowBufferTruncated) {
        this.shadowBufferTruncated = true
        console.warn(
          "[SpeakerBridge] UI buffer full — attribution ends at the last fresh observation"
        )
      }
      for (const speaker of speakers) {
        if (speaker.name) PiiRedactor.registerSpeaker(speaker.name)
      }
      await fs.promises.appendFile(
        PathManager.getInstance().getSpeakerLogPath(),
        `${PiiRedactor.redact(JSON.stringify({ src: "ui-shadow", t, speakers }))}\n`
      )
    } catch (e) {
      console.error("Cannot append ui-shadow speaker log:", e)
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
    speakersCount: number,
    source: "ui" | "network"
  ): Promise<void> {
    if (source !== this.currentSource) this.currentSpeaker = null
    this.currentSource = source
    switch (speakersCount) {
      case 0:
        await this.handleNoSpeakers(speakers)
        break
      case 1:
        await this.handleSingleSpeaker(speakers, source)
        break
      default:
        await this.handleMultipleSpeakers(speakers, source)
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

  private async handleSingleSpeaker(
    speakers: SpeakerData[],
    source: "ui" | "network"
  ): Promise<void> {
    const activeSpeaker = speakers.find((v) => v.isSpeaking === true)
    if (!activeSpeaker) return

    const meetingStartTime = MeetingStateMachine.instance.getStartTime()
    if (!meetingStartTime) return

    if (
      activeSpeaker.id !== this.currentSpeaker?.id ||
      activeSpeaker.name !== this.currentSpeaker?.name
    ) {
      // Speaker changed - update diarization tracker (writes to file)
      this.diarizationTracker?.updateSpeaker(activeSpeaker, meetingStartTime, source)
    } else if (this.currentSpeaker.isSpeaking === false) {
      // The speaker has started speaking again after a pause
      if (activeSpeaker.timestamp >= this.currentSpeaker.timestamp + this.PAUSE_BETWEEN_SENTENCES) {
        this.diarizationTracker?.updateSpeaker(activeSpeaker, meetingStartTime, source)
      }
    }
    this.currentSpeaker = activeSpeaker
  }

  private async handleMultipleSpeakers(
    speakers: SpeakerData[],
    source: "ui" | "network"
  ): Promise<void> {
    const meetingStartTime = MeetingStateMachine.instance.getStartTime()
    if (!meetingStartTime) return

    const hasSpeakingCurrentSpeaker = speakers.some(
      (speaker) =>
        speaker.id === this.currentSpeaker?.id &&
        speaker.name === this.currentSpeaker?.name &&
        speaker.isSpeaking === true
    )

    if (hasSpeakingCurrentSpeaker) {
      const activeSpeaker = speakers.find(
        (speaker) =>
          speaker.id === this.currentSpeaker!.id && speaker.name === this.currentSpeaker!.name
      )
      if (this.currentSpeaker!.isSpeaking === false) {
        if (
          activeSpeaker.timestamp >=
          this.currentSpeaker!.timestamp + this.PAUSE_BETWEEN_SENTENCES
        ) {
          this.diarizationTracker?.updateSpeaker(activeSpeaker, meetingStartTime, source)
        }
      }
      this.currentSpeaker = activeSpeaker
    } else {
      const activeSpeaker = speakers.find((v) => v.isSpeaking === true)
      this.diarizationTracker?.updateSpeaker(activeSpeaker, meetingStartTime, source)
      this.currentSpeaker = activeSpeaker
    }
  }
}
