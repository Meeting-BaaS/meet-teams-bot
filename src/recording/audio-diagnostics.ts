import { type ChildProcess, execFile, spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import { promisify } from "node:util"
import type { Page } from "@playwright/test"
import { envVars } from "../config/env-vars"
import { storageBuckets } from "../config/storage"
import { GLOBAL } from "../singleton"
import { PathManager } from "../utils/PathManager"
import { S3Uploader } from "../utils/S3Uploader"

const execFileAsync = promisify(execFile)
// ponytail: 2h / 1GiB per capture; use bounded segments for longer approved canaries.
const MAX_SECONDS = 7200
const MAX_AUDIO_BYTES = 1024 ** 3
const MAX_LOG_BYTES = 32 * 1024 ** 2
const COUNTERS = [
  "packetsReceived", "packetsLost", "bytesReceived", "concealedSamples",
  "silentConcealedSamples", "concealmentEvents", "totalSamplesReceived",
  "jitterBufferDelay", "jitterBufferEmittedCount", "insertedSamplesForDeceleration",
  "removedSamplesForAcceleration", "totalAudioEnergy", "totalSamplesDuration"
]
const FIELDS = [...COUNTERS, "jitter", "audioLevel"]

type PreviousReport = { timestamp: number; values: Record<string, number | null> }

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
    ? value : null
}

/** Whitelist browser data; missing counters and reset baselines are never reported as zero. */
export function summarizeInboundAudioStats(input: unknown, previous: Map<string, PreviousReport>) {
  const snapshot = input && typeof input === "object" ? input as Record<string, unknown> : {}
  const status = ["ok", "partial", "unavailable", "no_audio_receivers", "stopped"].includes(String(snapshot.status))
    ? String(snapshot.status) : "not_installed"
  const streams: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  const rows = Array.isArray(snapshot.streams) ? snapshot.streams.slice(0, 32) : []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const receiverId = numeric(row.receiver_id)
    const reportId = row.report_id
    const timestamp = numeric(row.timestamp_ms)
    if (!Number.isInteger(receiverId) || receiverId < 1 || typeof reportId !== "string" ||
      !/^[a-zA-Z0-9_.:-]{1,128}$/.test(reportId) || timestamp === null) continue
    const key = `${numeric(snapshot.epoch_ms)}:${receiverId}:${reportId}`
    const values: Record<string, number | null> = {}
    for (const field of FIELDS) {
      const value = numeric(row[field])
      values[field] = value !== null && (value >= 0 || field === "packetsLost") ? value : null
    }
    const last = previous.get(key)
    const reset = Boolean(last && COUNTERS.some((field) => field !== "packetsLost" &&
      values[field] !== null && last.values[field] !== null && values[field] < last.values[field]))
    const interval = last && !reset && timestamp > last.timestamp ? timestamp - last.timestamp : null
    const delta: Record<string, number | null> = {}
    for (const field of COUNTERS) {
      delta[field] = interval !== null && values[field] !== null && last.values[field] !== null
        ? values[field] - last.values[field] : null
    }
    const ratio = (n: number | null, d: number | null) => n !== null && n >= 0 && d !== null && d > 0 ? n / d : null
    streams.push({
      receiver_id: receiverId, report_id: reportId, timestamp_ms: timestamp,
      interval_ms: interval, counter_reset: reset, values, delta,
      packet_loss_ratio: ratio(delta.packetsLost,
        delta.packetsLost !== null && delta.packetsReceived !== null ? delta.packetsLost + delta.packetsReceived : null),
      concealment_ratio: ratio(delta.concealedSamples, delta.totalSamplesReceived),
      mean_jitter_buffer_delay_ms: ratio(delta.jitterBufferDelay, delta.jitterBufferEmittedCount) === null
        ? null : 1000 * ratio(delta.jitterBufferDelay, delta.jitterBufferEmittedCount)
    })
    previous.set(key, { timestamp, values })
    seen.add(key)
  }
  for (const key of previous.keys()) if (!seen.has(key)) previous.delete(key)
  return {
    status, collected_at_ms: numeric(snapshot.collected_at_ms), epoch_ms: numeric(snapshot.epoch_ms),
    errors: numeric(snapshot.errors), truncated: snapshot.truncated === true, streams
  }
}

/** pactl reports the source's real sample specification, not our assumed 48kHz mono output. */
export function parsePulseSource(sources: unknown, monitor: string) {
  const source = Array.isArray(sources) ? sources.find((item) => item?.name === monitor) : null
  const spec = typeof source?.sample_specification === "string"
    ? source.sample_specification.match(/^([a-z0-9_]+) (\d+)ch (\d+)Hz$/) : null
  const bytes: Record<string, number> = {
    u8: 1, s16le: 2, s16be: 2, s24le: 3, s24be: 3,
    s24_32le: 4, s24_32be: 4, s32le: 4, s32be: 4, float32le: 4, float32be: 4
  }
  if (!spec || !bytes[spec[1]] || Number(spec[2]) < 1 || Number(spec[2]) > 8 ||
    Number(spec[3]) < 8000 || Number(spec[3]) > 192000) {
    throw new Error("PulseAudio source has no supported native PCM specification")
  }
  return { monitor, format: spec[1], channels: Number(spec[2]), sample_rate: Number(spec[3]),
    bytes_per_frame: bytes[spec[1]] * Number(spec[2]) }
}

export class AudioDiagnostics {
  private directory = ""
  private prefix = ""
  private log: FileHandle | null = null
  private pcm: FileHandle | null = null
  private capture: ChildProcess | null = null
  private captureClosed: Promise<void> = Promise.resolve()
  private startTask: Promise<void> = Promise.resolve()
  private stopTask: Promise<void> | null = null
  private sampleTask: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly abort = new AbortController()
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 20 })
  private readonly previous = new Map<string, PreviousReport>()
  private statsPending = false
  private page: Page | null = null
  private latestStats: ReturnType<typeof summarizeInboundAudioStats> | null = null
  private stopped = false
  private discarded = false
  private logBytes = 0
  private startedMono = performance.now()
  private rawAudioPath = ""
  private metadata: Record<string, unknown> = {}
  private native: ReturnType<typeof parsePulseSource> | null = null

  public start(page: Page, recorderArgs: string[], recorderStartedAtMs: number, rawAudioPath: string, recorderPid?: number): void {
    this.setPage(page)
    this.rawAudioPath = rawAudioPath
    this.metadata = {
      schema_version: 1, bot_uuid: GLOBAL.get().bot_uuid, recording_mode: GLOBAL.get().recording_mode,
      recorder_started_at_ms: recorderStartedAtMs, recorder_args: recorderArgs,
      recorder_pid: recorderPid ?? null,
      max_seconds: MAX_SECONDS, max_audio_bytes: MAX_AUDIO_BYTES,
      alignment_note: "Spawn/arrival clocks are approximate; align native PCM and final audio using the existing sync beep."
    }
    this.startTask = this.initialize().catch((error: NodeJS.ErrnoException) => {
      this.metadata.native_status = "setup_failed"
      this.metadata.native_error = { name: error.name, code: error.code ?? null }
      console.warn("[AudioDiagnostics] native capture setup failed; normal recording continues")
    })
  }

  public setPage(page: Page): void {
    if (this.page === page) return
    this.page = page
    this.statsPending = false
    this.latestStats = null
    this.previous.clear()
  }

  private async initialize(): Promise<void> {
    this.directory = await fs.mkdtemp(path.join(PathManager.getInstance().getBasePath(), "audio-diagnostics-"))
    this.prefix = `${GLOBAL.get().bot_uuid}/audio_diagnostics/${path.basename(this.directory)}`
    this.log = await fs.open(path.join(this.directory, "samples.jsonl"), "ax", 0o600)
    if (this.stopped) return
    this.loopDelay.enable()
    this.timer = setInterval(() => {
      if (performance.now() - this.startedMono >= MAX_SECONDS * 1000) {
        void this.stop()
      } else if (!this.stopped && !this.sampleTask) {
        this.sampleTask = this.sample().catch(() => {
          console.warn("[AudioDiagnostics] sample unavailable; normal recording continues")
        }).finally(() => { this.sampleTask = null })
      }
    }, 1000)
    this.timer.unref()
    const { stdout } = await execFileAsync("pactl", ["--format=json", "list", "sources"], {
      timeout: 3000, maxBuffer: 1024 ** 2, signal: this.abort.signal,
      env: { ...process.env, LC_ALL: "C" }
    })
    this.native = parsePulseSource(JSON.parse(stdout), envVars.VIRTUAL_SPEAKER_MONITOR)
    this.metadata.native_source = this.native
    if (this.stopped) return
    this.pcm = await fs.open(path.join(this.directory, "pulse-native.pcm"), "wx", 0o600)
    if (this.stopped) return
    const args = ["--raw", `--device=${this.native.monitor}`, `--format=${this.native.format}`,
      `--rate=${this.native.sample_rate}`, `--channels=${this.native.channels}`, "--client-name=AudioDiagnostics"]
    this.metadata.native_started_at_ms = Date.now()
    // Direct fd: no Node PCM processing/backpressure. RLIMIT_FSIZE applies only to this child.
    const capture = spawn("bash", ["-c", `ulimit -c 0 && ulimit -f ${MAX_AUDIO_BYTES / 1024} && exec parec "$@"`,
      "audio-diagnostics", ...args], {
      stdio: ["ignore", this.pcm.fd, "ignore"], timeout: MAX_SECONDS * 1000, killSignal: "SIGTERM"
    })
    this.capture = capture
    this.metadata.native_pid = capture.pid ?? null
    this.metadata.native_status = "capturing"
    this.captureClosed = new Promise<void>((resolve) => {
      capture.once("error", () => {
        this.metadata.native_status = "spawn_failed"
        resolve()
      })
      capture.once("close", (code, signal) => {
        this.metadata.native_exit = { code, signal, at_ms: Date.now() }
        this.metadata.native_status = signal === "SIGXFSZ" ? "size_limit" : code !== 0 && !signal ? "capture_failed" : "stopped"
        if (this.capture === capture) this.capture = null
        resolve()
      })
    })
    console.log(`[AudioDiagnostics] enabled; native source=${this.native.monitor}; prefix=${this.prefix}`)
  }

  private pollStats(): void {
    const page = this.page
    if (!page || this.statsPending || this.stopped) return
    this.statsPending = true
    void page.evaluate(async () => {
      const reader = (window as Window & { __teamsReadAudioStats?: () => Promise<unknown> }).__teamsReadAudioStats
      return reader ? await reader() : null
    }).then((snapshot) => {
      if (!this.stopped && this.page === page) this.latestStats = summarizeInboundAudioStats(snapshot, this.previous)
    }).catch(() => {
      if (!this.stopped && this.page === page) this.latestStats = null
    }).finally(() => { if (this.page === page) this.statsPending = false })
  }

  private async fileBytes(file: string): Promise<number | null> {
    try { return (await fs.stat(file)).size } catch { return null }
  }

  private async sample(): Promise<void> {
    this.pollStats()
    const [pulseBytes, recorderBytes, cpuText] = await Promise.all([
      this.fileBytes(path.join(this.directory, "pulse-native.pcm")), this.fileBytes(this.rawAudioPath),
      fs.readFile("/sys/fs/cgroup/cpu.stat", "utf8").catch(() => null)
    ])
    if (this.stopped) return
    const cpu: Record<string, number> = {}
    for (const line of cpuText?.split("\n") ?? []) {
      const [key, value] = line.trim().split(/\s+/)
      if (["usage_usec", "user_usec", "system_usec", "nr_periods", "nr_throttled", "throttled_usec"].includes(key) && numeric(Number(value)) !== null) {
        cpu[key] = Number(value)
      }
    }
    const now = Date.now()
    if (pulseBytes && !this.metadata.native_first_bytes_seen_at_ms) {
      this.metadata.native_first_bytes_seen_at_ms = now
    }
    const age = this.latestStats?.collected_at_ms != null ? now - this.latestStats.collected_at_ms : null
    const sample = {
      event: "audio_diagnostics", at_ms: now, elapsed_ms: performance.now() - this.startedMono,
      inbound: this.latestStats, inbound_age_ms: age,
      inbound_status: age !== null && age > 3000 ? "stale" : this.latestStats?.status ?? "pending_or_unavailable",
      pulse_bytes: pulseBytes, pulse_frames: pulseBytes !== null && this.native ? Math.floor(pulseBytes / this.native.bytes_per_frame) : null,
      recorder_bytes: recorderBytes, native_status: this.metadata.native_status ?? "initializing",
      cgroup_cpu: cpuText === null ? null : cpu,
      node_event_loop_max_ms: numeric(this.loopDelay.max / 1e6),
      node_event_loop_p99_ms: numeric(this.loopDelay.percentile(99) / 1e6)
    }
    this.loopDelay.reset()
    const line = `${JSON.stringify(sample)}\n`
    if (this.logBytes + Buffer.byteLength(line) > MAX_LOG_BYTES) {
      this.metadata.log_status = "size_limit"
      return
    }
    this.logBytes += Buffer.byteLength(line)
    await this.log?.appendFile(line)
    console.log(`[AudioDiagnostics] ${line.trim()}`)
  }

  public setAlignment(values: Record<string, unknown>): void {
    this.metadata.alignment = values
  }

  public stop(): Promise<void> {
    if (this.stopTask) return this.stopTask
    this.stopped = true
    this.abort.abort()
    if (this.timer) clearInterval(this.timer)
    this.loopDelay.disable()
    this.metadata.stopped_at_ms = Date.now()
    this.stopTask = (async () => {
      await this.startTask
      try {
        const capture = this.capture
        if (capture) {
          capture.kill("SIGTERM")
          const force = setTimeout(() => { capture.kill("SIGKILL") }, 2000)
          let deadline: NodeJS.Timeout | null = null
          try {
            await Promise.race([this.captureClosed, new Promise<void>((resolve) => {
              deadline = setTimeout(() => { this.metadata.native_status = "stop_timeout"; resolve() }, 5000)
            })])
          } finally { clearTimeout(force); if (deadline) clearTimeout(deadline) }
        }
      } finally {
        await this.sampleTask
        await Promise.allSettled([this.log?.close(), this.pcm?.close()])
        this.log = null
        this.pcm = null
      }
    })().catch(() => { console.warn("[AudioDiagnostics] cleanup failed; normal recording continues") })
    return this.stopTask
  }

  public async discard(): Promise<void> {
    // ponytail: any recording pause discards the entire canary; add pause-aware segments if needed.
    this.discarded = true
    await this.stop()
    if (!this.directory) return
    await Promise.allSettled(["pulse-native.pcm", "samples.jsonl"].map((file) => fs.unlink(path.join(this.directory, file))))
  }

  public async finish(): Promise<void> {
    await this.stop()
    if (!this.directory || this.discarded) return
    try {
      const uploader = S3Uploader.getInstance()
      const files = [
        { name: "pulse-native.pcm", path: path.join(this.directory, "pulse-native.pcm"), max: MAX_AUDIO_BYTES },
        { name: "samples.jsonl", path: path.join(this.directory, "samples.jsonl"), max: MAX_LOG_BYTES }
      ]
      const results = await Promise.all(files.map(async (file) => {
        const bytes = await this.fileBytes(file.path)
        const key = `${this.prefix}/${file.name}`
        if (file.name === "pulse-native.pcm" && this.capture) return { name: file.name, bytes, key, status: "capture_not_stopped" }
        if (bytes === null || bytes === 0 || bytes > file.max) return { name: file.name, bytes, key, status: "missing_empty_or_oversize" }
        if (!uploader) return { name: file.name, bytes, key, status: "local_only" }
        try {
          await uploader.uploadFile(file.path, storageBuckets().artifacts, key, { audio_diagnostics: "true" },
            { skipEfsFallback: true })
          return { name: file.name, bytes, key, status: "uploaded" }
        } catch {
          return { name: file.name, bytes, key, status: "upload_failed" }
        }
      }))
      const manifest = path.join(this.directory, "manifest.json")
      await fs.writeFile(manifest, JSON.stringify({ ...this.metadata, files: results }, null, 2), { mode: 0o600 })
      if (uploader) await uploader.uploadFile(manifest, storageBuckets().artifacts, `${this.prefix}/manifest.json`,
        { audio_diagnostics: "true" }, { skipEfsFallback: true })
      console.log(`[AudioDiagnostics] finalized prefix=${this.prefix}; ${JSON.stringify(results)}`)
    } catch {
      console.warn("[AudioDiagnostics] artifacts unavailable; normal recording continues")
    }
  }
}
