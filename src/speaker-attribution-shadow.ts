import { createHmac, randomBytes } from "node:crypto"

type ShadowSpeaker = {
  deviceId?: string
  name?: string
  isSpeaking: boolean
}

type CandidateEvidence = {
  samples: number
  ambiguousSamples: number
  firstAtMs: number | null
  lastAtMs: number | null
  identities: Set<string>
  sources: Set<string>
}

type PendingDevice = {
  token: string
  firstUnresolvedAtMs: number
  lastUnresolvedAtMs: number
  dcrpcCallbacks: number
  dcrpcSpeakingCallbacks: number
  network: CandidateEvidence
  ui: CandidateEvidence
}

type ShadowEvent = Record<string, unknown>

type ShadowTrackerOptions = {
  salt?: Uint8Array
  logger?: (event: ShadowEvent) => void
}

const KNOWN_SOURCES = new Set([
  "network:audio",
  "network:dcrpc",
  "network:health_check",
  "network:roster",
  "network:unknown",
  "ui-observer"
])

function candidateEvidence(): CandidateEvidence {
  return {
    samples: 0,
    ambiguousSamples: 0,
    firstAtMs: null,
    lastAtMs: null,
    identities: new Set(),
    sources: new Set()
  }
}

/**
 * Shadow-only evidence for deciding whether unresolved dcrpc speech can safely
 * wait for CSRC, roster, or UI identity. It never changes live attribution.
 *
 * Raw device ids and names stay in memory. Logs contain only per-process HMAC
 * tokens, so events can be correlated within one meeting but not across bots.
 */
export class SpeakerAttributionShadowTracker {
  private readonly salt: Uint8Array
  private readonly logger: (event: ShadowEvent) => void
  private readonly pending = new Map<string, PendingDevice>()
  private createdDevices = 0
  private resolvedDevices = 0
  private finalized = false
  private readonly resolverSources = new Map<string, number>()

  public constructor(options: ShadowTrackerOptions = {}) {
    this.salt = options.salt ?? randomBytes(32)
    this.logger =
      options.logger ?? ((event) => console.log(`[SPEAKER-SHADOW] ${JSON.stringify(event)}`))
  }

  public observeNetwork(speakers: ShadowSpeaker[], timestamp: number, source: string): void {
    if (this.finalized) return

    const atMs = this.validTimestamp(timestamp)
    const safeSource = this.safeSource(source)

    // First update exact-device state. A roster/CSRC callback can resolve a
    // device even when it is not speaking anymore.
    for (const speaker of speakers) {
      const deviceId = speaker.deviceId?.trim()
      if (!deviceId) continue

      const name = this.resolvedName(speaker.name)
      if (name) {
        this.resolvePendingDevice(deviceId, name, atMs, safeSource)
        continue
      }

      if (safeSource !== "network:dcrpc") continue
      const existing = this.pending.get(deviceId)
      if (!speaker.isSpeaking && !existing) continue

      const pending = existing ?? this.createPendingDevice(deviceId, atMs)
      pending.lastUnresolvedAtMs = atMs
      pending.dcrpcCallbacks += 1
      if (speaker.isSpeaking) pending.dcrpcSpeakingCallbacks += 1
    }

    // A resolved CSRC/roster speaker on a different device is useful candidate
    // evidence, but safe only with one pending device and one active identity.
    if (safeSource !== "network:dcrpc") {
      const activeNames = speakers
        .filter((speaker) => speaker.isSpeaking)
        .map((speaker) => this.resolvedName(speaker.name))
        .filter((name): name is string => Boolean(name))
      this.recordCandidates("network", activeNames, safeSource, atMs)
    }
  }

  /** Record UI evidence even while current arbitration mutes UI attribution. */
  public observeUi(speakers: ShadowSpeaker[], timestamp: number): void {
    if (this.finalized) return

    const activeNames = speakers
      .filter((speaker) => speaker.isSpeaking)
      .map((speaker) => this.resolvedName(speaker.name))
      .filter((name): name is string => Boolean(name))
    this.recordCandidates("ui", activeNames, "ui-observer", this.validTimestamp(timestamp))
  }

  public finalize(timestamp: number): void {
    if (this.finalized) return
    this.finalized = true
    const atMs = this.validTimestamp(timestamp)

    for (const pending of this.pending.values()) {
      this.emit({
        schema_version: 1,
        event: "unresolved_final",
        device: pending.token,
        first_unresolved_at_ms: pending.firstUnresolvedAtMs,
        last_unresolved_at_ms: pending.lastUnresolvedAtMs,
        pending_age_ms: Math.max(0, atMs - pending.firstUnresolvedAtMs),
        dcrpc_callbacks: pending.dcrpcCallbacks,
        dcrpc_speaking_callbacks: pending.dcrpcSpeakingCallbacks,
        network_candidate: this.summarizeEvidence(
          pending.network,
          pending.firstUnresolvedAtMs
        ),
        ui_candidate: this.summarizeEvidence(pending.ui, pending.firstUnresolvedAtMs)
      })
    }

    this.emit({
      schema_version: 1,
      event: "summary",
      unresolved_dcrpc_devices: this.createdDevices,
      exact_device_resolutions: this.resolvedDevices,
      unresolved_final: this.pending.size,
      resolver_sources: Object.fromEntries(this.resolverSources)
    })
  }

  private createPendingDevice(deviceId: string, atMs: number): PendingDevice {
    const pending: PendingDevice = {
      token: this.token("device", deviceId),
      firstUnresolvedAtMs: atMs,
      lastUnresolvedAtMs: atMs,
      dcrpcCallbacks: 0,
      dcrpcSpeakingCallbacks: 0,
      network: candidateEvidence(),
      ui: candidateEvidence()
    }
    this.pending.set(deviceId, pending)
    this.createdDevices += 1
    return pending
  }

  private resolvePendingDevice(deviceId: string, name: string, atMs: number, source: string): void {
    const pending = this.pending.get(deviceId)
    if (!pending) return

    const identity = this.token("identity", this.normalizeName(name))
    this.pending.delete(deviceId)
    this.resolvedDevices += 1
    this.resolverSources.set(source, (this.resolverSources.get(source) ?? 0) + 1)

    this.emit({
      schema_version: 1,
      event: "resolved_exact_device",
      device: pending.token,
      identity,
      resolver_source: source,
      first_unresolved_at_ms: pending.firstUnresolvedAtMs,
      resolved_at_ms: atMs,
      resolution_delay_ms: Math.max(0, atMs - pending.firstUnresolvedAtMs),
      dcrpc_callbacks: pending.dcrpcCallbacks,
      dcrpc_speaking_callbacks: pending.dcrpcSpeakingCallbacks,
      network_candidate: this.summarizeEvidence(
        pending.network,
        pending.firstUnresolvedAtMs,
        identity
      ),
      ui_candidate: this.summarizeEvidence(pending.ui, pending.firstUnresolvedAtMs, identity)
    })
  }

  private recordCandidates(
    kind: "network" | "ui",
    names: string[],
    source: string,
    atMs: number
  ): void {
    if (this.pending.size === 0 || names.length === 0) return

    const identities = new Set(
      names.map((name) => this.token("identity", this.normalizeName(name)))
    )
    if (this.pending.size === 1 && identities.size === 1) {
      const pending = this.pending.values().next().value as PendingDevice
      const evidence = pending[kind]
      evidence.samples += 1
      evidence.firstAtMs ??= atMs
      evidence.lastAtMs = atMs
      evidence.identities.add(identities.values().next().value as string)
      evidence.sources.add(source)
      return
    }

    for (const pending of this.pending.values()) {
      pending[kind].ambiguousSamples += 1
    }
  }

  private summarizeEvidence(
    evidence: CandidateEvidence,
    pendingAtMs: number,
    resolvedIdentity?: string
  ) {
    const singleIdentity =
      evidence.identities.size === 1 ? evidence.identities.values().next().value : null
    return {
      samples: evidence.samples,
      ambiguous_samples: evidence.ambiguousSamples,
      distinct_identities: evidence.identities.size,
      identity: singleIdentity,
      first_delay_ms:
        evidence.firstAtMs === null ? null : Math.max(0, evidence.firstAtMs - pendingAtMs),
      last_delay_ms:
        evidence.lastAtMs === null ? null : Math.max(0, evidence.lastAtMs - pendingAtMs),
      sources: [...evidence.sources].sort(),
      matches_resolved:
        resolvedIdentity && singleIdentity ? singleIdentity === resolvedIdentity : null
    }
  }

  private resolvedName(name: string | undefined): string | null {
    const normalized = name?.trim()
    if (!normalized || normalized.toLocaleLowerCase() === "unknown") return null
    return normalized
  }

  private normalizeName(name: string): string {
    return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase()
  }

  private safeSource(source: string): string {
    return KNOWN_SOURCES.has(source) ? source : "network:unknown"
  }

  private validTimestamp(timestamp: number): number {
    return Number.isFinite(timestamp) && timestamp > 0 ? Math.round(timestamp) : Date.now()
  }

  private token(kind: "device" | "identity", value: string): string {
    const digest = createHmac("sha256", this.salt)
      .update(`${kind}\0${value}`)
      .digest("hex")
      .slice(0, 12)
    return `${kind === "device" ? "dev" : "spk"}_${digest}`
  }

  private emit(event: ShadowEvent): void {
    try {
      this.logger(event)
    } catch {
      // Diagnostic-only path must never affect recording or finalization.
      console.error("[SPEAKER-SHADOW] telemetry_error")
    }
  }
}
