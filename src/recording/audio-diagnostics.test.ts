import { EventEmitter } from "node:events"
import { promises as fs, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Page } from "@playwright/test"
import { audioDiagnosticsEnabled } from "../config/audio-diagnostics"
import { readTeamsInboundAudioStats } from "../meeting/teams/network-interception/browser-bundle"
import { AudioDiagnostics, parsePulseSource, summarizeInboundAudioStats } from "./audio-diagnostics"

const UUID = "d7425aa6-eebd-4b0f-a24f-0504cfbe03c8"
const mockRoot = { path: "" }
const mockSpawn = jest.fn()
const mockExec = jest.fn()
const mockUpload = jest.fn().mockResolvedValue(undefined)

jest.mock("node:child_process", () => {
  const { promisify } = jest.requireActual("node:util")
  const execFile = jest.fn()
  execFile[promisify.custom] = (...args: unknown[]) => mockExec(...args)
  return { execFile, spawn: (...args: unknown[]) => mockSpawn(...args) }
})
jest.mock("../singleton", () => ({ GLOBAL: {
  get: () => ({ bot_uuid: "d7425aa6-eebd-4b0f-a24f-0504cfbe03c8", recording_mode: "audio_only", data_retention_days: 1 }),
  isServerless: () => false
} }))
jest.mock("../utils/PathManager", () => ({ PathManager: {
  getInstance: () => ({ getBasePath: () => mockRoot.path })
} }))
jest.mock("../utils/S3Uploader", () => ({ S3Uploader: {
  getInstance: () => ({ uploadFile: mockUpload })
} }))
jest.mock("../config/storage", () => ({
  storageBuckets: () => ({ logs: "customer-logs", artifacts: "customer-artifacts" }),
  storageS3Client: () => ({}),
  transientSpillAllowed: () => false
}))
beforeEach(async () => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask", "performance", "hrtime"] })
  jest.spyOn(console, "log").mockImplementation(() => {})
  jest.spyOn(console, "warn").mockImplementation(() => {})
  mockRoot.path = await fs.mkdtemp(path.join(tmpdir(), "audio-diagnostics-test-"))
  mockExec.mockResolvedValue({ stdout: JSON.stringify([
    { name: "virtual_speaker.monitor", sample_specification: "s16le 2ch 48000Hz" }
  ]) })
  mockSpawn.mockImplementation((_command, _args, options) => {
    writeSync(options.stdio[1], Buffer.alloc(9600))
    const child = new EventEmitter() as EventEmitter & { pid: number; kill: jest.Mock }
    child.pid = 1234
    child.kill = jest.fn((signal) => {
      queueMicrotask(() => child.emit("close", 0, signal))
      return true
    })
    return child
  })
})

afterEach(async () => {
  jest.useRealTimers()
  jest.restoreAllMocks()
  mockExec.mockReset()
  mockSpawn.mockReset()
  mockUpload.mockClear()
  await fs.rm(mockRoot.path, { recursive: true, force: true })
})

it("requires an explicit per-bot Teams request", () => {
  expect(audioDiagnosticsEnabled("teams", null)).toBe(false)
  expect(audioDiagnosticsEnabled("teams", {})).toBe(false)
  expect(audioDiagnosticsEnabled("teams", { __meeting_baas_debug: { AUDIO_DIAGNOSTICS: false } })).toBe(false)
  expect(audioDiagnosticsEnabled("meet", { __meeting_baas_debug: { AUDIO_DIAGNOSTICS: true } })).toBe(false)
  expect(audioDiagnosticsEnabled("teams", { __meeting_baas_debug: { AUDIO_DIAGNOSTICS: true } })).toBe(true)
})

it("runs the stringified browser reader and preserves missing fields, deltas, resets and corrections", async () => {
  const reader = new Function(`return (${readTeamsInboundAudioStats.toString()})`)() as typeof readTeamsInboundAudioStats
  const report = { id: "inbound-1", type: "inbound-rtp", kind: "audio", timestamp: 1000,
    packetsReceived: 100, packetsLost: 0, concealedSamples: 0, totalSamplesReceived: 48000,
    jitterBufferDelay: 1, jitterBufferEmittedCount: 100, remoteAddress: "must-not-persist" }
  const receiver = { track: { readyState: "live" }, getStats: async () => new Map([
    ["audio", report], ["video", { ...report, id: "video", kind: "video" }]
  ]) } as unknown as RTCRtpReceiver
  const history = new Map()
  const read = async () => ({ epoch_ms: 10, ...await reader([{ id: 1, receiver }]) })
  const first = summarizeInboundAudioStats(await read(), history).streams[0]
  expect(first.packet_loss_ratio).toBeNull()
  expect((first.values as Record<string, unknown>).jitter).toBeNull()
  expect(JSON.stringify(first)).not.toContain("must-not-persist")

  Object.assign(report, { timestamp: 2000, packetsReceived: 196, packetsLost: 4,
    concealedSamples: 480, totalSamplesReceived: 96000, jitterBufferDelay: 3, jitterBufferEmittedCount: 200 })
  const next = summarizeInboundAudioStats(await read(), history).streams[0]
  expect(next).toMatchObject({ interval_ms: 1000, packet_loss_ratio: 0.04, concealment_ratio: 0.01, mean_jitter_buffer_delay_ms: 20 })
  Object.assign(report, { timestamp: 3000, packetsReceived: 200, packetsLost: 3 })
  const correction = summarizeInboundAudioStats(await read(), history).streams[0]
  expect((correction.delta as Record<string, unknown>).packetsLost).toBe(-1)
  expect(correction.packet_loss_ratio).toBeNull()
  Object.assign(report, { timestamp: 4000, packetsReceived: 1 })
  const reset = summarizeInboundAudioStats(await read(), history).streams[0]
  expect(reset).toMatchObject({ counter_reset: true, interval_ms: null, packet_loss_ratio: null })
  expect(summarizeInboundAudioStats(null, history)).toMatchObject({ status: "not_installed", streams: [] })
  expect(history.size).toBe(0)
  expect(await reader([])).toMatchObject({ status: "no_audio_receivers", streams: [] })
  const unsupported = { track: { readyState: "live" }, getStats: async () => { throw new Error("unsupported") } }
  expect(await reader([{ id: 1, receiver: unsupported as unknown as RTCRtpReceiver }])).toMatchObject({ status: "unavailable", errors: 1 })
})

it("rejects invalid native specs instead of silently resampling", () => {
  expect(parsePulseSource([{ name: "sink", sample_specification: "float32le 2ch 48000Hz" }], "sink")).toMatchObject({ format: "float32le", bytes_per_frame: 8 })
  for (const sample_specification of ["s16le 0ch 48000Hz", "s16le 2ch 0Hz", "mulaw 2ch 48000Hz"]) {
    expect(() => parsePulseSource([{ name: "sink", sample_specification }], "sink")).toThrow()
  }
})

it("captures through a bounded native fd, retains raw audio, uploads to owner storage and stops polling", async () => {
  const raw = path.join(mockRoot.path, "raw.flac")
  await fs.writeFile(raw, "raw-before-finalization")
  const page = { evaluate: jest.fn().mockResolvedValue(null) } as unknown as Page
  const diagnostics = new AudioDiagnostics()
  diagnostics.start(page, ["-af", "aresample=async=1000:first_pts=0"], Date.now(), raw, 5678)
  await (diagnostics as unknown as { startTask: Promise<void> }).startTask
  expect(mockSpawn).toHaveBeenCalledWith("bash", expect.arrayContaining([
    "--format=s16le", "--rate=48000", "--channels=2"
  ]), expect.objectContaining({ timeout: 7200000, stdio: ["ignore", expect.any(Number), "ignore"] }))
  expect(mockSpawn.mock.calls[0][1][1]).toContain("ulimit -f 1048576")
  jest.advanceTimersByTime(1000)
  await (diagnostics as unknown as { sampleTask: Promise<void> }).sampleTask
  await diagnostics.retainRecorderAudio(raw)
  await fs.unlink(raw)
  diagnostics.setAlignment({ start_trim_seconds: 3, audio_padding_seconds: 0 })
  await diagnostics.finish()
  const directory = path.join(mockRoot.path, (await fs.readdir(mockRoot.path))[0])
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"))
  expect(manifest).toMatchObject({ recorder_pid: 5678, recorder_raw_status: "retained", alignment: { start_trim_seconds: 3 } })
  expect(manifest.files.every((file: { status: string }) => file.status === "uploaded")).toBe(true)
  expect(await fs.readFile(path.join(directory, "recorder-raw.flac"), "utf8")).toBe("raw-before-finalization")
  expect((await fs.stat(path.join(directory, "pulse-native.pcm"))).mode & 0o777).toBe(0o600)
  expect(mockUpload).toHaveBeenCalledTimes(4)
  for (const [, bucket, key, tags, options] of mockUpload.mock.calls) {
    expect(bucket).toBe("customer-artifacts")
    expect(key).toMatch(new RegExp(`^${UUID}/audio_diagnostics/`))
    expect(tags).toEqual({ audio_diagnostics: "true" })
    expect(options).toMatchObject({ skipEfsFallback: true })
  }
  const reads = (page.evaluate as jest.Mock).mock.calls.length
  jest.advanceTimersByTime(5000)
  expect((page.evaluate as jest.Mock).mock.calls.length).toBe(reads)
})

it("permanently discards diagnostic audio on pause and survives missing native capture", async () => {
  const raw = path.join(mockRoot.path, "raw.flac")
  await fs.writeFile(raw, "contains-paused-speech")
  const diagnostics = new AudioDiagnostics()
  diagnostics.start({ evaluate: jest.fn().mockResolvedValue(null) } as unknown as Page, [], Date.now(), raw)
  await (diagnostics as unknown as { startTask: Promise<void> }).startTask
  await diagnostics.discard()
  await diagnostics.stop()
  await diagnostics.retainRecorderAudio(raw)
  await diagnostics.finish()
  expect(mockUpload).not.toHaveBeenCalled()
  const discardedName = (await fs.readdir(mockRoot.path)).find((name) => name.startsWith("audio-diagnostics-"))
  if (!discardedName) throw new Error("Diagnostic directory missing")
  const discardedDir = path.join(mockRoot.path, discardedName)
  expect(await fs.readdir(discardedDir)).toEqual([])
  expect(await fs.readFile(raw, "utf8")).toBe("contains-paused-speech")

  mockExec.mockRejectedValueOnce(Object.assign(new Error("pactl missing"), { code: "ENOENT" }))
  const failed = new AudioDiagnostics()
  failed.start({ evaluate: jest.fn() } as unknown as Page, [], Date.now(), raw)
  await failed.retainRecorderAudio(raw)
  await expect(failed.finish()).resolves.toBeUndefined()
  expect(mockSpawn).toHaveBeenCalledTimes(1)
})

it("does not pile up hung stats reads and rebinds after an in-process browser retry", async () => {
  let releaseOld: (value: unknown) => void = () => {}
  const oldPage = { evaluate: jest.fn().mockReturnValue(new Promise((resolve) => { releaseOld = resolve })) }
  const newPage = { evaluate: jest.fn().mockResolvedValue({ status: "no_audio_receivers", streams: [], collected_at_ms: Date.now() }) }
  const diagnostics = new AudioDiagnostics()
  diagnostics.start(oldPage as unknown as Page, [], Date.now(), path.join(mockRoot.path, "raw.flac"))
  await (diagnostics as unknown as { startTask: Promise<void> }).startTask
  for (let second = 0; second < 3; second++) {
    jest.advanceTimersByTime(1000)
    await (diagnostics as unknown as { sampleTask: Promise<void> }).sampleTask
  }
  expect(oldPage.evaluate).toHaveBeenCalledTimes(1)
  diagnostics.setPage(newPage as unknown as Page)
  jest.advanceTimersByTime(1000)
  await (diagnostics as unknown as { sampleTask: Promise<void> }).sampleTask
  expect(newPage.evaluate).toHaveBeenCalledTimes(1)
  releaseOld({ status: "unavailable", streams: [] })
  await Promise.resolve()
  expect((diagnostics as unknown as { latestStats: { status: string } }).latestStats.status).toBe("no_audio_receivers")
  await diagnostics.stop()
})

it("can stop during setup without launching a capture and refuses an oversized raw artifact", async () => {
  const diagnostics = new AudioDiagnostics()
  diagnostics.start({ evaluate: jest.fn() } as unknown as Page, [], Date.now(), "missing")
  await diagnostics.stop()
  expect(mockSpawn).not.toHaveBeenCalled()
  expect(mockExec).not.toHaveBeenCalled()
  const raw = path.join(mockRoot.path, "oversize.flac")
  await fs.writeFile(raw, "")
  await fs.truncate(raw, 1024 ** 3 + 1) // Sparse file: checks the bound without allocating 1GiB.
  await diagnostics.retainRecorderAudio(raw)
  await diagnostics.finish()
  expect(mockUpload.mock.calls.some((call) => String(call[2]).endsWith("recorder-raw.flac"))).toBe(false)
})
