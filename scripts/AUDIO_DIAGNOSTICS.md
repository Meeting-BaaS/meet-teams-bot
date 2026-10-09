# Teams audio diagnostics (opt-in canaries)

Diagnostics do not fix audio or reconstruct missing telemetry from old recordings.
They compare the stages of the next **approved in2dialog recording**. No new bot,
meeting participant, audio injection, WebSocket server, or dependency is needed.

## Enable for one bot

Add this to the normal bot-create request (also accepted when creating a scheduled bot):

```json
{
  "debug": { "AUDIO_DIAGNOSTICS": true }
}
```

Diagnostics are off when the field is omitted or false, and are currently Teams-only.
This explicitly captures extra temporary meeting audio, so use it only with the
meeting owner's approval. The root `debug` object is validated; caller-supplied
`extra` metadata cannot enable diagnostics. The flag travels with each bot request;
no worker allowlist or scheduling race is required. Existing workers need the new
image; this change does not deploy anything.

## Evidence

The worker logs the diagnostic S3 prefix. In the bot's configured **artifacts bucket**:

```text
<bot_uuid>/audio_diagnostics/<attempt>/
  manifest.json         # Native format, timestamps, actual recorder args/PIDs, trim/sync offsets, upload status
  samples.jsonl         # 1-second inbound stats/deltas, PCM/file growth, cgroup CPU, Node event-loop delays
  pulse-native.pcm      # Independent parec capture, native source format/rate/channels, no async resampler
  recorder-raw.flac     # Original recorder output before merge/trim/conversion; already async-resampled
```

The raw FLAC is retained by a hard link after FFmpeg exits, before finalization;
no extra encoder or copy runs during recording. The normal final audio/chunks
remain the third comparison point. No participant names, SDP, peer addresses or
transcript text are collected by the inbound-stats reader.

The existing Teams receiver hook supplies `getStats()` on demand, at most once
per second. Missing counters are `null`, unsupported stats are `unavailable`,
and a wedged browser read becomes `stale`/`pending_or_unavailable` without piling
up overlapping reads. Counter baselines reset when the browser/report resets.
In-process browser retries rebind the reader without restarting native capture.
Negative lost-packet corrections are preserved; they are not called zero loss.
Stats support depends on the browser and Teams' audio topology.

Native PCM and metrics stop after 2 hours. A child-only file-size limit caps PCM
at 1 GiB (whichever limit comes first: approximately 93 minutes for 48 kHz stereo
16-bit PCM, 46 minutes for float32); metrics are capped at 32 MiB and retained raw
FLAC at 1 GiB. The manifest
states missing/empty/oversize/upload-failed evidence instead of inventing data.
Audio is never buffered through Node. Sampling and capture failures do not fail
the normal recording; diagnostic uploads use the existing bounded uploader and
have **no EFS fallback**.
Uploads use the existing per-bot storage routing and retention tags. All files
share the recording's artifact prefix, so the existing delete-bot-data endpoint
also deletes diagnostic audio; they are not hidden in a separate logs bucket.

**Any recording pause permanently discards the extra captures for that bot.**
Paused speech must not be retained via an intermediate file. Diagnostics do not
restart on resume. Validate diagnostics in preprod first; then select a small
approved in2dialog canary, not all customer traffic.

## Analyze a naturally occurring defect

1. Identify an audible clipped word/click in the final recording; don't classify
   natural speech pauses or a flat FLAC file-size counter as proof of a defect.
2. Download that attempt's manifest/PCM/raw FLAC from its own artifacts bucket.
   Decode PCM using the manifest's `native_source` fields. For the usual
   `s16le`, 48 kHz, stereo source:

   ```sh
   ffmpeg -f s16le -ar 48000 -ac 2 -i pulse-native.pcm pulse-native.wav
   ```

3. Align the **same utterance** in PCM, recorder raw FLAC, and final output using
   the existing sync beep and manifest trim/padding offsets. Spawn and first-byte
   timestamps are arrival observations, not exact first-sample timestamps. The
   native source and recorder may drift; check alignment near the defect too.
4. Clean PCM / damaged raw FLAC points at the main recorder's capture/resampling
   path. Clean raw FLAC / damaged final output points at finalization. Damaged PCM
   is already upstream; loss/concealment rising at that time supports an inbound
   problem but does not prove it. If stats are inconclusive, a decoded-track PCM
   tap before browser playback is the next measurement, not part of this change.

Grafana Loki selector (replace the bot ID):

```logql
{environment="prod", bot_uuid="<canary-uuid>"} |= "[AudioDiagnostics]"
```

Local regression check (no meeting, API, PulseAudio server or S3 access):

```sh
npm test -- --runInBand src/recording/audio-diagnostics.test.ts
```
