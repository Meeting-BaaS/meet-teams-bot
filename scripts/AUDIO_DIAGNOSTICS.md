# Teams audio diagnostics (opt-in canaries)

Diagnostics do not fix audio or reconstruct missing telemetry from old recordings.
They compare the stages of the next **approved in2dialog recording**. No new bot,
meeting participant, audio injection, WebSocket server, or dependency is needed.

## Enable for a team

Diagnostics are controlled by `AUDIO_DIAGNOSTICS_TEAM_IDS`, a comma-separated
list of team IDs set on the API server and job runners. Production sets it to
`3447` for the in2dialog team; empty/unset means off. No request change is needed.
The API adds an internal marker only to Teams bot messages from listed teams,
across immediate, batch, scheduled, and calendar bots.

Only the API can add the marker; caller-supplied `extra` metadata cannot enable
capture. This stores an additional bounded temporary copy of meeting audio, so
team-level enablement requires approval for every affected meeting. The API
allowlist and worker changes must both be deployed; these PRs do not deploy
anything.

## Evidence

The worker logs the diagnostic S3 prefix. In the bot's configured **artifacts bucket**:

```text
<bot_uuid>/audio_diagnostics/<attempt>/
  manifest.json         # Native format, timestamps, actual recorder args/PIDs, trim/sync offsets, upload status
  samples.jsonl         # 1-second inbound stats/deltas, PCM/file growth, cgroup CPU, Node event-loop delays
  pulse-native.pcm      # Independent parec capture, native source format/rate/channels, no async resampler
```

The recorder's temporary raw FLAC is not retained in the diagnostics directory
or uploaded. The normal recording pipeline still uses it for finalization; the
final audio/chunks are the comparison point downstream of the independent PCM
capture. No participant names, SDP, peer addresses or transcript text are
collected by the inbound-stats reader.

The existing Teams receiver hook supplies `getStats()` on demand, at most once
per second. Missing counters are `null`, unsupported stats are `unavailable`,
and a wedged browser read becomes `stale`/`pending_or_unavailable` without piling
up overlapping reads. Counter baselines reset when the browser/report resets.
In-process browser retries rebind the reader without restarting native capture.
Negative lost-packet corrections are preserved; they are not called zero loss.
Stats support depends on the browser and Teams' audio topology.

Native PCM and metrics stop after 2 hours. A child-only file-size limit caps PCM
at 1 GiB (whichever limit comes first: approximately 93 minutes for 48 kHz stereo
16-bit PCM, 46 minutes for float32); `samples.jsonl` is capped at 32 MiB. The
manifest states missing/empty/oversize/upload-failed evidence instead of
inventing data.
Audio is never buffered through Node. Sampling and capture failures do not fail
the normal recording; diagnostic uploads use the existing bounded uploader and
have **no EFS fallback**.
Uploads use the existing per-bot storage routing and retention tags. All files
share the recording's artifact prefix, so the existing delete-bot-data endpoint
also deletes diagnostic audio; they are not hidden in a separate logs bucket.

**Any recording pause permanently discards the extra captures for that bot.**
Paused speech must not be retained via an intermediate file. Diagnostics do not
restart on resume. Validate in preprod first, then enable only after the team
has approved capture for all of its Teams meetings.

## Analyze a naturally occurring defect

1. Identify an audible clipped word/click in the final recording; don't classify
   natural speech pauses or a flat FLAC file-size counter as proof of a defect.
2. Download that attempt's manifest and PCM from its own artifacts bucket.
   Decode PCM using the manifest's `native_source` fields. For the usual
   `s16le`, 48 kHz, stereo source:

   ```sh
   ffmpeg -f s16le -ar 48000 -ac 2 -i pulse-native.pcm pulse-native.wav
   ```

3. Align the **same utterance** in native PCM and final output using the existing
   sync beep and manifest trim/padding offsets. Spawn and first-byte timestamps
   are arrival observations, not exact first-sample timestamps. Check alignment
   near the defect too.
4. Clean PCM / damaged final output points downstream of the Pulse capture, but
   cannot distinguish the recorder from finalization. Damaged PCM is already
   upstream; loss/concealment rising at that time supports an inbound problem
   but does not prove it. If stats are inconclusive, a decoded-track PCM tap
   before browser playback is the next measurement, not part of this change.

Grafana Loki selector (replace the bot ID):

```logql
{environment="prod", bot_uuid="<canary-uuid>"} |= "[AudioDiagnostics]"
```

Local regression check (no meeting, API, PulseAudio server or S3 access):

```sh
npm test -- --runInBand src/recording/audio-diagnostics.test.ts
```
