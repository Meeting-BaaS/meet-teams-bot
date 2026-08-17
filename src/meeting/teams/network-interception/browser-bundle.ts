// Browser-side bundle for Teams network speaker detection. Stringified and
// injected via addInitScript, so it must be self-contained (only window.pako +
// browser APIs). Three signals:
//   1. Roster:      window.WebSocket "3:::" rosterUpdate frames (base64 + zlib).
//   2. Dominant:    "main-channel" data channel dsh messages → speaking stream.
//   3. Per-speaker: getContributingSources() (CSRC) resolved via msteamscalling.
// Emits via window.onNetworkSpeakerUpdate() — same bridge/sink as Meet.

/** biome-ignore-all lint/suspicious/noExplicitAny: browser-side bundle over untyped Teams/WebRTC internals. */

// Type-only: erased, so the stringified bundle stays self-contained.
import type { SpeakerSetResolver, SpeakerTimelineRung } from "./speaker-timeline"

/** @param resolveSpeakingSet - Passed in, not imported: this is stringified into the page. */
export function teamsBrowserInterceptionLogic(resolveSpeakingSet: SpeakerSetResolver) {
  try {
    if ((window as any).__teamsNetworkInterceptorInitialized === true) {
      console.warn("[Teams NetworkInterceptor] ⚠️ Already initialized, skipping duplicate")
      return
    }
    ;(window as any).__teamsNetworkInterceptorInitialized = true
    ;(window as any).__teamsNetworkInterceptorStopped = false

    // "[NetworkInterceptor]" prefix so page-logger surfaces warn/error by
    // default (no LOG_LEVEL=debug needed); "[Teams]" distinguishes from Meet.
    const LOG = "[NetworkInterceptor][Teams]"
    const DEBUG = false
    const debug = (...args: any[]) => {
      if (DEBUG) console.log(LOG, ...args)
    }

    if (!(window as any).pako) {
      console.error(`${LOG} ❌ pako not loaded, cannot decode roster frames`)
    }

    // ===== STATE =====

    // deviceId (roster details.id) → participant record
    const participantsByDeviceId = new Map<string, any>()
    // Speaker updates reach Node by being pushed onto this queue, which Node drains
    // via page.evaluate (the interceptor's context cannot see exposeFunction bindings
    // under CloakBrowser).
    ;(window as any).__teamsSpeakerQueue = (window as any).__teamsSpeakerQueue || []
    // virtual stream id (string) → { participantId, displayName, type, isAudio, isActive }
    const virtualStreams = new Map<string, any>()
    // current dominant speaker's audio virtual stream id (from "dsh")
    let dominantSpeakerStreamId: string | null = null
    // when true, CSRC is authoritative; when false, fall back to dsh
    let csrcAvailable = false
    // CSRC becomes authoritative only after a source maps to a participant.
    let hasObservedCsrcMapping = false
    // CSRC per-speaker detection is DISABLED in CloakBrowser: getContributingSources()
    // never populates audioLevel (diag lvl was 0 all meeting), so a "recent contributing
    // source" is indistinguishable from silence and the first speaker latches for the whole
    // call. Force the dsh dominant-speaker path (which changes correctly) — the behaviour
    // that worked on feat/teams-network-speaker-separation+efs-fix. Flip true if audioLevel lands.
    const CSRC_ENABLED = false

    // ===== CAPTION-BASED DIARIZATION =====
    // When a Teams session is server-mixed audio, it emits neither per-speaker
    // CSRC nor "dsh" dominant-speaker events — the bot then has no active-speaker
    // signal and the transcript comes back with generic "Speaker N" labels.
    // Teams live captions DO carry a per-utterance speaker id + timing regardless
    // of audio topology, so we start captions via the internal call SDK and derive
    // an active-speaker timeline from the caption stream.
    // Captions are the SECOND rung: dsh/CSRC first, captions only when a session
    // turns out to have no native active-speaker signal (the server-mixed-audio
    // case). They are not started on healthy calls — live captions are visible to
    // participants, so we raise them only for sessions that would otherwise get
    // no speaker names at all. When they do run, the caption UI is hidden from
    // the recording by the Teams cleanup stylesheet (htmlCleaner.ts).
    //
    // Kept short deliberately: the UI rung below this one is armed by the stale
    // detector once sound arrives with no segments, so captions have to be up and
    // producing before that fires or the chain would skip straight to the UI.
    const CAPTION_ENABLE_DELAY_MS = 5000
    // A caption keeps its speaker "active" at least this long (covers the gap
    // between partial caption updates for one utterance).
    const CAPTION_SPEAKING_WINDOW_MS = 2500
    // A dsh event older than this is no longer a live active-speaker signal. The
    // affected sessions emit dsh 0-1 times total, so "dshSeen === 0" is the wrong
    // test — a single stale event must not lock captions out for the whole call.
    const DSH_FRESH_MS = 20000
    // deviceId identity key → timestamp (ms) until which that participant counts
    // as speaking, derived from caption results.
    const captionSpeakingUntil = new Map<string, number>()
    // identity key → that speaker's recent speech intervals on the AUDIO clock,
    // built from timestampAudioSent + duration. Attribution asks "who was
    // speaking at time T" against these rather than "who has a live wall-clock
    // window": a caption arrives 1-3s after the speech it describes, so a
    // wall-clock window keeps the previous speaker active into the next
    // speaker's turn and reports sequential speech as concurrent.
    // Teams streams an utterance as repeated partials then one final, all
    // describing the SAME speech, so partials extend the open interval instead
    // of opening new ones.
    const captionIntervals = new Map<
      string,
      { startMs: number; endMs: number; open: boolean }[]
    >()
    // Intervals older than this are dropped; only recent speech can be current.
    const CAPTION_INTERVAL_RETENTION_MS = 60000
    // Wall-clock arrival of the last caption result. The audio clock cannot tell
    // us speech STOPPED — only that captions went quiet — so silence is still
    // detected on the wall clock, then stamped back onto the audio clock.
    let lastCaptionResultAt = 0
    const CAPTION_SILENCE_MS = 2500
    // Identity of the most recent caption result. A roster update mid-speech
    // broadcasts with a wall-clock stamp, and the audio intervals all sit in the
    // past (captions lag), so an overlap lookup at "now" would find nobody and
    // cut the current speaker's segment short. While captions are still flowing,
    // non-caption updates hold the last caption speaker instead.
    let lastCaptionIdentity: string | null = null
    // Audio-clock start and end of the most recent caption utterance, used to
    // stamp the broadcast (see broadcastSpeakerUpdate) so the segment lands where
    // the speech actually happened rather than where the caption arrived. The end
    // closes the segment: without it the close sits at wall-clock time and every
    // caption segment is inflated by the caption delivery delay plus the speaking
    // window, instead of measuring the utterance.
    let lastCaptionAudioStartMs = 0
    let lastCaptionAudioEndMs = 0
    // True only once caption results are actually arriving — NOT when activation
    // was merely requested. Teams can accept startClosedCaption() (or the click)
    // and still never mount the renderer, so latching on the request would leave
    // the fallback silently dead for the rest of the meeting.
    let captionsEnabled = false
    // Activation is retried until captions flow or the attempt cap is reached.
    let captionAttempts = 0
    let lastCaptionAttemptAt = 0
    const CAPTION_RETRY_MS = 10000
    const CAPTION_MAX_ATTEMPTS = 6
    let interceptorStartedAt = Date.now()
    // When the last dsh event arrived (0 = never). Freshness, not the raw count,
    // decides whether a native active-speaker signal exists.
    let lastDshAt = 0

    // AAD identity key for a roster/caption id: collapse the same account across
    // endpoints via its org id; guests/anon keep their raw id (never merged).
    // Shared by the roster dedupe and the caption→participant match.
    // Caption speaker ids are not guaranteed to carry the "8:orgid:" prefix that
    // roster deviceIds do, so fall back to a bare AAD GUID anywhere in the string
    // — otherwise a caption id and its roster entry never key the same.
    function identityKey(deviceId: string): string {
      if (typeof deviceId !== "string") return String(deviceId)
      const orgid = deviceId.match(/8:orgid:([0-9a-fA-F-]{36})/)
      if (orgid) return `orgid:${orgid[1].toLowerCase()}`
      const guid =
        deviceId.match(
          /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
        ) || null
      return guid ? `orgid:${deviceId.toLowerCase()}` : deviceId
    }

    // receiver → isActive
    const receiverMap = new Map<RTCRtpReceiver, boolean>()
    // participantId → ParticipantSpeakingStateMachine
    const speakingStateMachines = new Map<string, any>()
    // last logged speaking set, to log only on change
    let lastSpeakingLogKey = ""
    // Floors the caption stamp on hybrid sessions.
    let lastBroadcastStamp = 0
    // Log the rung only on change.
    let lastRung: SpeakerTimelineRung | "" = ""
    // Lean, non-PII pipeline counters. The browser console is filtered in prod, so
    // Node reads these via page.evaluate to see which stage stops producing.
    ;(window as any).__teamsNetDiag = (window as any).__teamsNetDiag || {
      wsCreated: 0,
      wsRosterFrames: 0,
      httpRosterHits: 0,
      rtcCreated: 0,
      dataChannels: 0,
      dshSeen: 0,
      receiversAdded: 0,
      broadcasts: 0,
      rosterParticipants: 0,
      csrcAvailable: false,
      queueLen: 0,
      // Caption rung. matched + unmatched are counted once per caption result, so
      // they sum to captionResults and read directly as a roster match rate — a
      // run that stays entirely unmatched means the speaker ids are not resolving.
      captionResults: 0,
      captionMatched: 0,
      captionUnmatched: 0,
      captionsEnabled: false,
      // Caption interval overruling a live dsh — 0 on single-signal sessions.
      rungCaptionOverDsh: 0
    }
    const diag = (window as any).__teamsNetDiag

    // ===== TEAMS INTERNAL CALLING SDK (best-effort) =====

    function getActiveCall(): any {
      try {
        const observable = (window as any).callingDebug?.observableCall
        if (observable) return observable
        const calling = (window as any).msteamscalling?.deref?.()
        const call = calling?.callingService?.getActiveCall?.()
        if (call) return call
      } catch {
        // Teams internals not available — fall back to dominant-speaker path.
      }
      return null
    }

    function getCurrentUserId(): string | undefined {
      const call = getActiveCall()
      return call?.callerMri
    }

    // Map CSRC sources → speaking participant ids via participant.hasAudioSource().
    function getSpeakingParticipantIds(contributingSources: any[]): Set<string> {
      const speaking = new Set<string>()
      const call = getActiveCall()
      if (!call?.participants) return speaking
      call.participants.forEach((participant: any) => {
        if (!participant?.id) return
        const matches = contributingSources.some((cs) => {
          try {
            return participant.hasAudioSource(cs.source)
          } catch {
            return false
          }
        })
        if (matches) speaking.add(participant.id)
      })
      return speaking
    }

    // ===== ROSTER (WebSocket) =====

    function decodeWebSocketBody(encodedData: string): any {
      const byteArray = Uint8Array.from(atob(encodedData), (c) => c.charCodeAt(0))
      return JSON.parse((window as any).pako.inflate(byteArray, { to: "string" }))
    }

    function syncVirtualStreamsFromParticipant(participant: any): void {
      const participantId = participant?.details?.id
      if (!participantId) return

      if (participant.state === "inactive") {
        for (const [streamId, vs] of virtualStreams) {
          if (vs.participantId === participantId) virtualStreams.delete(streamId)
        }
        return
      }

      const mediaStreams: any[] = []
      if (participant.endpoints) {
        for (const endpoint of Object.values<any>(participant.endpoints)) {
          if (endpoint?.call && Array.isArray(endpoint.call.mediaStreams)) {
            mediaStreams.push(...endpoint.call.mediaStreams)
          }
        }
      }

      for (const mediaStream of mediaStreams) {
        if (mediaStream?.sourceId == null) continue
        const isActive =
          mediaStream.direction === "sendrecv" || mediaStream.direction === "sendonly"
        virtualStreams.set(mediaStream.sourceId.toString(), {
          sourceId: mediaStream.sourceId.toString(),
          participantId,
          displayName: participant.details?.displayName,
          type: mediaStream.type,
          isAudio: mediaStream.type === "audio",
          isActive
        })
      }
    }

    // Pull a display name / stable id across BOTH the WebSocket roster shape
    // (participant.details.{displayName,id}) and the HTTP snapshot shapes, which nest
    // the identity differently.
    function rosterName(pp: any): string | undefined {
      return (
        pp?.details?.displayName ||
        pp?.displayName ||
        pp?.identity?.displayName ||
        pp?.user?.displayName ||
        pp?.participant?.displayName
      )
    }
    function rosterId(pp: any): string | undefined {
      return (
        pp?.details?.id ||
        pp?.id ||
        pp?.mri ||
        pp?.participantId ||
        pp?.endpointId ||
        pp?.identity?.id
      )
    }

    // Shared by the WebSocket delta path AND the HTTP snapshot path.
    function applyParticipants(rawParticipants: any[]): void {
      const participants = rawParticipants.filter((pp) => rosterName(pp))
      const currentUserId = getCurrentUserId()
      let changed = false
      for (const participant of participants) {
        const deviceId = rosterId(participant)
        if (!deviceId) continue
        const record = {
          deviceId,
          displayName: rosterName(participant),
          status: participant.state === "active" ? 1 : 6,
          isHost: participant.meetingRole === "organizer",
          isCurrentUser: !!currentUserId && deviceId === currentUserId
        }
        const previous = participantsByDeviceId.get(deviceId)
        if (!previous || JSON.stringify(previous) !== JSON.stringify(record)) changed = true
        // Anchor the caption-fallback grace period to the first real roster (i.e.
        // actually in the call), not to script injection which runs pre-navigation.
        if (participantsByDeviceId.size === 0) interceptorStartedAt = Date.now()
        participantsByDeviceId.set(deviceId, record)
        syncVirtualStreamsFromParticipant(participant)
      }
      if (changed) broadcastSpeakerUpdate("roster")
    }

    function handleRosterUpdate(eventDataObject: any): void {
      try {
        const decodedBody = decodeWebSocketBody(eventDataObject.body)
        const rawParticipants = Object.values<any>(decodedBody.participants || {})
        applyParticipants(rawParticipants)
      } catch (error) {
        console.error(`${LOG} ❌ Error handling roster update:`, error)
      }
    }

    // ===== ROSTER (HTTP snapshot) =====
    // The trouter WebSocket only delivers roster DELTAS to this late-connecting client
    // (see the "trouter.message_loss" frames). Anyone already in the meeting when the
    // bot joins is recovered by the client via an HTTP snapshot, NOT the socket — so
    // intercept those responses and merge them into the same participant map.
    // Teams roster maps are objects keyed by MRI (e.g. { "8:orgid:...": {...} }),
    // NOT arrays. Convert to an array and inject the MRI key as an id fallback.
    function participantsToArray(pm: any): any[] | null {
      if (!pm) return null
      if (Array.isArray(pm)) return pm
      if (typeof pm === "object") {
        return Object.entries(pm as Record<string, any>).map(([mri, pv]) =>
          pv && typeof pv === "object" ? { mri, ...pv } : pv
        )
      }
      return null
    }

    function tryHttpRoster(url: string, text: string): void {
      try {
        if (!text || text.indexOf("displayName") === -1) return
        const body = JSON.parse(text)
        // The HTTP snapshot nests the roster as { roster: { participants: {mri: {...}} } };
        // other endpoints use top-level participants / value. Handle all as object-or-array.
        const raw =
          participantsToArray(body?.roster?.participants) ||
          participantsToArray(body?.participants) ||
          participantsToArray(body?.value) ||
          participantsToArray(body?.participants?.value) ||
          (Array.isArray(body) ? body : null)
        if (raw && raw.length) {
          diag.httpRosterHits++
          applyParticipants(raw)
        }
      } catch {
        // not JSON — ignore
      }
    }

    // ===== DOMINANT SPEAKER (main-channel data channel) =====

    function setDominantSpeakerStreamId(streamId: number | string): void {
      dominantSpeakerStreamId = streamId.toString()
    }

    function getDominantSpeakerParticipantId(): string | null {
      if (!dominantSpeakerStreamId) return null
      return virtualStreams.get(dominantSpeakerStreamId)?.participantId ?? null
    }

    // main-channel payloads are binary with embedded JSON; parse from the first
    // '[' (91) or '{' (123) byte.
    function decodeMainChannelData(data: any): any {
      if (typeof data === "string") {
        try {
          return JSON.parse(data)
        } catch {
          return undefined
        }
      }
      const decoded = new Uint8Array(data)
      for (let i = 0; i < decoded.length; i++) {
        if (decoded[i] === 91 || decoded[i] === 123) {
          const candidate = new TextDecoder().decode(decoded.slice(i))
          try {
            return JSON.parse(candidate)
          } catch (e) {
            if (e instanceof SyntaxError) continue
            return undefined
          }
        }
      }
      return undefined
    }

    function handleMainChannelEvent(event: any): void {
      try {
        const parsed = decodeMainChannelData(event.data)
        if (!parsed) return
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item?.type === "dsh") {
              diag.dshSeen++
              // Counted even when disabled so the diag line still shows whether the
              // session emits dsh at all — that is the mixed-audio discriminator.
              lastDshAt = Date.now()
              const newDominantStreamId = item.history?.[0]
              if (newDominantStreamId != null) {
                setDominantSpeakerStreamId(newDominantStreamId)
                debug("🗣️ dsh dominant stream", newDominantStreamId)
                // only emit here when CSRC isn't the authoritative source
                if (!csrcAvailable) broadcastSpeakerUpdate("audio")
              }
            }
          }
        }
        // Caption frames may ride the same channel as an object, or nested one
        // level under an envelope — search rather than assume the top-level shape.
        {
          const results = findRecognitionResults(parsed)
          if (results) {
            for (const r of results) handleCaptionResult(r)
          }
        }
      } catch (error) {
        console.error(`${LOG} ❌ Error handling main-channel event:`, error)
      }
    }

    // Teams reports caption audio timing as 100-ns ticks since the NTP epoch
    // (1900-01-01), not the Unix epoch — 2_208_988_800 seconds apart. Returns 0
    // when the field is absent or implausible so callers fall back to arrival time.
    function captionAudioStartMs(timestampAudioSent: any): number {
      if (typeof timestampAudioSent !== "number" || !isFinite(timestampAudioSent)) return 0
      if (timestampAudioSent <= 0) return 0
      const secondsSince1900 = timestampAudioSent / 1e7
      const unixMs = Math.floor((secondsSince1900 - 2208988800) * 1000)
      // Guard against a different encoding than assumed: anything not within a
      // day of now is not this meeting's audio clock.
      if (Math.abs(unixMs - Date.now()) > 86400000) return 0
      return unixMs
    }

    // Locate a caption result array in a decoded main-channel payload, whether it
    // sits at the top level or one level down under an envelope key.
    function findRecognitionResults(parsed: any): any[] | null {
      if (!parsed || typeof parsed !== "object") return null
      const direct = (parsed as any).recognitionResults
      if (Array.isArray(direct)) return direct
      for (const value of Array.isArray(parsed) ? parsed : Object.values(parsed)) {
        if (value && typeof value === "object") {
          const nested = (value as any).recognitionResults
          if (Array.isArray(nested)) return nested
        }
      }
      return null
    }

    // A caption result marks its speaker active for the utterance it belongs to.
    // Field names are confirmed against a live Teams call — a caption result
    // carries: userId, displayName, text, duration, isFinal, timestampAudioSent,
    // confidence, spokenLanguage. `duration` is in 100-ns ticks.
    //
    // userId is matched to the roster by AAD identity key; displayName is the
    // fallback for the case where that id does not resolve (guest/federated
    // identities whose caption id differs from their roster deviceId).
    function handleCaptionResult(r: any): void {
      try {
        const speakerRaw = r?.userId
        if (speakerRaw == null) return
        diag.captionResults++
        // A caption result is the only proof captions are really running, so this
        // is where activation is confirmed and the retry gate stands down.
        if (!captionsEnabled) {
          captionsEnabled = true
          diag.captionsEnabled = true
        }
        const durTicks = typeof r?.duration === "number" ? r.duration : 0
        const durMs = durTicks > 0 ? Math.min(durTicks / 1e4, 8000) : 0
        const windowMs = Math.max(durMs, CAPTION_SPEAKING_WINDOW_MS)
        const key = identityKey(String(speakerRaw))

        // Counted per result so matched + unmatched sum to captionResults and read
        // as a roster match rate. A caption can legitimately arrive before the
        // roster lists its speaker, so early unmatched results are expected — a
        // run that stays entirely unmatched is the real failure signal.
        // Resolved BEFORE the interval is recorded, so the interval is filed
        // under the identity attribution will actually look it up by.
        let resolved = key
        if (rosterHasIdentity(key)) {
          diag.captionMatched++
        } else {
          // The id did not resolve. Teams also puts the speaker's display name on
          // the caption result, so fall back to the roster entry with that name
          // rather than dropping the utterance.
          const byName = rosterKeyForDisplayName(r?.displayName)
          if (byName) {
            resolved = byName
            diag.captionMatched++
          } else {
            diag.captionUnmatched++
          }
        }

        lastCaptionResultAt = Date.now()
        lastCaptionIdentity = resolved

        // Record where the speech actually sat on the audio clock. Captions
        // arrive 1-3s after the speech, so both the segment boundary and the
        // attribution come from timestampAudioSent rather than arrival time.
        const audioStartMs = captionAudioStartMs(r?.timestampAudioSent)
        if (audioStartMs > 0) {
          const endMs = audioStartMs + durMs
          upsertCaptionInterval(resolved, audioStartMs, endMs, r?.isFinal === true)
          lastCaptionAudioStartMs = audioStartMs
          lastCaptionAudioEndMs = Math.max(lastCaptionAudioEndMs, endMs)
        } else {
          // No usable audio timing on this result — keep the old wall-clock
          // window so attribution degrades rather than disappearing.
          captionSpeakingUntil.set(resolved, Date.now() + windowMs)
        }
        // Every result, not only when dsh is dead — resolveSpeakingSet arbitrates.
        if (!csrcAvailable) {
          broadcastSpeakerUpdate("caption")
        }
      } catch {
        // ignore a malformed caption result
      }
    }

    // A dsh event only counts as a live active-speaker signal while it is fresh.
    // The affected sessions emit dsh once or not at all; without this the single
    // stale event pins one speaker for the rest of the call and blocks captions.
    function hasFreshDominantSpeaker(): boolean {
      if (lastDshAt === 0) return false
      if (Date.now() - lastDshAt > DSH_FRESH_MS) return false
      return getDominantSpeakerParticipantId() != null
    }

    // Roster deviceIds whose identity currently has an unexpired caption window.
    // Fold a caption result into the speaker's open interval, or open a new one.
    function upsertCaptionInterval(
      key: string,
      startMs: number,
      endMs: number,
      isFinal: boolean
    ): void {
      let list = captionIntervals.get(key)
      if (!list) {
        list = []
        captionIntervals.set(key, list)
      }
      const last = list.length > 0 ? list[list.length - 1] : undefined
      if (last && last.open) {
        last.startMs = Math.min(last.startMs, startMs)
        last.endMs = Math.max(last.endMs, endMs)
        if (isFinal) last.open = false
      } else {
        list.push({ startMs, endMs, open: !isFinal })
      }
      const cutoff = endMs - CAPTION_INTERVAL_RETENTION_MS
      for (const [k, l] of captionIntervals) {
        const kept = l.filter((iv) => iv.endMs >= cutoff)
        if (kept.length === 0) captionIntervals.delete(k)
        else captionIntervals.set(k, kept)
      }
    }

    // Which identity was speaking at this point on the audio clock. End is
    // exclusive so the utterance that just ended does not bleed into the update
    // that closes it. On genuine overlap the earliest start wins — one speaker
    // per instant keeps the diarization timeline unambiguous.
    function captionIdentityAt(tMs: number): string | null {
      let bestKey: string | null = null
      let bestStart = Number.POSITIVE_INFINITY
      for (const [key, list] of captionIntervals) {
        for (const iv of list) {
          if (iv.startMs <= tMs && tMs < iv.endMs && iv.startMs < bestStart) {
            bestStart = iv.startMs
            bestKey = key
          }
        }
      }
      return bestKey
    }

    // Roster deviceIds sharing any of these caption identity keys.
    function deviceIdsForIdentityKeys(activeKeys: Set<string>): Set<string> {
      const out = new Set<string>()
      if (activeKeys.size === 0) return out
      for (const p of participantsByDeviceId.values()) {
        if (activeKeys.has(identityKey(p.deviceId))) out.add(p.deviceId)
      }
      return out
    }

    // deviceIds whose caption interval CONTAINS tMs — no hold or window mixed in.
    function captionDeviceIdsAtAudioTime(tMs: number): Set<string> {
      const key = captionIdentityAt(tMs)
      return deviceIdsForIdentityKeys(key ? new Set([key]) : new Set<string>())
    }

    // Roster deviceIds speaking at tMs. Caption results that carried no usable
    // audio timing fall back to the wall-clock window, so a client that omits
    // timestampAudioSent still attributes rather than going silent.
    function getCaptionSpeakingDeviceIds(tMs: number, audioClock: boolean): Set<string> {
      const activeKeys = new Set<string>()
      if (audioClock) {
        const byAudio = captionIdentityAt(tMs)
        if (byAudio) activeKeys.add(byAudio)
      } else if (
        lastCaptionIdentity &&
        lastCaptionResultAt > 0 &&
        Date.now() - lastCaptionResultAt < CAPTION_SILENCE_MS
      ) {
        // Not a caption-driven update: captions are still flowing, so hold the
        // current speaker rather than reading silence off a stale audio clock.
        activeKeys.add(lastCaptionIdentity)
      }
      const now = Date.now()
      for (const [key, until] of captionSpeakingUntil) {
        if (until > now) activeKeys.add(key)
        else captionSpeakingUntil.delete(key)
      }
      return deviceIdsForIdentityKeys(activeKeys)
    }

    // Does any roster participant share this caption identity key? Used to count
    // the caption→roster match per result rather than per broadcast.
    function rosterHasIdentity(key: string): boolean {
      for (const p of participantsByDeviceId.values()) {
        if (identityKey(p.deviceId) === key) return true
      }
      return false
    }

    // Identity key of the roster participant with this display name, when the
    // caption's userId did not resolve. Exact match only, and refused when the
    // name is ambiguous across participants — attributing speech to the wrong
    // person is worse than leaving the utterance unattributed.
    function rosterKeyForDisplayName(displayName: any): string | null {
      if (typeof displayName !== "string" || displayName.trim() === "") return null
      const wanted = displayName.trim().toLowerCase()
      let found: string | null = null
      for (const p of participantsByDeviceId.values()) {
        if (typeof p.displayName !== "string") continue
        if (p.displayName.trim().toLowerCase() !== wanted) continue
        if (found) return null
        found = identityKey(p.deviceId)
      }
      return found
    }

    // Start Teams live captions via the internal call SDK so the caption stream
    // (and thus the speaker timeline) exists. Best-effort + idempotent; degrades
    // to no-op when the internals are unavailable.
    function enableClosedCaptions(): void {
      if (captionsEnabled) return
      const call = getActiveCall()
      if (!call || typeof call.startClosedCaption !== "function") {
        // Internals absent on this client build — fall back to the UI control.
        enableClosedCaptionsViaDom()
        return
      }
      try {
        // Deliberately NOT calling setClosedCaptionsLanguage. Forcing a language
        // overrides the tenant's own default, and on a non-English tenant that
        // suppresses the signal we came for: a Japanese meeting captioned as
        // en-us returns few or no results, and captions may not start at all.
        // Leaving it unset keeps whatever the meeting is already configured for.
        // (Attribution reads userId and timestampAudioSent, never caption text,
        // so recognition quality does not affect speaker names — only whether
        // results arrive.)
        const result = call.startClosedCaption()
        captionAttempts++
        lastCaptionAttemptAt = Date.now()
        debug("📝 live captions requested (diarization fallback)")
        if (result && typeof result.catch === "function") {
          // A rejection means this attempt failed outright; the gate retries.
          result.catch(() => {
            debug("caption start rejected")
          })
        }
      } catch (error) {
        debug("caption enable failed", error)
      }
    }

    // Last resort when the internal call SDK has no startClosedCaption on this
    // client build: click the caption control itself. The button is only present
    // once the meeting UI has rendered, so this is retried by the caption gate.
    function enableClosedCaptionsViaDom(): void {
      try {
        const button =
          document.querySelector("#closed-captions-button") ||
          document.querySelector('[data-tid="closed-captions-button"]') ||
          document.querySelector('[data-tid="call-captions-button"]')
        if (!(button instanceof HTMLElement)) return
        button.click()
        captionAttempts++
        lastCaptionAttemptAt = Date.now()
      } catch {
        // control not clickable — leave captions off rather than break the call
      }
    }

    // After a grace period, if no dsh has arrived and CSRC isn't authoritative,
    // this session has no native active-speaker signal — start captions as the
    // fallback. Captions are visible to participants, so only enable when needed.
    {
      const captionGateTimer = setInterval(() => {
        if ((window as any).__teamsNetworkInterceptorStopped) {
          clearInterval(captionGateTimer)
          return
        }
        // Stop only once captions are actually FLOWING. Teams can accept the
        // request or the click and still never mount the renderer, so treating
        // "we asked" as success would disable the fallback for the whole meeting.
        if (captionsEnabled) {
          clearInterval(captionGateTimer)
          return
        }
        if (captionAttempts >= CAPTION_MAX_ATTEMPTS) {
          clearInterval(captionGateTimer)
          debug("caption activation gave up after", captionAttempts, "attempts")
          return
        }
        const inCallLongEnough = Date.now() - interceptorStartedAt >= CAPTION_ENABLE_DELAY_MS
        const retryDue = Date.now() - lastCaptionAttemptAt >= CAPTION_RETRY_MS
        // Freshness, not "dshSeen === 0": the affected sessions emit dsh 0-1 times,
        // so a raw-count test leaves every dsh=1 session — half the reported
        // signature — without the fallback it exists for.
        const noNativeSignal = !hasFreshDominantSpeaker() && !csrcAvailable
        const haveRoster = participantsByDeviceId.size > 0
        if (inCallLongEnough && retryDue && noNativeSignal && haveRoster) {
          enableClosedCaptions()
        }
      }, 5000)

      // Captions arrive in bursts; when the last window lapses nothing else would
      // emit the speaking→silent transition, so the final caption speaker would
      // stay marked active until the next one arrives. Re-broadcast on expiry.
      let hadCaptionSpeakers = false
      const captionExpiryTimer = setInterval(() => {
        if ((window as any).__teamsNetworkInterceptorStopped) {
          clearInterval(captionExpiryTimer)
          return
        }
        if (csrcAvailable || hasFreshDominantSpeaker()) return
        // Speech having stopped can only be seen on the wall clock: the audio
        // clock says nothing once captions go quiet. So the TRIGGER is "no
        // caption result for CAPTION_SILENCE_MS", while the resulting update is
        // stamped back onto the audio clock at the last utterance's end.
        const sawCaptions = lastCaptionResultAt > 0
        const goneQuiet = sawCaptions && Date.now() - lastCaptionResultAt >= CAPTION_SILENCE_MS
        if (hadCaptionSpeakers && goneQuiet) {
          // captionExpiry: sits on the audio end and must not fall through to a
          // stale dsh speaker.
          broadcastSpeakerUpdate("caption", true)
          hadCaptionSpeakers = false
          return
        }
        if (sawCaptions && !goneQuiet) hadCaptionSpeakers = true
      }, 1000)
    }

    // ===== PER-PARTICIPANT SPEAKING STATE (CSRC polling) =====

    // Smooths 100ms samples: SPEAKING when a majority of the last 5 are active.
    // addSample returns true on a state transition.
    class ParticipantSpeakingStateMachine {
      participantId: string
      state: "SPEAKING" | "NOT_SPEAKING" = "NOT_SPEAKING"
      samples: { isSpeaking: boolean; timestamp: number }[] = []

      constructor(participantId: string) {
        this.participantId = participantId
      }

      addSample(sample: { isSpeaking: boolean; timestamp: number }): boolean {
        this.samples.push(sample)
        if (this.samples.length > 10) this.samples.shift()

        const lastFive = this.samples.slice(-5)
        if (lastFive.length < 5) return false

        const majoritySpeaking = lastFive.filter((s) => s.isSpeaking).length > 3
        const previousState = this.state
        this.state = majoritySpeaking ? "SPEAKING" : "NOT_SPEAKING"
        return previousState !== this.state
      }
    }

    function getCsrcSpeakingIds(): Set<string> {
      const speaking = new Set<string>()
      for (const [participantId, machine] of speakingStateMachines) {
        if (machine.state === "SPEAKING") speaking.add(participantId)
      }
      return speaking
    }

    function addReceiver(receiver: RTCRtpReceiver | undefined): void {
      if (!receiver || receiverMap.has(receiver)) return
      receiverMap.set(receiver, false)
      diag.receiversAdded++
      debug("➕ audio receiver added")
    }

    function pollReceivers(): void {
      if ((window as any).__teamsNetworkInterceptorStopped) return

      const speakingParticipantIds = new Set<string>()
      let mappedCsrcThisPoll = false
      const now = Date.now()

      for (const [receiver, isActive] of receiverMap) {
        let contributingSources: any[] = []
        try {
          contributingSources = receiver.getContributingSources() || []
        } catch {
          contributingSources = []
        }

        if (contributingSources.length > 0 && !isActive) receiverMap.set(receiver, true)
        if (receiver.track?.readyState === "ended") {
          receiverMap.set(receiver, false)
          continue
        }

        const recent = contributingSources.filter((cs) => now - cs.timestamp <= 50)
        const mappedIds = getSpeakingParticipantIds(recent)
        if (mappedIds.size > 0) mappedCsrcThisPoll = true
        for (const id of mappedIds) speakingParticipantIds.add(id)
      }

      // Do not let merely seeing Teams SDK participants disable the working
      // dsh path. CSRC is trusted only after a real source→participant mapping.
      if (mappedCsrcThisPoll) hasObservedCsrcMapping = true
      const hasActiveReceiver = Array.from(receiverMap.values()).some(Boolean)
      if (!hasActiveReceiver) hasObservedCsrcMapping = false
      csrcAvailable = CSRC_ENABLED && hasObservedCsrcMapping

      // Ensure a state machine exists for every participant we've seen speaking.
      for (const participantId of speakingParticipantIds) {
        if (!speakingStateMachines.has(participantId)) {
          speakingStateMachines.set(
            participantId,
            new ParticipantSpeakingStateMachine(participantId)
          )
        }
      }

      let changed = false
      for (const [participantId, machine] of speakingStateMachines) {
        const transitioned = machine.addSample({
          isSpeaking: speakingParticipantIds.has(participantId),
          timestamp: now
        })
        if (transitioned) changed = true
      }

      if (csrcAvailable && changed) broadcastSpeakerUpdate("audio")

      diag.rosterParticipants = participantsByDeviceId.size
      diag.csrcAvailable = csrcAvailable
      diag.queueLen = ((window as any).__teamsSpeakerQueue || []).length
    }

    // ===== BROADCAST TO NODE =====

    // A caption update opens its segment at the utterance's audio start; the
    // expiry update closes it at the utterance's audio END. Closing on the wall
    // clock instead would stretch every segment by the caption delivery delay
    // plus CAPTION_SPEAKING_WINDOW_MS. Never stamp into the future, and fall back
    // to now when the caption carried no usable timing.
    function computeBroadcastStamp(source: string, captionExpiry: boolean): number {
      const now = Date.now()
      if (source !== "caption") return now
      const audioStamp = captionExpiry ? lastCaptionAudioEndMs : lastCaptionAudioStartMs
      if (audioStamp <= 0) return now
      const stamp = Math.min(audioStamp, now)
      // Hybrid only: a backdated caption would close the dsh segment before it
      // opened and the tracker drops that as zero-length.
      if (stamp < lastBroadcastStamp && hasFreshDominantSpeaker()) {
        return Math.min(lastBroadcastStamp, now)
      }
      return stamp
    }

    // Rung labels only — no PII, this log ships to S3.
    function logRungChange(rung: SpeakerTimelineRung): void {
      if (rung === "caption-interval") diag.rungCaptionOverDsh++
      if (rung === lastRung) return
      lastRung = rung
      debug("🎚️ speaker evidence rung →", rung)
    }

    // captionExpiry marks the update that ENDS a caption utterance. Two things
    // differ for it: it sits on the wall clock rather than the caption audio
    // clock (backdating it to the utterance's own start would close the segment
    // at or before it began), and it must not fall through to the sticky dsh
    // speaker — the whole point of the update is to emit silence, and a single
    // old dsh event would otherwise keep that speaker active indefinitely.
    function broadcastSpeakerUpdate(
      source: "roster" | "audio" | "caption",
      captionExpiry = false
    ): void {
      if ((window as any).__teamsNetworkInterceptorStopped) return

      // The stamp is computed FIRST because caption attribution is a function of
      // it: the speaking set is "who was talking at this instant on the audio
      // clock", not "who has a live window right now".
      const stamp = computeBroadcastStamp(source, captionExpiry)

      // One timeline: sources are evidence, ranked — none suppresses another.
      const dominantFresh = hasFreshDominantSpeaker()
      const decision = resolveSpeakingSet({
        csrcAvailable,
        csrcSpeaking: csrcAvailable ? Array.from(getCsrcSpeakingIds()) : [],
        // Only scanned where the rung can fire.
        captionAtInstant:
          !csrcAvailable && dominantFresh ? Array.from(captionDeviceIdsAtAudioTime(stamp)) : [],
        captionWindowed:
          !csrcAvailable && !dominantFresh
            ? Array.from(getCaptionSpeakingDeviceIds(stamp, source === "caption"))
            : [],
        dominant: getDominantSpeakerParticipantId(),
        dominantFresh,
        captionsEnabled,
        captionExpiry
      })
      logRungChange(decision.rung)
      const speaking = new Set(decision.deviceIds)

      const rawUsers = Array.from(participantsByDeviceId.values()).map((p) => ({
        deviceId: p.deviceId,
        name: p.displayName || "Unknown",
        isCurrentUser: p.isCurrentUser === true,
        isSpeaking: speaking.has(p.deviceId),
        status: p.status,
        isHost: p.isHost === true,
        audioLevel: 0,
        fullName: p.displayName,
        displayName: p.displayName,
        profilePicture: undefined
      }))

      // Dedupe by AAD identity. The same account can appear under more than one roster
      // entry — the bot showed up under both its directory name and its in-call name
      // (different endpoint ids), surfacing as a phantom extra speaker. Collapse rows
      // that share an org identity (8:orgid:<oid>); OR their speaking/host/self flags.
      // Guests/anonymous participants have no orgid, so they key on their full id and
      // are NEVER merged — anonymous meetings behave exactly as before.
      const byIdentity = new Map<string, (typeof rawUsers)[number]>()
      for (const u of rawUsers) {
        const key = identityKey(u.deviceId)
        const prev = byIdentity.get(key)
        if (!prev) {
          byIdentity.set(key, u)
        } else {
          prev.isSpeaking = prev.isSpeaking || u.isSpeaking
          prev.isCurrentUser = prev.isCurrentUser || u.isCurrentUser
          prev.isHost = prev.isHost || u.isHost
          if (u.status === 1) prev.status = 1
          if ((prev.name === "Unknown" || !prev.displayName) && u.displayName) {
            prev.name = u.displayName
            prev.displayName = u.displayName
            prev.fullName = u.displayName
          }
        }
      }
      const users = Array.from(byIdentity.values())

      // Only enqueue when the roster or speaking set actually changed — keeps the
      // pipeline (and logs) quiet during steady state.
      const key = users
        .map((u) => `${u.deviceId}:${u.isSpeaking ? 1 : 0}`)
        .sort()
        .join("|")
      if (key === lastSpeakingLogKey) return
      lastSpeakingLogKey = key

      try {
        const q = (window as any).__teamsSpeakerQueue as any[]
        if (q.length > 500) q.splice(0, q.length - 500)
        // Node derives each diarization segment's position from this timestamp,
        // so a caption-driven update carries the audio-clock start of the
        // utterance instead of arrival time — otherwise every caption segment
        // sits 1-3s late, which is the whole point of reading timestampAudioSent.
        // Never stamp ahead of now: a clock skew would put speech in the future.
        q.push({ users, timestamp: stamp, source })
        // Only once the update is really on its way to Node.
        lastBroadcastStamp = Math.max(lastBroadcastStamp, stamp)
        diag.broadcasts++
      } catch {
        // ignore
      }
    }

    // ===== INTERCEPTORS =====

    // WebSocket proxy — Teams signaling rides text frames prefixed "3:::".
    {
      const OriginalWebSocket = (window as any).WebSocket
      const ProxiedWebSocket = function (this: any, url: string, protocols?: any) {
        const ws = new OriginalWebSocket(url, protocols)
        diag.wsCreated++
        ws.addEventListener("message", (event: any) => {
          try {
            const data = event.data
            if (typeof data !== "string" || !data.startsWith("3:::")) return
            const eventDataObject = JSON.parse(data.slice(4))
            const eventUrl = eventDataObject?.url
            if (typeof eventUrl !== "string") return
            // Match any roster-bearing signaling URL (initial snapshot + deltas).
            if (eventUrl.toLowerCase().includes("roster")) {
              diag.wsRosterFrames++
              handleRosterUpdate(eventDataObject)
            }
          } catch {
            // Non-JSON / non-signaling frame — ignore.
          }
        })
        return ws
      } as any
      ProxiedWebSocket.prototype = OriginalWebSocket.prototype
      ProxiedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING
      ProxiedWebSocket.OPEN = OriginalWebSocket.OPEN
      ProxiedWebSocket.CLOSING = OriginalWebSocket.CLOSING
      ProxiedWebSocket.CLOSED = OriginalWebSocket.CLOSED
      ;(window as any).WebSocket = ProxiedWebSocket
    }

    // HTTP roster interceptor (fetch + XHR). Feeds tryHttpRoster so the full roster
    // (participants already present before the bot joined) is recovered from the
    // client's HTTP snapshot, not just the socket deltas. Wrap-and-forward only — the
    // original response is returned untouched; we read a clone.
    {
      const rosterUrlRe = /callagent|conversation|roster|participant|calling|skype|flightproxy|\/csa\/|\/api\//i
      try {
        const origFetch = (window.fetch as any).bind(window)
        ;(window as any).fetch = function (...args: any[]) {
          const promise = origFetch(...args)
          try {
            const req = args[0]
            const url = typeof req === "string" ? req : req?.url
            if (url && rosterUrlRe.test(url)) {
              promise
                .then((resp: any) => {
                  try {
                    resp
                      .clone()
                      .text()
                      .then((t: string) => tryHttpRoster(url, t))
                      .catch(() => {})
                  } catch {}
                  return resp
                })
                .catch(() => {})
            }
          } catch {}
          return promise
        }
      } catch {
        // ignore
      }
      try {
        const origOpen = XMLHttpRequest.prototype.open
        const origSend = XMLHttpRequest.prototype.send
        XMLHttpRequest.prototype.open = function (
          this: any,
          method: string,
          url: string,
          ...rest: any[]
        ) {
          this.__teamsUrl = url
          return (origOpen as any).call(this, method, url, ...rest)
        }
        XMLHttpRequest.prototype.send = function (this: any, ...sargs: any[]) {
          try {
            const url = this.__teamsUrl
            if (url && rosterUrlRe.test(url)) {
              this.addEventListener("load", () => {
                try {
                  if (typeof this.responseText === "string") {
                    tryHttpRoster(url, this.responseText)
                  }
                } catch {}
              })
            }
          } catch {}
          return (origSend as any).apply(this, sargs)
        }
      } catch {
        // ignore
      }
    }

    // RTCPeerConnection proxy — capture the "main-channel" data channel (dsh)
    // and audio receivers (CSRC).
    {
      const OriginalRTCPeerConnection = (window as any).RTCPeerConnection
      const attachMainChannel = (channel: any) => {
        if (channel?.label !== "main-channel") return
        diag.dataChannels++
        channel.addEventListener("message", (event: any) => handleMainChannelEvent(event))
      }
      const ProxiedRTCPeerConnection = function (this: any, ...args: any[]) {
        const pc = Reflect.construct(OriginalRTCPeerConnection, args) as RTCPeerConnection
        diag.rtcCreated++

        pc.addEventListener("datachannel", (event) => attachMainChannel(event.channel))
        pc.addEventListener("track", (event) => {
          if (event.track?.kind === "audio") addReceiver(event.receiver)
        })

        const originalCreateDataChannel = pc.createDataChannel.bind(pc)
        pc.createDataChannel = (label, options) => {
          const dataChannel = originalCreateDataChannel(label, options)
          attachMainChannel(dataChannel)
          return dataChannel
        }

        return pc
      } as any
      ProxiedRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype
      if (typeof OriginalRTCPeerConnection.generateCertificate === "function") {
        ProxiedRTCPeerConnection.generateCertificate = (...a: any[]) =>
          OriginalRTCPeerConnection.generateCertificate(...a)
      }
      ;(window as any).RTCPeerConnection = ProxiedRTCPeerConnection
    }

    // Poll loop for CSRC-based per-participant speaking.
    const pollInterval = setInterval(pollReceivers, 100)

    ;(window as any).__teamsStopNetworkInterception = () => {
      ;(window as any).__teamsNetworkInterceptorStopped = true
      try {
        clearInterval(pollInterval)
      } catch {
        // ignore
      }
    }
  } catch (error) {
    console.error("[NetworkInterceptor][Teams] ❌ Initialization error:", error)
  }
}
